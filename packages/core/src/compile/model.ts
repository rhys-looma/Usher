// Chat client for the Meta Model API (OpenAI-compatible), using fetch (LU-19).
//
// The API key is read from MODEL_API_KEY in the environment and never logged or stored.

export const API_URL = 'https://api.meta.ai/v1/chat/completions';
export const DEFAULT_MODEL = 'muse-spark-1.3';

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
  const model = env.USHER_COMPILER_MODEL?.trim() || DEFAULT_MODEL;
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

export interface ModelApiOptions {
  apiKey?: string;
  url?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function modelApi(options: ModelApiOptions = {}): ChatFn {
  const apiKey = options.apiKey ?? process.env.MODEL_API_KEY;
  if (!apiKey) throw new Error('MODEL_API_KEY is not set. Put it in .env at the repository root or export it; it is read from the environment only.');
  const doFetch = options.fetch ?? fetch;
  const url = options.url ?? API_URL;

  return async (request) => {
    if (/-contributor\b/.test(request.model)) throw new Error(`Refusing model "${request.model}": contributor variants allow Meta to train on our content.`);
    const started = performance.now();
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
    });
    const text = await res.text();
    const latency_ms = Math.round(performance.now() - started);
    if (!res.ok) throw new Error(`Model API returned ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
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
