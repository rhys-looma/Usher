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
  preflight,
  validationErrorsScript,
  type FieldSpec,
  type PageError,
  type PreflightProblem,
  compilePage,
  pickForm,
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

export interface UserChannel {
  /** Asks the user for a corrected value; null if they have none. Without it, problems fail the run. */
  correct?(problem: Correction): Promise<string | boolean | null>;
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
}

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
  transport: 'http' | 'mcp';
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

const ADVANCE_KEYS = ['form.submit', 'nav.next'];

/** Ends a run early on purpose (the outcome and reason are already set). */
class StopRun extends Error {}
const ZERO: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 };
const ms = (start: number) => Math.round(performance.now() - start);

/** The Playwright locator for a map element: the first of its locators that finds exactly one. */
async function locate(page: Page, el: MapField | MapAction): Promise<Locator | null> {
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

async function fillField(page: Page, field: MapField, value: string | boolean): Promise<boolean> {
  const target = await locate(page, field);
  if (!target) throw new Error(`Could not find ${field.key} ("${field.label}") on the page.`);
  switch (field.control) {
    case 'select':
      await target.selectOption(String(value));
      return true;
    case 'radio': {
      // The group is found as its container (id, role) or as its radios (name).
      const option = `[value=${JSON.stringify(String(value))}]`;
      const isRadio = (await target.first().evaluate((n) => n.tagName)) === 'INPUT';
      await (isRadio ? page.locator(`input[type=radio][name=${JSON.stringify(await target.first().getAttribute('name'))}]${option}`) : target.locator(`input[type=radio]${option}`)).check();
      return true;
    }
    case 'checkbox':
      if (value === true) await target.check();
      else await target.uncheck();
      return true;
    default:
      await target.fill(String(value));
      return true;
  }
}

function mainForm(scan: Scan) {
  return pickForm(scan);
}

export async function runAgent(options: AgentOptions): Promise<RunResult> {
  const started = performance.now();
  const context = await options.browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
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
      const knockUrl = options.noUsher ? null : await page.locator('form[data-usher-knock]').first().getAttribute('data-usher-knock', { timeout: 2000 }).catch(() => null);
      if (knockUrl) await page.evaluate(() => window.usher?.ready);

      const scan: Scan = await page.evaluate(scanScript());
      const form = scan.forms.length ? mainForm(scan) : undefined;
      // No form with fields: the journey is over.
      if (!form || !form.elements.some((e) => e.kind === 'field' && e.visible)) break;
      const fp = await fingerprint(form.elements);
      const path = new URL(page.url()).pathname;

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
      const knockMs = ms(t);

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
        const compiled = await compilePage(page, { chat: options.fallback.chat, model: options.fallback.model, logDir: options.fallback.logDir ?? null });
        modelMs = ms(t);
        map = { ...compiled.map, provenance: { ...compiled.map.provenance, source: 'agent' } };
        usage = { prompt_tokens: usage.prompt_tokens + compiled.usage.prompt_tokens, completion_tokens: usage.completion_tokens + compiled.usage.completion_tokens, total_tokens: usage.total_tokens + compiled.usage.total_tokens, cached_tokens: usage.cached_tokens + compiled.usage.cached_tokens };
        cost += compiled.cost_usd ?? costUsd(options.fallback.model, compiled.usage) ?? 0;
        source = 'compiled';
        // Share it before acting, so the site script can log this run by semantic key and the
        // next agent gets the fast path.
        if (knock && (await options.registry.submitMap(map)).stored) submitted++;
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
      // Cookie banners first, with the least consent on offer.
      const banner = leastConsent(map.actions);
      if (banner) {
        const button = await locate(page, banner);
        if (button && (await button.isVisible())) await button.click().catch(() => undefined);
      }
      for (const field of map.fields) {
        if (!conditionHolds(field, profile)) continue;
        if (ruleFor(field) === 'forbid') {
          if (knock) await page.evaluate((key) => window.usher.handoff(key), field.key);
          await options.user.handoff(field, page);
          handedOff++;
          continue;
        }
        if (ruleFor(field) === 'confirm' && !(await options.user.confirm(field, page))) continue;
        const value = profile[field.key];
        if (value === undefined) {
          if (field.required) throw new Error(`The profile has no ${field.key} ("${field.label}"), which is required.`);
          continue;
        }
        if (await fillField(page, field, value)) filled++;
      }

      const advance = map.actions.find((a) => a.key === 'form.submit') ?? map.actions.find((a) => ADVANCE_KEYS.includes(a.key));
      if (!advance) {
        outcome = 'stopped';
        reason = `No way forward on ${path}.`;
        break;
      }
      if (ruleFor(advance) === 'forbid') {
        outcome = 'stopped';
        reason = `"${advance.label}" is for the user to do.`;
        break;
      }
      if (options.dryRun) {
        // Filled and checked; the way forward is left alone.
        pages.push({ path, match: knock?.match.kind ?? (found ? 'exact' : 'none'), map_source: source, knock_ms: knockMs, model_ms: modelMs, fill_ms: ms(t), filled, handed_off: handedOff });
        reason = `dry run: stopped before "${advance.label}"`;
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
      // Bind again on the page that came back, so the site script logs which keys were rejected.
      if (rejected.length && knock) await page.evaluate((token) => window.usher?.bind(token), knock.token).catch(() => undefined);
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
