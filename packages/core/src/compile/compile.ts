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
import { classifierRequest, classifyRisks, reconcile, type RiskFlag } from './classify.ts';
import { chooseForm, chooseRequest, type FormChoice } from './choose.ts';
import { examplesForForm, type ExampleIndex } from './retrieval.ts';
import { vote, type ElementAgreement } from './vote.ts';
import { candidateForms, mainForm } from '../forms.ts';

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
  /** Which extracted form to compile; by default chosen by intent (see choose.ts). */
  formIndex?: number;
  /** What the agent is here to do; picks the form when the page has more than one. */
  intent?: string | null;
  /** Path pattern for the map; defaults to the page's path. */
  path?: string;
  step?: number;
  leadsTo?: string;
  now?: () => Date;
  /** A second opinion on risk from an open-weights model; the stricter risk is kept. */
  classifier?: { chat: ChatFn; model: string; examples?: ExampleIndex };
  /** Retrieval few-shot: labelled examples to show the model, nearest to each element. */
  examples?: ExampleIndex;
  /**
   * Vote mode (vote.ts): up to three runs, majority per element, only contested elements asked
   * again. The keeper, the walkthrough and the eval runner use it; the CLI doesn't by default.
   */
  vote?: boolean;
  /** Keep each element's box in the map (the walkthrough and the annotated viewer). */
  boxes?: boolean;
}

export type ClassifierOutcome =
  | { model: string; agreement: number; flags: RiskFlag[]; usage: Usage; cost_usd: number | null; latency_ms: number }
  | { model: string; error: string };

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
  classifier?: ClassifierOutcome;
  /** The model's choice of form, when the page had more than one candidate. */
  choice?: FormChoice;
  /** Vote mode: runs, and per element how many agreed (counts only). */
  votes?: { runs: number; agreement: Record<string, ElementAgreement>; disagreements: number };
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
  // Without a model: the likeliest candidate (forms.ts).
  const best = mainForm(scan.forms);
  if (!best) throw new Error(`No forms found on ${scan.url}.`);
  return best;
}

// A full-width PNG of the form area. Text inputs and text areas are painted over by Playwright's
// mask (outside the page, so any Content Security Policy allows it), so a page that already holds
// someone's answers can't send them to the model, and no value is ever read.
async function screenshotForm(page: Page, form: ScannedForm): Promise<string> {
  const boxes = form.elements.filter((e) => e.visible && e.box.height > 0).map((e) => e.box);
  const width = page.viewportSize()?.width ?? VIEWPORT.width;
  // Clamp to the rendered page: elements can report boxes outside it (fixed overlays, off-screen
  // menus). With nothing to clip to, the viewport as it is.
  const pageHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, window.innerHeight));
  const top = boxes.length ? Math.min(pageHeight - 1, Math.max(0, Math.min(...boxes.map((b) => b.y)) - 160)) : 0;
  const bottom = boxes.length ? Math.min(pageHeight, Math.max(...boxes.map((b) => b.y + b.height)) + 40) : 0;
  const clip = bottom - top >= 1 ? { x: 0, y: top, width, height: bottom - top } : undefined;
  const typed = page.locator('input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=hidden]):not([type=image]):not([type=reset]), textarea');
  const png = await page.screenshot({ type: 'png', fullPage: Boolean(clip), ...(clip && { clip }), mask: [typed], maskColor: '#eef0f3' });
  return png.toString('base64');
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
  const title = await page.title();
  let form: ScannedForm;
  let choice: FormChoice | undefined;
  if (options.formIndex !== undefined) form = pickForm(scan, options.formIndex);
  else {
    const chosen = await chooseForm(scan, { intent: options.intent, chat: options.chat, model, title });
    form = chosen.form;
    choice = chosen.choice;
    if (logDir && (chosen.choice || chosen.error)) {
      const candidates = candidateForms(scan.forms, options.intent);
      await appendLog(logDir, { ts: now().toISOString(), model, url: scan.url, task: 'choose', request: chooseRequest(scan, candidates, options.intent, model, title), chosen: form.index, ...(chosen.choice ? { reason: chosen.choice.reason, usage: chosen.choice.usage, latency_ms: chosen.choice.latency_ms, cost_usd: chosen.choice.cost_usd } : { error: chosen.error }) }, now());
    }
  }
  const fp = await fingerprint(form.elements);
  const pageUrl = new URL(scan.url);
  const image = await screenshotForm(page, form);
  const extraction = compactExtraction(form, { path: pageUrl.pathname, title });

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt() },
    {
      role: 'user',
      content: [
        { type: 'text', text: userPrompt(extraction, options.examples ? examplesForForm(options.examples, form.elements.map((e) => ({ label: e.label, kind: e.kind, control: e.control, ...(e.options && { options: e.options.items.map((o) => o.label) }) }))) : []) },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
      ],
    },
  ];
  const schema = labelsSchema(form);
  const attempts: Attempt[] = [];
  let validation: LabelValidation | undefined;
  let accepted: unknown;
  let votes: CompileResult['votes'];

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

  if (validation?.ok && options.vote) {
    const outcome = await vote({ chat: options.chat, model, form, page: { path: pageUrl.pathname, title }, image, first: { raw: accepted, elements: validation.labels.elements } });
    for (const run of outcome.extra) attempts.push({ usage: run.usage, latency_ms: run.latency_ms, cost_usd: costUsd(model, run.usage), errors: [] });
    const decided = validateLabels(outcome.labels, form.elements);
    if (decided.ok) {
      validation = decided;
      accepted = outcome.labels;
    }
    votes = { runs: outcome.runs, agreement: outcome.agreement, disagreements: outcome.disagreements.length };
    if (logDir) {
      for (const run of outcome.extra) await appendLog(logDir, { ts: now().toISOString(), model, url: scan.url, fingerprint: fp.digest, task: 'vote', asked: run.asked, request: redactRequest(run.request), usage: run.usage, latency_ms: run.latency_ms, cost_usd: costUsd(model, run.usage), ok: run.ok }, now());
      // Counts only: how many runs, and per element how many agreed.
      await appendLog(logDir, { ts: now().toISOString(), model, url: scan.url, fingerprint: fp.digest, task: 'vote_result', runs: outcome.runs, agreement: outcome.agreement, disagreements: outcome.disagreements }, now());
    }
  }

  const usage = [...attempts, ...(choice ? [choice] : [])].reduce((sum, a) => addUsage(sum, a.usage), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 });
  const costs = [...attempts, ...(choice ? [choice] : [])].map((a) => a.cost_usd);
  const cost_usd = costs.every((c) => c !== null) ? costs.reduce((s, c) => s + c!, 0) : null;

  if (!validation?.ok) {
    const errors = validation?.errors ?? [];
    throw new CompileError(
      `Labels for ${scan.url} failed validation after ${attempts.length} attempts:\n${errors.map((e) => `  ${e.path} [${e.code}] ${e.message}`).join('\n')}`,
      errors,
      attempts,
    );
  }

  // Second opinion: where the open-weights classifier disagrees, keep the stricter risk and flag it.
  let classifier: ClassifierOutcome | undefined;
  if (options.classifier) {
    const labelled = validation.labels.elements;
    const els = form.elements.filter((e) => labelled.some((l) => l.id === e.id));
    try {
      const c = await classifyRisks(options.classifier.chat, options.classifier.model, validation.labels.form.purpose, els, options.classifier.examples);
      const { risks, flags, agreement } = reconcile(
        labelled.map((l) => ({ id: l.id, key: l.key, label: els.find((e) => e.id === l.id)!.label, risk: l.risk })),
        c.opinions,
      );
      validation.labels.elements = labelled.map((l) => ({ ...l, risk: risks.get(l.id)! }));
      classifier = { model: c.model, agreement, flags, usage: c.usage, cost_usd: c.cost_usd, latency_ms: c.latency_ms };
      if (logDir) {
        await appendLog(logDir, { ts: now().toISOString(), model: c.model, url: scan.url, fingerprint: fp.digest, task: 'classify', request: classifierRequest(c.model, validation.labels.form.purpose, els, options.classifier.examples), opinions: c.opinions, usage: c.usage, latency_ms: c.latency_ms, cost_usd: c.cost_usd, agreement, flags }, now());
      }
    } catch (err) {
      classifier = { model: options.classifier.model, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const map = mergeMap({
    form,
    fingerprint: fp,
    validation,
    origin: pageUrl.origin,
    path: options.path ?? pageUrl.pathname,
    provenance: { source: 'compiled', compiler: model, created_at: now().toISOString(), verified: false, ...(votes && { votes: { runs: votes.runs, agreement: votes.agreement } }) },
    ...(options.step !== undefined && { step: options.step }),
    ...(options.leadsTo !== undefined && { leadsTo: options.leadsTo }),
    ...(options.boxes && { boxes: true }),
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
    model_ms: [...attempts, ...(choice ? [choice] : [])].reduce((s, a) => s + a.latency_ms, 0),
    total_ms: Math.round(performance.now() - started),
    ...(classifier && { classifier }),
    ...(choice && { choice }),
    ...(votes && { votes }),
  };
}

/**
 * Merges labels that already passed validation for this structure (a cache hit) into a map for this
 * page: for the form with this fingerprint digest, or the likeliest form without one.
 */
export async function mapFromLabels(page: Page, labels: unknown, provenance: { compiler: string; created_at: string }, digest?: string): Promise<UsherMap | null> {
  const scan: Scan = await page.evaluate(scanScript());
  let form: ScannedForm | undefined = digest ? undefined : pickForm(scan);
  for (const f of digest ? candidateForms(scan.forms) : []) if ((await fingerprint(f.elements)).digest === digest) form = f;
  if (!form) return null;
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
