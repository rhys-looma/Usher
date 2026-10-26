// The compiler (LU-19): page → extract → locators → fingerprint → model labels → validate →
// merge → schema-valid map. On validation errors it retries once with the errors appended,
// then fails loudly.

import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { fingerprint } from '../fingerprint.ts';
import { scanScript, type Scan, type ScannedForm } from '../inpage.ts';
import { validateLabels, type Exclusion, type LabelError, type LabelValidation, type RiskClamp } from '../labels.ts';
import { mergeMap, type UsherMap } from '../map.ts';
import { appendLog, redactRequest } from './log.ts';
import { compilerModel, costUsd, parseJsonContent, type ChatFn, type ChatMessage, type ChatRequest, type Usage } from './model.ts';
import { compactExtraction, labelsSchema, retryPrompt, systemPrompt, userPrompt } from './prompt.ts';

/** Default compiler log folder: data/compiler-log at the repository root (gitignored). */
export const DEFAULT_LOG_DIR = fileURLToPath(new URL('../../../../data/compiler-log/', import.meta.url));

export const VIEWPORT = { width: 1280, height: 900 };

const MAX_ATTEMPTS = 2;

export interface CompileOptions {
  chat: ChatFn;
  /** Defaults to USHER_COMPILER_MODEL or muse-spark-1.3. */
  model?: string;
  /** Where to append the request log; null to turn logging off. */
  logDir?: string | null;
  /** Which extracted form to compile; defaults to the one with the most fields. */
  formIndex?: number;
  /** Path pattern for the map; defaults to the page's path. */
  path?: string;
  step?: number;
  leadsTo?: string;
  now?: () => Date;
}

export interface Attempt {
  usage: Usage;
  latency_ms: number;
  cost_usd: number | null;
  errors: LabelError[];
}

export interface CompileResult {
  map: UsherMap;
  /** The labels the model returned that passed validation, for caching by fingerprint. */
  labels: unknown;
  model: string;
  attempts: Attempt[];
  clamps: RiskClamp[];
  excluded: Exclusion[];
  usage: Usage;
  cost_usd: number | null;
  /** Time spent waiting for the model. */
  model_ms: number;
  /** Whole compile, including extraction and the screenshot. */
  total_ms: number;
}

export class CompileError extends Error {
  constructor(
    message: string,
    readonly errors: LabelError[],
    readonly attempts: Attempt[],
  ) {
    super(message);
    this.name = 'CompileError';
  }
}

export function pickForm(scan: Scan, index?: number): ScannedForm {
  if (index !== undefined) {
    const form = scan.forms[index];
    if (!form) throw new Error(`No form ${index} on ${scan.url}; found ${scan.forms.length}.`);
    return form;
  }
  const fields = (f: ScannedForm) => f.elements.filter((e) => e.kind === 'field').length;
  const best = [...scan.forms].sort((a, b) => fields(b) - fields(a))[0];
  if (!best) throw new Error(`No forms found on ${scan.url}.`);
  return best;
}

// A full-width PNG of the form area. Text in filled inputs is hidden first, so a page that
// already holds someone's answers can't send them to the model.
async function screenshotForm(page: Page, form: ScannedForm): Promise<string> {
  const boxes = form.elements.filter((e) => e.visible).map((e) => e.box);
  const width = page.viewportSize()?.width ?? VIEWPORT.width;
  const top = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 160);
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 40;
  const style = await page.addStyleTag({
    content:
      'input:not([type=checkbox]):not([type=radio]):not(:placeholder-shown), textarea { color: transparent !important; -webkit-text-fill-color: transparent !important; }',
  });
  try {
    const png = await page.screenshot({ type: 'png', fullPage: true, clip: { x: 0, y: top, width, height: Math.max(1, bottom - top) } });
    return png.toString('base64');
  } finally {
    await style.evaluate((node) => (node as Element).remove());
  }
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    cached_tokens: a.cached_tokens + b.cached_tokens,
  };
}

export async function compilePage(page: Page, options: CompileOptions): Promise<CompileResult> {
  const started = performance.now();
  const model = options.model ?? compilerModel();
  const now = options.now ?? (() => new Date());
  const logDir = options.logDir === undefined ? DEFAULT_LOG_DIR : options.logDir;

  const scan: Scan = await page.evaluate(scanScript());
  const form = pickForm(scan, options.formIndex);
  const fp = await fingerprint(form.elements);
  const pageUrl = new URL(scan.url);
  const image = await screenshotForm(page, form);
  const extraction = compactExtraction(form, { path: pageUrl.pathname, title: await page.title() });

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt() },
    {
      role: 'user',
      content: [
        { type: 'text', text: userPrompt(extraction) },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
      ],
    },
  ];
  const schema = labelsSchema(form);
  const attempts: Attempt[] = [];
  let validation: LabelValidation | undefined;
  let accepted: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const request: ChatRequest = {
      model,
      temperature: 0,
      messages: [...messages],
      response_format: { type: 'json_schema', json_schema: { name: 'usher_labels', strict: true, schema } },
    };
    const result = await options.chat(request);
    let parsed: unknown;
    try {
      parsed = parseJsonContent(result.content);
      validation = validateLabels(parsed, form.elements);
    } catch {
      validation = { ok: false, errors: [{ path: '$', code: 'invalid_json', message: 'The response was not valid JSON.' }], clamps: [], excluded: [] };
    }
    const cost = costUsd(model, result.usage);
    attempts.push({ usage: result.usage, latency_ms: result.latency_ms, cost_usd: cost, errors: validation.errors });

    if (logDir) {
      await appendLog(
        logDir,
        {
          ts: now().toISOString(),
          model,
          url: scan.url,
          fingerprint: fp.digest,
          attempt,
          request: redactRequest(request),
          response: result.response,
          usage: result.usage,
          latency_ms: result.latency_ms,
          cost_usd: cost,
          validation: { ok: validation.ok, errors: validation.errors, clamps: validation.clamps, excluded: validation.excluded },
        },
        now(),
      );
    }

    if (validation.ok) {
      accepted = parsed;
      break;
    }
    messages.push({ role: 'assistant', content: result.content }, { role: 'user', content: retryPrompt(validation.errors) });
  }

  const usage = attempts.reduce((sum, a) => addUsage(sum, a.usage), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 });
  const costs = attempts.map((a) => a.cost_usd);
  const cost_usd = costs.every((c) => c !== null) ? costs.reduce((s, c) => s + c!, 0) : null;

  if (!validation?.ok) {
    const errors = validation?.errors ?? [];
    throw new CompileError(
      `Labels for ${scan.url} failed validation after ${attempts.length} attempts:\n${errors.map((e) => `  ${e.path} [${e.code}] ${e.message}`).join('\n')}`,
      errors,
      attempts,
    );
  }

  const map = mergeMap({
    form,
    fingerprint: fp,
    validation,
    origin: pageUrl.origin,
    path: options.path ?? pageUrl.pathname,
    provenance: { source: 'compiled', compiler: model, created_at: now().toISOString(), verified: false },
    ...(options.step !== undefined && { step: options.step }),
    ...(options.leadsTo !== undefined && { leadsTo: options.leadsTo }),
  });

  return {
    map,
    labels: accepted,
    model,
    attempts,
    clamps: validation.clamps,
    excluded: validation.excluded,
    usage,
    cost_usd,
    model_ms: attempts.reduce((s, a) => s + a.latency_ms, 0),
    total_ms: Math.round(performance.now() - started),
  };
}

/** Merges labels that already passed validation for this structure (a cache hit) into a map for this page. */
export async function mapFromLabels(page: Page, labels: unknown, provenance: { compiler: string; created_at: string }): Promise<UsherMap | null> {
  const scan: Scan = await page.evaluate(scanScript());
  const form = pickForm(scan);
  const validation = validateLabels(labels, form.elements);
  if (!validation.ok) return null;
  const url = new URL(scan.url);
  return mergeMap({
    form,
    fingerprint: await fingerprint(form.elements),
    validation,
    origin: url.origin,
    path: url.pathname,
    provenance: { source: 'compiled', compiler: provenance.compiler, created_at: provenance.created_at, verified: false },
  });
}

/** Loads a URL in a fresh 1280px-wide browser context and compiles it. */
export async function compileUrl(url: string, options: CompileOptions & { browser?: Browser }): Promise<CompileResult> {
  const { chromium } = await import('playwright');
  const browser = options.browser ?? (await chromium.launch());
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    return await compilePage(page, options);
  } finally {
    await context.close();
    if (!options.browser) await browser.close();
  }
}

/** One line: elements, attempts, tokens, cost and latency. */
export function summary(result: CompileResult): string {
  const { map, usage } = result;
  const cost = result.cost_usd === null ? 'cost unknown' : `$${result.cost_usd.toFixed(4)}`;
  const elements = map.fields.length + map.actions.length;
  return `${map.path}: ${elements} elements, ${result.attempts.length} attempt${result.attempts.length === 1 ? '' : 's'}, ${usage.prompt_tokens} in / ${usage.completion_tokens} out tokens, ${cost}, model ${(result.model_ms / 1000).toFixed(1)}s, total ${(result.total_ms / 1000).toFixed(1)}s (${result.model})`;
}
