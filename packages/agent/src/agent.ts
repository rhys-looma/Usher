// The reference agent (LU-28, LU-29).
//
// For each page: find the knock notice, fingerprint the form, knock (HTTP or MCP), bind the
// token in the page, then fill fields by semantic key from the user's profile. It never touches
// needs_user elements (the user does them), and pauses for the user's confirmation before a
// consequential action. With no exact map it falls back to Muse Spark: it compiles the page
// (one validated labelling call per page, as the registry's compiler does), submits the map so
// the site script and the next agent can use it, then acts on it. Every run is timed and reported.

import type { Browser, Locator, Page } from 'playwright';
import {
  FLOOR,
  LOOKUP_FILLS,
  dateFormatOf,
  datePart,
  formatDate,
  isDateKey,
  matchOption,
  pickOption,
  preflight,
  validationErrorsScript,
  type FieldSpec,
  type PageError,
  type PreflightProblem,
  compilePage,
  contentDigest,
  signHttpMessage,
  candidateForms,
  mainForm,
  costUsd,
  type ActionRule,
  fingerprint,
  scanScript,
  type ChatFn,
  type MapAction,
  type MapField,
  type Scan,
  type Usage,
  type UsherMap,
} from '@usher/core';
import type { KnockResponse } from '@usher/registry';
import './page-api.ts';
import type { RegistryTransport } from './transport.ts';

/** The user's data by vocabulary key. Selects and radios hold option values. */
export type Profile = Record<string, string | boolean>;

export interface Correction {
  key: string;
  label: string;
  message: string;
  expected?: string;
}

/** What a page will ask of the user, gathered before anything on it is filled. */
export interface PageDecisions {
  path: string;
  /** Fields that are the user's alone (needs_user, or forbidden to agents), whose conditions hold. */
  userOnly: MapField[];
  /** Fields the site's rules say need the user's confirmation before the agent fills them. */
  confirmFields: MapField[];
  /** The way forward, when it needs the user's confirmation. */
  advance?: MapAction;
  /** Required fields the agent would fill but has no value for. */
  missing: MapField[];
}

export interface UserChannel {
  /** Asks the user for a corrected value; null if they have none. Without it, problems fail the run. */
  correct?(problem: Correction): Promise<string | boolean | null>;
  /**
   * Shown each page's decisions before it is filled, so they can be asked together. With it, a
   * missing required value is a question for the user rather than a pre-flight failure. Returns
   * values to add to the profile, or a reason to stop.
   */
  review?(decisions: PageDecisions, page: Page): Promise<{ profile?: Profile; stop?: string } | void>;
  /** Asks the user to confirm an action (or a field) the site's rules say needs them. */
  confirm(element: MapAction | MapField, page: Page): Promise<boolean>;
  /** Hands a needs_user field to the user, who completes it in the browser. */
  handoff(field: MapField, page: Page): Promise<void>;
}

export interface FallbackModel {
  chat: ChatFn;
  model: string;
  logDir?: string | null;
}

export interface AgentOptions {
  browser: Browser;
  url: string;
  profile: Profile;
  registry: RegistryTransport;
  user: UserChannel;
  /** Muse Spark, for pages without a map. Without it the agent stops on such a page. */
  fallback?: FallbackModel;
  /** What the user asked for, e.g. quote.car_insurance. Needed when the registry has no map yet. */
  intent?: string;
  maxPages?: number;
  /** Use the registry's plan for the journey when there is one (default true). */
  usePlan?: boolean;
  /** Check values against the map or plan before touching the page (default true). */
  preflight?: boolean;
  /** Act as an agent without Usher: read every page with the model, no knock, nothing shared. */
  noUsher?: boolean;
  /** Fill each page but stop before its way forward (for public forms: never submit). */
  dryRun?: boolean;
  /** Sign the browser's requests to the site with the agent's key (Web Bot Auth; default true). */
  signRequests?: boolean;
  /** Where the agent publishes its key directory, sent as Signature-Agent. */
  signatureAgent?: string;
  /** Ignore the site's knock notice (an agent that skips Usher), but still look maps up. */
  knock?: boolean;
  /** Every request the browser makes (redirects, scripts, frames) must reach a host this allows. */
  allowHost?: (host: string) => Promise<boolean>;
  /** Extra headers on every request the browser makes, e.g. Usher-Agent. */
  headers?: Record<string, string>;
  viewport?: { width: number; height: number };
  /** Called with the page before the run starts (the demo streams it). */
  onPage?: (page: Page) => Promise<void> | void;
  /** Called with the last page before the browser context closes (to read the result). */
  onFinish?: (page: Page, outcome: RunResult['outcome']) => Promise<void> | void;
  /** Progress as it happens: pages, knocks and model calls, with running usage and cost. */
  onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | { type: 'page'; path: string }
  | { type: 'knock'; path: string; match: KnockResponse['match']['kind'] | 'lookup' | 'none' }
  | { type: 'model'; path: string; done: boolean; usage: Usage; cost_usd: number }
  | { type: 'filled'; path: string; filled: number }
  /** Each action on the page, by semantic key: never the value. */
  | { type: 'action'; path: string; action: 'fill' | 'handoff' | 'press'; key: string };

export interface PageRun {
  path: string;
  match: KnockResponse['match']['kind'];
  map_source: 'registry' | 'compiled';
  knock_ms: number;
  model_ms: number;
  fill_ms: number;
  filled: number;
  handed_off: number;
}

export interface RunResult {
  outcome: 'completed' | 'stopped' | 'failed';
  reason?: string;
  session: string | null;
  final_url: string;
  pages: PageRun[];
  maps_submitted: number;
  transport: RegistryTransport['kind'];
  total_ms: number;
  knock_ms: number;
  model_ms: number;
  fill_ms: number;
  usage: Usage;
  cost_usd: number;
  /** Whether a plan for the whole journey was used. */
  plan_used: boolean;
  /** Values that failed pre-flight, by semantic key (nothing was entered). */
  problems?: PreflightProblem[];
  /** The site's own errors when it rejected a step, by semantic key. */
  errors?: PageError[];
}

// The way forward on a page, in order. A purchase is the user's to make (needs_user), so a run
// reaching one stops there; a dry run stops before it as before any other.
const ADVANCE_KEYS = ['form.submit', 'search.submit', 'nav.next', 'form.purchase'];

/** Ends a run early on purpose (the outcome and reason are already set). */
class StopRun extends Error {}
const ZERO: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 };
const ms = (start: number) => Math.round(performance.now() - start);

/** The Playwright locator for a map element: the first of its locators that finds exactly one. */
export async function locate(page: Page, el: MapField | MapAction): Promise<Locator | null> {
  for (const loc of el.locators) {
    const attr = (name: string) => page.locator(`[${name}=${JSON.stringify(loc.value)}]`);
    const candidate =
      loc.by === 'id' ? attr('id') :
      loc.by === 'name' ? attr('name') :
      loc.by === 'label' ? page.getByLabel(loc.value, { exact: true }) :
      loc.by === 'role' ? page.getByRole(loc.value as Parameters<Page['getByRole']>[0], { name: loc.name ?? '', exact: true }) :
      loc.by === 'placeholder' ? page.getByPlaceholder(loc.value, { exact: true }) :
      page.locator(loc.value);
    const count = await candidate.count();
    // A radio group's name matches each of its radios.
    if (count === 1 || (loc.by === 'name' && 'control' in el && el.control === 'radio' && count > 1)) return candidate;
  }
  return null;
}

const LEAST_CONSENT = /\b(reject|decline|refuse|deny|necessary|essential|required only|only necessary|manage|settings|no,? thanks)\b/i;
const MORE_CONSENT = /\b(accept|allow|agree|ok|got it|consent|yes)\b/i;

/**
 * The banner action to click: always the least-consent option. Among ui.dismiss actions, one that
 * rejects or keeps only what's necessary; never one that accepts. Null if there's no safe choice.
 */
export function leastConsent(actions: MapAction[]): MapAction | null {
  const dismiss = actions.filter((a) => a.key === 'ui.dismiss');
  return dismiss.find((a) => LEAST_CONSENT.test(a.label)) ?? dismiss.find((a) => !MORE_CONSENT.test(a.label)) ?? null;
}

/** Every option of a select or radio group, from the page. */
async function fullOptions(page: Page, field: MapField): Promise<MapField['options'] | null> {
  const target = await locate(page, field);
  if (!target) return null;
  // No named helpers inside: the function is serialised into the page as it is.
  const items = await target.first().evaluate((node) =>
    node.tagName === 'SELECT'
      ? Array.from((node as HTMLSelectElement).querySelectorAll('option'))
          .map((o) => ({ value: o.getAttribute('value') ?? (o.textContent ?? '').replace(/\s+/g, ' ').trim(), label: (o.textContent ?? '').replace(/\s+/g, ' ').trim() }))
          .filter((o) => o.value !== '')
      : [],
  );
  return items.length ? { items, total: items.length, truncated: false } : null;
}

function conditionHolds(field: MapField, profile: Profile): boolean {
  const c = field.shown_if;
  if (!c) return true;
  const answer = profile[c.field];
  switch (c.op) {
    case 'equals':
      return answer === c.value;
    case 'not_equals':
      return answer !== undefined && answer !== c.value;
    case 'in':
      return Array.isArray(c.value) && typeof answer === 'string' && c.value.includes(answer);
    case 'checked':
      return answer === true;
    case 'filled':
      return answer !== undefined && answer !== '';
  }
}

/** Whether a field holds anything: a boolean read in the page, never the value itself. */
async function isFilled(page: Page, field: MapField): Promise<boolean> {
  const target = await locate(page, field);
  if (!target) return false;
  return target
    .first()
    .evaluate((el) => (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? el.checked : 'value' in el && (el as HTMLInputElement).value !== ''))
    .catch(() => false);
}

/**
 * Runs the page's lookups (LOOKUP_FILLS) for which the profile has the input: fills the input,
 * presses the lookup and waits for the page to settle. An address lookup that shows a list of
 * results gets the entry matching address.line1. Returns the keys now filled, which the agent then
 * leaves alone (the lookup's input among them).
 */
async function runLookups(page: Page, map: UsherMap, profile: Profile, ruleFor: (el: MapField | MapAction) => ActionRule, acted: (action: 'fill' | 'press', key: string) => void): Promise<Set<string>> {
  const done = new Set<string>();
  for (const action of map.actions.filter((a) => LOOKUP_FILLS[a.key] && ruleFor(a) === 'allow')) {
    const spec = LOOKUP_FILLS[action.key]!;
    const input = map.fields.find((f) => f.key === spec.input);
    const value = profile[spec.input];
    if (!input || value === undefined || ruleFor(input) !== 'allow') continue;
    if (!(await fillField(page, input, value))) continue;
    done.add(spec.input);
    acted('fill', spec.input);
    const button = await locate(page, action);
    if (!button) continue;
    // Selects and radio groups showing before the press: a list of results is one that wasn't.
    const before = await page.evaluate(() => Array.from(document.querySelectorAll('select, input[type=radio]')).filter((e) => (e as HTMLElement).offsetParent !== null).length);
    await button.first().click();
    acted('press', action.key);
    // Settled when the lookup has filled something, or shown a list of results (up to 3 s).
    const fills = map.fields.filter((x) => spec.fills.includes(x.key));
    const lists = () => page.evaluate(() => Array.from(document.querySelectorAll('select, input[type=radio]')).filter((e) => (e as HTMLElement).offsetParent !== null).length);
    for (const end = Date.now() + 3000; Date.now() < end; await page.waitForTimeout(100)) {
      if ((await lists()) > before) break;
      if ((await Promise.all(fills.map((f) => isFilled(page, f)))).some(Boolean)) break;
    }
    const line1 = typeof profile['address.line1'] === 'string' ? (profile['address.line1'] as string) : '';
    if (action.key === 'lookup.address' && line1 && (await lists()) > before) await pickResult(page, line1);
    for (const f of map.fields.filter((x) => spec.fills.includes(x.key))) if (await isFilled(page, f)) done.add(f.key);
  }
  return done;
}

/**
 * In a lookup's list of results, the entry for the first address line: one whose first part (before
 * the first comma) is the line, else one that starts with it, else one that contains it. So "1 High
 * Street" is never "11 High Street" or "Flat 1, 1 High Street".
 */
async function pickResult(page: Page, line1: string): Promise<void> {
  const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9,]+/g, ' ').replace(/\s*,\s*/g, ',').trim();
  const want = plain(line1).replace(/,/g, ' ');
  const best = (labels: string[]) => {
    const p = labels.map(plain);
    const at = (test: (l: string) => boolean) => p.findIndex(test);
    const i = at((l) => l.split(',')[0] === want);
    if (i >= 0) return i;
    const j = at((l) => l.startsWith(`${want},`) || l.startsWith(`${want} `));
    return j >= 0 ? j : at((l) => l.includes(want));
  };
  for (const select of await page.locator('select:visible').all()) {
    const index = best(await select.locator('option').allTextContents());
    if (index >= 0) {
      await select.selectOption({ index });
      await page.waitForTimeout(300);
      return;
    }
  }
  const radios = await page.locator('input[type=radio]').all();
  const labels = await Promise.all(radios.map((r) => r.evaluate((el) => (el as HTMLInputElement).labels?.[0]?.textContent ?? '').catch(() => '')));
  const index = best(labels);
  if (index >= 0) {
    await radios[index]!.check().catch(() => radios[index]!.evaluate((el) => (el as HTMLElement).click()));
    await page.waitForTimeout(300);
  }
}

export async function fillField(page: Page, field: MapField, value: string | boolean): Promise<boolean> {
  const target = await locate(page, field);
  if (!target) throw new Error(`Could not find ${field.key} ("${field.label}") on the page.`);
  const items = field.options?.items;
  // The option a value means (by value, label, yes/no, or its number), else the value as given.
  const option = (v: string | boolean) => (items ? (matchOption(items, v) ?? String(v)) : String(v));
  // Dates are YYYY-MM-DD by key; a split date fills each part, a text date in the field's own form.
  const iso = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  switch (field.control) {
    case 'select':
      await target.selectOption(field.part && iso ? (datePart(iso, field.part, items) ?? option(value)) : option(value));
      return true;
    case 'radio': {
      // The group is found as its container (id, role) or as its radios (name).
      const chosen = `[value=${JSON.stringify(option(value))}]`;
      const isRadio = (await target.first().evaluate((n) => n.tagName)) === 'INPUT';
      const radio = (isRadio ? page.locator(`input[type=radio][name=${JSON.stringify(await target.first().getAttribute('name'))}]${chosen}`) : target.locator(`input[type=radio]${chosen}`)).first();
      // A radio a person can see is checked; one hidden behind its label (a card: transparent,
      // tiny or invisible) is chosen through the label straight away, rather than after check()
      // has waited out its timeout on a click the label intercepts.
      const behindLabel = await radio.evaluate((el) => {
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return style.opacity === '0' || style.visibility === 'hidden' || box.width < 2 || box.height < 2;
      }).catch(() => true);
      if (!behindLabel) await radio.check({ timeout: 3000 }).catch(() => undefined);
      if (!(await radio.isChecked().catch(() => false))) {
        // Radios styled as cards: the input is hidden and the site listens on its label.
        const id = await radio.getAttribute('id');
        const label = id ? page.locator(`label[for=${JSON.stringify(id)}]`) : radio.locator('xpath=ancestor::label');
        if (await label.count()) await label.first().click();
        else await radio.evaluate((el) => (el as HTMLElement).click());
      }
      return true;
    }
    case 'checkbox':
      if (value === true || (typeof value === 'string' && /^(yes|y|true)$/i.test(value))) await target.check();
      else await target.uncheck();
      return true;
    default:
      if (field.part && iso) await target.fill(datePart(iso, field.part) ?? String(value));
      else if (iso && field.control !== 'date' && (isDateKey(field.key) || field.constraints?.format === 'date')) await target.fill(formatDate(iso, dateFormatOf(field) ?? 'DD/MM/YYYY'));
      else await target.fill(String(value));
      return true;
  }
}


export async function runAgent(options: AgentOptions): Promise<RunResult> {
  const started = performance.now();
  const context = await options.browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 900 }, ...(options.headers && { extraHTTPHeaders: options.headers }) });
  const verdicts = new Map<string, Promise<boolean>>();
  const allowed = (url: string) => {
    if (!options.allowHost) return Promise.resolve(true);
    const host = new URL(url).hostname;
    if (!verdicts.has(host)) verdicts.set(host, options.allowHost(host));
    return verdicts.get(host)!;
  };
  if (options.allowHost) await context.route('**/*', async (route) => ((await allowed(route.request().url())) ? route.continue() : route.abort('blockedbyclient')));
  const page = await context.newPage();
  const emit = (event: AgentEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // Progress is for display; it never stops a run.
    }
  };
  const pages: PageRun[] = [];
  let usage = ZERO;
  let cost = 0;
  let session: string | null = null;
  let submitted = 0;
  let outcome: RunResult['outcome'] = 'completed';
  let reason: string | undefined;
  let profile = { ...options.profile };
  let planUsed = false;
  let problems: PreflightProblem[] | undefined;
  let errors: PageError[] | undefined;

  // Checks values; asks the user to correct what fails. False if anything is still wrong.
  const check = async (fields: FieldSpec[]): Promise<boolean> => {
    if (options.preflight === false) return true;
    let result = preflight(fields, profile);
    // An answer no rule matches to an option: the model chooses among the labels (or none).
    if (!result.ok && options.fallback) {
      let picked = false;
      for (const p of result.problems.filter((x) => x.problem === 'not_an_option')) {
        const f = fields.find((x) => x.key === p.key);
        if (!f?.options) continue;
        const v = await pickOption(options.fallback.chat, options.fallback.model, f, f.options.items, String(profile[p.key])).catch(() => null);
        if (v !== null) (profile = { ...profile, [p.key]: v }), (picked = true);
      }
      if (picked) result = preflight(fields, profile);
    }
    // A missing value is a question for the user at the page's review, not a failure.
    if (options.user.review && !result.ok && result.problems.every((p) => p.problem === 'missing')) result = { ...result, ok: true, problems: [] };
    else if (options.user.review && !result.ok) result = { ...result, problems: result.problems.filter((p) => p.problem !== 'missing') };
    if (!result.ok && options.user.correct) {
      for (const p of result.problems) {
        const value = await options.user.correct(p);
        if (value !== null) profile = { ...profile, [p.key]: value };
      }
      result = preflight(fields, profile);
    }
    profile = result.normalised;
    if (!result.ok) problems = result.problems;
    return result.ok;
  };
  // The user's answers to what the agent may fill; needs_user fields are theirs to give on the page.
  const agentFields = <T extends FieldSpec>(fields: T[], rule: (f: T) => string) => fields.filter((f) => rule(f) !== 'forbid' && f.risk !== 'needs_user');

  try {
    // Web Bot Auth: every request to the site carries a signature from the agent's key, so the
    // site can tell this agent from anyone holding a copy of its token.
    const identity = options.registry.identity;
    if (identity && !options.noUsher && options.signRequests !== false) {
      const origin = new URL(options.url).origin;
      const signatureAgent = options.signatureAgent ?? process.env.USHER_SIGNATURE_AGENT;
      await page.route(
        (u) => u.origin === origin,
        async (route) => {
          const request = route.request();
          // This page route runs before the context's, so it checks the host itself.
          if (!(await allowed(request.url()))) return route.abort('blockedbyclient');
          const headers = Object.fromEntries(Object.entries(await request.allHeaders()).filter(([k]) => !k.startsWith(':')));
          const body = request.postDataBuffer();
          if (body?.length) headers['content-digest'] = await contentDigest(new Uint8Array(body));
          const components = ['@method', '@authority', '@path', ...(body?.length ? ['content-digest'] : [])];
          Object.assign(headers, await signHttpMessage({ method: request.method(), url: request.url(), headers }, identity, { components, ...(signatureAgent && { signatureAgent }) }));
          await route.continue({ headers });
        },
      );
    }
    await options.onPage?.(page);
    // A plan lets the agent check the whole journey's data before opening a page.
    if (options.usePlan !== false && !options.noUsher) {
      const plan = await options.registry.getPlan(options.url);
      if (plan) {
        planUsed = true;
        if (!(await check(agentFields(plan.inputs, () => 'allow')))) {
          outcome = 'failed';
          reason = `Some answers need correcting before starting: ${problems!.map((p) => p.key).join(', ')}.`;
          throw new StopRun();
        }
      }
    }
    await page.goto(options.url, { waitUntil: 'load' });
    for (let step = 0; step < (options.maxPages ?? 10); step++) {
      // Usher sites carry a knock notice; elsewhere the agent can still look a map up by fingerprint.
      const knockUrl = options.noUsher || options.knock === false ? null : await page.locator('form[data-usher-knock]').first().getAttribute('data-usher-knock', { timeout: 2000 }).catch(() => null);
      if (knockUrl) await page.evaluate(() => window.usher?.ready);

      const scan: Scan = await page.evaluate(scanScript());
      // The likeliest form for this intent; no form with fields means the journey is over.
      const form = mainForm(scan.forms, options.intent);
      if (!form) break;
      let fp = await fingerprint(form.elements);
      const path = new URL(page.url()).pathname;
      emit({ type: 'page', path });

      let t = performance.now();
      let knock: KnockResponse | null = null;
      let found: UsherMap | null = null;
      if (knockUrl) {
        knock = await options.registry.knock({ url: page.url(), fingerprint: fp, ...(session && { session }), ...(options.intent && { intent: options.intent }) });
        session = knock.session;
        if (knock.match.kind === 'exact') found = knock.map;
      } else if (!options.noUsher) {
        const lookup = await options.registry.lookup(page.url(), fp).catch(() => null);
        if (lookup?.match.kind === 'exact') found = lookup.map;
      }
      // The map may be for another form on the page (one a model chose by intent): look the other
      // candidates up by fingerprint before reading the page with a model.
      if (!found && !options.noUsher) {
        for (const other of candidateForms(scan.forms, options.intent).filter((f) => f !== form)) {
          const otherFp = await fingerprint(other.elements);
          const lookup = await options.registry.lookup(page.url(), otherFp).catch(() => null);
          if (lookup?.match.kind === 'exact') {
            found = lookup.map;
            fp = otherFp;
            break;
          }
        }
      }
      const knockMs = ms(t);
      if (!options.noUsher) emit({ type: 'knock', path, match: knock ? knock.match.kind : found ? 'lookup' : 'none' });

      // Only an exact map is trusted as a plan; anything else is re-read.
      let map: UsherMap | null = found;
      let modelMs = 0;
      let source: PageRun['map_source'] = 'registry';
      if (!map) {
        if (!options.fallback) {
          outcome = 'stopped';
          reason = `No map for ${path} and no model to read the page.`;
          break;
        }
        t = performance.now();
        emit({ type: 'model', path, done: false, usage, cost_usd: cost });
        const compiled = await compilePage(page, { chat: options.fallback.chat, model: options.fallback.model, logDir: options.fallback.logDir ?? null, intent: options.intent ?? null });
        fp = compiled.map.fingerprint;
        modelMs = ms(t);
        map = { ...compiled.map, provenance: { ...compiled.map.provenance, source: 'agent' } };
        // The token names the intent this agent knocked with; the model's own name for the form
        // varies between runs (quote.car_insurance, quote.motor_insurance), and the page only
        // accepts a token whose intent matches the map.
        if (knock && options.intent) map = { ...map, form: { ...map.form, intent: options.intent } };
        usage = { prompt_tokens: usage.prompt_tokens + compiled.usage.prompt_tokens, completion_tokens: usage.completion_tokens + compiled.usage.completion_tokens, total_tokens: usage.total_tokens + compiled.usage.total_tokens, cached_tokens: usage.cached_tokens + compiled.usage.cached_tokens };
        cost += compiled.cost_usd ?? costUsd(options.fallback.model, compiled.usage) ?? 0;
        source = 'compiled';
        emit({ type: 'model', path, done: true, usage, cost_usd: cost });
        // Share it before acting, so the site script can log this run by semantic key and the
        // next agent gets the fast path.
        // A registry may not accept maps (403 maps_closed); the run goes on with this one.
        if (knock && (await options.registry.submitMap(map).catch(() => ({ stored: false }))).stored) submitted++;
      }

      if (knock) {
        const bound = await page.evaluate((token) => window.usher.bind(token), knock.token);
        if (!bound.ok) throw new Error(`The page refused the token: ${bound.error}`);
      }

      // Fill by semantic key. needs_user goes to the user; conditions are checked against the profile.
      t = performance.now();
      let filled = 0;
      let handedOff = 0;
      // The site's rules when it has an agent lane; otherwise the map's own risk.
      const ruleFor = (el: MapField | MapAction): ActionRule => knock?.rules.actions[el.key] ?? FLOOR[el.risk];
      // Check this page's values before touching it. Long option lists are cut to 20 in the map, so
      // read the whole list from the page (structure, not values) to check against.
      const fields: MapField[] = [];
      for (const f of agentFields(map.fields, ruleFor)) fields.push(f.options?.truncated ? { ...f, options: (await fullOptions(page, f)) ?? f.options } : f);
      if (!(await check(fields))) {
        outcome = 'failed';
        reason = `Some answers need correcting for ${path}: ${problems!.map((p) => p.key).join(', ')}.`;
        break;
      }
      const advance = map.actions.find((a) => a.key === 'form.submit' || a.key === 'search.submit') ?? map.actions.find((a) => ADVANCE_KEYS.includes(a.key));
      // Lookups first: the registration (or postcode) the person gave, then the site's own lookup.
      // What it fills is left as the site filled it, and isn't asked for.
      const lookedUp = options.dryRun ? new Set<string>() : await runLookups(page, map, profile, ruleFor, (action, key) => emit({ type: 'action', path, action, key }));
      if (options.user.review) {
        const holds = map.fields.filter((f) => conditionHolds(f, profile));
        const reviewed = await options.user.review(
          {
            path,
            userOnly: holds.filter((f) => ruleFor(f) === 'forbid'),
            confirmFields: holds.filter((f) => ruleFor(f) === 'confirm'),
            ...(advance && ruleFor(advance) === 'confirm' && !options.dryRun && { advance }),
            missing: holds.filter((f) => f.required && ruleFor(f) === 'allow' && f.risk !== 'needs_user' && profile[f.key] === undefined && !lookedUp.has(f.key)),
          },
          page,
        );
        if (reviewed?.stop) {
          outcome = 'stopped';
          reason = reviewed.stop;
          break;
        }
        if (reviewed?.profile) profile = { ...profile, ...reviewed.profile };
      }
      // Cookie banners first, with the least consent on offer.
      const banner = leastConsent(map.actions);
      if (banner) {
        const button = await locate(page, banner);
        if (button && (await button.isVisible())) await button.click().catch(() => undefined);
      }
      for (const field of map.fields) {
        if (!conditionHolds(field, profile) || lookedUp.has(field.key)) continue;
        if (ruleFor(field) === 'forbid') {
          if (knock) await page.evaluate((key) => window.usher.handoff(key), field.key);
          await options.user.handoff(field, page);
          emit({ type: 'action', path, action: 'handoff', key: field.key });
          handedOff++;
          continue;
        }
        if (ruleFor(field) === 'confirm' && !(await options.user.confirm(field, page))) continue;
        const value = profile[field.key];
        if (value === undefined) {
          if (field.required) throw new Error(`The profile has no ${field.key} ("${field.label}"), which is required.`);
          continue;
        }
        if (await fillField(page, field, value)) {
          filled++;
          emit({ type: 'action', path, action: 'fill', key: field.key });
        }
      }

      emit({ type: 'filled', path, filled });
      if (!advance) {
        outcome = 'stopped';
        reason = `No way forward on ${path}.`;
        break;
      }
      if (options.dryRun) {
        // Filled and checked; the way forward is left alone.
        pages.push({ path, match: knock?.match.kind ?? (found ? 'exact' : 'none'), map_source: source, knock_ms: knockMs, model_ms: modelMs, fill_ms: ms(t), filled, handed_off: handedOff });
        reason = `dry run: stopped before "${advance.label}"`;
        break;
      }
      if (ruleFor(advance) === 'forbid') {
        outcome = 'stopped';
        reason = `"${advance.label}" is for the user to do.`;
        break;
      }
      if (ruleFor(advance) === 'confirm' && !knock) {
        if (!(await options.user.confirm(advance, page))) {
          outcome = 'stopped';
          reason = `The user declined "${advance.label}".`;
          break;
        }
      } else if (ruleFor(advance) === 'confirm' && knock) {
        // Pause: the user decides. Then knock again saying so, which is where the site's rules
        // (forbidden actions, rate limits) are applied, and tell the page.
        if (!(await options.user.confirm(advance, page))) {
          outcome = 'stopped';
          reason = `The user declined "${advance.label}".`;
          break;
        }
        let confirmedKnock: KnockResponse;
        try {
          confirmedKnock = await options.registry.knock({ url: page.url(), fingerprint: fp, session: session!, confirmed: [advance.key], ...(options.intent && { intent: options.intent }) });
        } catch (err) {
          outcome = 'stopped';
          reason = `The site refused "${advance.label}": ${err instanceof Error ? err.message : String(err)}`;
          break;
        }
        const rebound = await page.evaluate((token) => window.usher.bind(token), confirmedKnock.token);
        if (!rebound.ok) throw new Error(`The page refused the confirmed token: ${rebound.error}`);
        await page.evaluate((key) => window.usher.confirm(key), advance.key);
      }
      const button = await locate(page, advance);
      if (!button) throw new Error(`Could not find "${advance.label}".`);
      // Click, wait for the next document, and read the site's errors if it sent the page back.
      const elements = [...map.fields, ...map.actions].map((e) => ({ key: e.key, locators: e.locators }));
      const submit = async (target: Locator): Promise<PageError[]> => {
        await Promise.all([page.waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame(), timeout: 15_000 }), target.click()]);
        await page.waitForLoadState('load');
        if (new URL(page.url()).pathname !== path) return [];
        return (await page.evaluate(validationErrorsScript(elements))) as PageError[];
      };
      let rejected = await submit(button);
      emit({ type: 'action', path, action: 'press', key: advance.key });
      // Bind again on the page that came back, so the site script logs which keys were rejected.
      if (rejected.length && knock) {
        // Wait for that log to reach the registry before the page can be closed.
        const logged = page.waitForResponse((r) => r.request().method() === 'POST' && /\/sessions\/[^/]+\/events$/.test(new URL(r.url()).pathname), { timeout: 3000 }).catch(() => undefined);
        await page.evaluate((token) => window.usher?.bind(token), knock.token).catch(() => undefined);
        await logged;
      }
      if (rejected.length && options.user.correct) {
        // Fix what the site named, by key, and try once more without re-reading the page.
        for (const e of rejected) {
          const field = map.fields.find((f) => f.key === e.key);
          const value = field ? await options.user.correct({ key: e.key, label: field.label, message: e.message }) : null;
          if (field && value !== null) {
            profile = { ...profile, [e.key]: value };
            await fillField(page, field, value);
          }
        }
        if (ruleFor(advance) === 'confirm' && knock) {
          const again = await options.registry.knock({ url: page.url(), fingerprint: fp, session: session!, confirmed: [advance.key], ...(options.intent && { intent: options.intent }) });
          await page.evaluate((token) => window.usher.bind(token), again.token);
          await page.evaluate((key) => window.usher.confirm(key), advance.key);
        }
        const retry = await locate(page, advance);
        if (retry) rejected = await submit(retry);
      }
      if (new URL(page.url()).pathname === path) {
        errors = rejected;
        outcome = 'failed';
        reason = rejected.length ? `${path} was rejected: ${rejected.map((e) => `${e.key} (${e.message})`).join('; ')}.` : `${path} did not move on.`;
        break;
      }
      const fillMs = ms(t);
      pages.push({ path, match: knock?.match.kind ?? (found ? 'exact' : 'none'), map_source: source, knock_ms: knockMs, model_ms: modelMs, fill_ms: fillMs, filled, handed_off: handedOff });

      if (source === 'compiled' && knock) {
        // We now know where the way forward leads: record that edge on the map we shared.
        const leadsTo = new URL(page.url()).pathname;
        await options.registry.submitMap({ ...map, actions: map.actions.map((a) => (a.id === advance.id ? { ...a, leads_to: leadsTo } : a)) }).catch(() => undefined);
      }
    }
  } catch (err) {
    if (!(err instanceof StopRun)) {
      outcome = 'failed';
      reason = err instanceof Error ? err.message : String(err);
    }
  }

  const finalUrl = page.url();
  await Promise.resolve(options.onFinish?.(page, outcome)).catch(() => undefined);
  await context.close();
  const sum = (k: 'knock_ms' | 'model_ms' | 'fill_ms') => pages.reduce((s, p) => s + p[k], 0);
  const result: RunResult = {
    outcome,
    ...(reason && { reason }),
    session,
    final_url: finalUrl,
    pages,
    maps_submitted: submitted,
    transport: options.registry.kind,
    total_ms: ms(started),
    knock_ms: sum('knock_ms'),
    model_ms: sum('model_ms'),
    fill_ms: sum('fill_ms'),
    usage,
    cost_usd: Math.round(cost * 1e6) / 1e6,
    plan_used: planUsed,
    ...(problems && { problems }),
    ...(errors && { errors }),
  };
  if (session) {
    await options.registry
      .reportRun({
        session,
        url: finalUrl,
        outcome,
        summary: {
          pages: pages.length,
          total_ms: result.total_ms,
          knock_ms: result.knock_ms,
          model_ms: result.model_ms,
          fill_ms: result.fill_ms,
          tokens_in: usage.prompt_tokens,
          tokens_out: usage.completion_tokens,
          cost_usd: result.cost_usd,
          maps: pages.map((p) => p.map_source).join(','),
          transport: result.transport,
        },
      })
      .catch(() => undefined);
  }
  return result;
}

/** One line: the start of the benchmark. */
export function summaryLine(r: RunResult): string {
  const s = (n: number) => `${(n / 1000).toFixed(2)}s`;
  const exact = r.pages.filter((p) => p.map_source === 'registry').length;
  return `usher agent: ${r.outcome}${r.reason ? ` (${r.reason})` : ''} · ${r.pages.length} pages in ${s(r.total_ms)} (knock ${s(r.knock_ms)}, model ${s(r.model_ms)}, fill ${s(r.fill_ms)}) · maps from registry ${exact}/${r.pages.length} · ${r.usage.prompt_tokens}/${r.usage.completion_tokens} tokens · $${r.cost_usd.toFixed(4)} · ${r.transport}`;
}
