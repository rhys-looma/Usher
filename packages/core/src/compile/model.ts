// Chat clients for OpenAI-compatible model APIs, using fetch (LU-19, LU-30): the Meta Model API
// (Muse Spark) and Baseten (Muse Spark Open). The compiler and the agent take any ChatFn, so the
// model is swappable.
//
// API keys are read from the environment (MODEL_API_KEY, BASETEN_API_KEY) and never logged or stored.

export const API_URL = 'https://api.meta.ai/v1/chat/completions';
export const DEFAULT_MODEL = 'muse-spark-1.3';
/**
 * Muse Spark Open on Baseten, by the id the hackathon says to use (not the docs' plain
 * meta-models/muse-spark-open). On 26 Oct 2026 Baseten answered 404 for it on an account without
 * hackathon credits yet; USHER_OPEN_MODEL=meta-models/muse-spark-open works meanwhile.
 */
export const OPEN_MODEL = 'meta-models/muse-spark-open-1026';
export const OPEN_MODEL_PUBLIC = 'meta-models/muse-spark-open';

export interface Provider {
  name: 'meta' | 'baseten';
  url: string;
  keyEnv: string;
  defaultModel: string;
  /** Supports response_format json_schema. Without it the schema goes in the prompt instead. */
  structuredOutput: boolean;
}

export const PROVIDERS: Record<Provider['name'], Provider> = {
  meta: { name: 'meta', url: API_URL, keyEnv: 'MODEL_API_KEY', defaultModel: DEFAULT_MODEL, structuredOutput: true },
  // Baseten's docs: every Model API supports structured outputs except Muse Spark Open, which
  // offers JSON mode. So the schema goes in the prompt and JSON mode is asked for.
  baseten: { name: 'baseten', url: 'https://inference.baseten.co/v1/chat/completions', keyEnv: 'BASETEN_API_KEY', defaultModel: OPEN_MODEL, structuredOutput: false },
};

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface ChatRequest {
  model: string;
  temperature: number;
  messages: ChatMessage[];
  response_format: { type: 'json_schema'; json_schema: { name: string; strict: true; schema: Record<string, unknown> } };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
}

export interface ChatResult {
  content: string;
  usage: Usage;
  latency_ms: number;
  /** The response body as returned, for the compiler log. */
  response: unknown;
}

/** Sends a chat request. The compiler only needs this one function, so tests can replace it. */
export type ChatFn = (request: ChatRequest) => Promise<ChatResult>;

// USD per million tokens, from the Meta Model API pricing page (standard mode).
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'muse-spark-1.3': { input: 1.25, cached: 0.15, output: 4.25 },
  'muse-spark-1.2': { input: 1.25, cached: 0.15, output: 4.25 },
  'muse-spark-1.1': { input: 1.25, cached: 0.15, output: 4.25 },
  // From Baseten's /v1/models listing for Muse Spark Open.
  [OPEN_MODEL]: { input: 1.25, cached: 0.15, output: 4.25 },
  [OPEN_MODEL_PUBLIC]: { input: 1.25, cached: 0.15, output: 4.25 },
};

/** Cost in USD, or null for a model without a known price. */
export function costUsd(model: string, usage: Usage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const fresh = usage.prompt_tokens - usage.cached_tokens;
  return (fresh * price.input + usage.cached_tokens * price.cached + usage.completion_tokens * price.output) / 1e6;
}

/** The model to use: USHER_COMPILER_MODEL or muse-spark-1.3. Refuses -contributor variants. */
export function compilerModel(env: NodeJS.ProcessEnv = process.env): string {
  return checkedModel(env.USHER_COMPILER_MODEL?.trim() || DEFAULT_MODEL);
}

/** The open-weights model: USHER_OPEN_MODEL or Muse Spark Open on Baseten. */
export function openModel(env: NodeJS.ProcessEnv = process.env): string {
  return checkedModel(env.USHER_OPEN_MODEL?.trim() || OPEN_MODEL);
}

function checkedModel(model: string): string {
  // Contributor variants let Meta train on the content sent. Never use them.
  if (/-contributor\b/.test(model)) throw new Error(`Refusing model "${model}": contributor variants allow Meta to train on our content.`);
  return model;
}

function usageOf(body: { usage?: Record<string, unknown> }): Usage {
  const u = body.usage ?? {};
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: num(u.total_tokens) || prompt + completion, cached_tokens: num(details.cached_tokens ?? u.cached_tokens) };
}

/** The request with the schema moved into the system prompt, for APIs without structured output. */
export function jsonOnlyRequest(request: ChatRequest): Omit<ChatRequest, 'response_format'> & { response_format: { type: 'json_object' } } {
  const { response_format, ...rest } = request;
  const instruction = `\n\n## Output format\nReply with one JSON object and nothing else: no prose and no code fences. It must match this JSON Schema exactly:\n${JSON.stringify(response_format.json_schema.schema)}`;
  return {
    ...rest,
    response_format: { type: 'json_object' },
    messages: request.messages.map((m, i) => (i === 0 && m.role === 'system' && typeof m.content === 'string' ? { ...m, content: m.content + instruction } : m)),
  };
}

/** Parses a model's JSON reply, tolerating code fences or prose around the object. */
export function parseJsonContent(content: string): unknown {
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new SyntaxError('No JSON object in the reply.');
  }
}

export interface ModelApiOptions {
  /** Which API: the Meta Model API (default) or Baseten. */
  provider?: Provider['name'];
  apiKey?: string;
  url?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function modelApi(options: ModelApiOptions = {}): ChatFn {
  const provider = PROVIDERS[options.provider ?? 'meta'];
  const apiKey = options.apiKey ?? process.env[provider.keyEnv];
  if (!apiKey) throw new Error(`${provider.keyEnv} is not set. Put it in .env at the repository root or export it; it is read from the environment only.`);
  const doFetch = options.fetch ?? fetch;
  const url = options.url ?? provider.url;

  return async (request) => {
    if (/-contributor\b/.test(request.model)) throw new Error(`Refusing model "${request.model}": contributor variants allow Meta to train on our content.`);
    const started = performance.now();
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(provider.structuredOutput ? request : jsonOnlyRequest(request)),
      signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
    });
    const text = await res.text();
    const latency_ms = Math.round(performance.now() - started);
    if (!res.ok) {
      const hint = res.status === 404 && request.model === OPEN_MODEL ? ` (if hackathon access is not active yet, set USHER_OPEN_MODEL=${OPEN_MODEL_PUBLIC})` : '';
      throw new Error(`${provider.name} model API returned ${res.status} ${res.statusText}: ${text.slice(0, 500)}${hint}`);
    }
    let body: { choices?: { message?: { content?: unknown } }[]; usage?: Record<string, unknown> };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Model API returned a non-JSON body: ${text.slice(0, 200)}`);
    }
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error(`Model API response has no message content: ${text.slice(0, 500)}`);
    return { content, usage: usageOf(body), latency_ms, response: body };
  };
}
