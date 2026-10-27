// The keeper (LU-51) and drift rebuilds (LU-42). On a schedule, and whenever a site script reports
// drift, the keeper opens each known form it can reach without submitting anything, fingerprints
// it, and if it changed asks Muse Spark Open (cheap) whether the change is cosmetic or real. A
// cosmetic change carries the labels over to the new structure; a real one is recompiled with Muse
// Spark. The new map version is stored, the old one kept and marked replaced. It never submits,
// identifies itself (user agent, a knock as its own agent), and respects robots.txt.

import type { Browser } from 'playwright';
import {
  VIEWPORT,
  compilePage,
  costUsd,
  fingerprint,
  generateAgentIdentity,
  importAgentIdentity,
  mergeMap,
  candidateForms,
  parseJsonContent,
  scanScript,
  similarity,
  signRequest,
  validateLabels,
  type ChatFn,
  type ExtractedForm,
  type PrivateJwk,
  type Scan,
  type ScannedForm,
  type UsherMap,
} from '@usher/core';
import type { Registry } from './registry.ts';
import type { MapRecord } from './storage.ts';

export const KEEPER_AGENT = 'UsherKeeper/0.1';

export type CheckOutcome = 'unchanged' | 'restored' | 'cosmetic' | 'rebuilt' | 'unreachable' | 'robots' | 'error' | 'no_model' | 'paused';

/** The keeper's last word on a form, shown on the dashboard. */
export interface KeeperCheck {
  origin: string;
  path: string;
  checked_at: string;
  outcome: CheckOutcome;
  detail: string;
  /** Map digests before and after, when the form changed. */
  from?: string;
  to?: string;
  /** Something consequential changed: a person should look. */
  review?: boolean;
  cost_usd: number;
  ms: number;
}

export interface KeeperOptions {
  /** Muse Spark, to recompile a form that really changed. */
  compiler?: { chat: ChatFn; model: string };
  /** Muse Spark Open, to triage a change as cosmetic or real. */
  triage?: { chat: ChatFn; model: string };
  /** Minutes between scheduled runs; 0 turns the schedule off (drift reports still trigger checks). */
  intervalMinutes?: number;
  /** Fetches robots.txt (tests replace it). */
  fetch?: typeof fetch;
  /**
   * The only origins the keeper opens (USHER_KEEPER_ORIGINS). It loads pages in a browser, and a
   * page can redirect or send requests anywhere, so in production it visits only sites we trust
   * (our own demo site) until every request it makes is checked. Unset: every registered site.
   */
  origins?: string[];
  now?: () => Date;
}

/** robots.txt rules for user agent "*" and ours: is this path allowed? */
export function robotsAllows(robots: string, path: string, agent = 'usherkeeper'): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  for (const raw of robots.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [field, value] = [m[1]!.toLowerCase(), m[2]!.trim()];
    if (field === 'user-agent') {
      if (!current || current.rules.length) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
    } else if ((field === 'allow' || field === 'disallow') && current) {
      if (value) current.rules.push({ allow: field === 'allow', path: value });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => agent.startsWith(a.replace(/\/.*/, '')) && a !== '*'));
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  // The longest matching rule wins; allow wins a tie.
  const matching = rules.filter((r) => path.startsWith(r.path.replace(/\*$/, ''))).sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return matching[0]?.allow ?? true;
}

function describe(elements: { kind: string; control: string; label: string; required: boolean }[]): string[] {
  return elements.map((e) => `${e.kind === 'action' ? 'action' : e.control}: ${e.label}${e.required ? ' (required)' : ''}`);
}

/**
 * A cosmetic change keeps every element's meaning: carry each old label to the new element with the
 * same control and the same label text. Null if any visible element can't be matched.
 */
export function carryLabels(old: UsherMap, form: ExtractedForm): unknown | null {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const oldEls = [...old.fields.map((f) => ({ id: f.id, key: f.key, risk: f.risk, kind: 'field', control: f.control, label: f.label, shown_if: f.shown_if })), ...old.actions.map((a) => ({ id: a.id, key: a.key, risk: a.risk, kind: 'action', control: a.kind, label: a.label, shown_if: undefined }))];
  const used = new Set<string>();
  const byOld = new Map<string, string>();
  const elements = [];
  for (const el of form.elements) {
    const match = oldEls.find((o) => !used.has(o.id) && o.kind === el.kind && o.control === el.control && norm(o.label) === norm(el.label));
    if (!match) {
      if (el.visible) return null;
      continue;
    }
    used.add(match.id);
    byOld.set(match.key, el.id);
    elements.push({ id: el.id, key: match.key, risk: match.risk, shown_if: match.shown_if ? { old: match.shown_if } : null });
  }
  // Conditions point at fields by key; translate them to the new ids.
  const keyToId = new Map([...byOld]);
  const labels = elements.map((e) => {
    const c = (e.shown_if as { old?: UsherMap['fields'][number]['shown_if'] } | null)?.old;
    if (!c) return { ...e, shown_if: null };
    const fieldId = keyToId.get(c.field);
    return { ...e, shown_if: fieldId ? { field_id: fieldId, op: c.op, value: c.value ?? null } : null };
  });
  const advance = old.actions.find((a) => a.leads_to);
  return { form: { purpose: old.form.purpose, intent: old.form.intent ?? 'unknown' }, elements: labels, advance_action_id: advance ? (byOld.get(advance.key) ?? null) : null };
}

const TRIAGE = `A website form changed. You see the elements of the old version (with their meaning) and of the new one. Decide whether the change is cosmetic (the same questions in a new order, new wording that means the same, renamed or restyled elements) or real (questions added, removed, or asking something different; a different form). Say also whether anything consequential changed: a submit, a payment, a declaration or consent, or what a consequential action does. Reply with JSON only: {"change": "cosmetic" | "real", "consequential_changed": true | false, "summary": "one sentence"}.`;

export class Keeper {
  private browser?: Promise<Browser>;
  private timer?: NodeJS.Timeout;
  private readonly queue = new Map<string, Promise<KeeperCheck>>();
  private identity?: Awaited<ReturnType<typeof importAgentIdentity>>;

  constructor(
    private readonly registry: Registry,
    private readonly options: KeeperOptions = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  start(): void {
    const minutes = this.options.intervalMinutes ?? 0;
    if (minutes > 0) {
      this.timer = setInterval(() => void this.runAll().catch(() => undefined), minutes * 60_000);
      this.timer.unref();
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.queue.values()]);
    if (this.browser) await (await this.browser).close();
  }

  private getBrowser(): Promise<Browser> {
    this.browser ??= import('playwright').then(({ chromium }) => chromium.launch());
    return this.browser;
  }

  /** The keeper knocks as its own agent, so sites see it in their logs. */
  private async knock(url: string, fp: { algo: 'usher-fp-1'; digest: string; signature: string[] }): Promise<void> {
    if (!this.identity) {
      const stored = await this.registry.storage.getCached<PrivateJwk>('keeper', 'key');
      if (stored) this.identity = await importAgentIdentity(stored);
      else {
        const { identity, privateJwk } = await generateAgentIdentity();
        await this.registry.storage.putCached('keeper', 'key', privateJwk);
        this.identity = identity;
      }
    }
    const page = new URL(url);
    await this.registry.knock(await signRequest({ usher: '0.1', url: page.origin + page.pathname, intent: 'registry.keeper', fingerprint: fp }, this.identity)).catch(() => undefined);
  }

  /** Every current form of every registered site, one at a time. */
  async runAll(): Promise<KeeperCheck[]> {
    const results: KeeperCheck[] = [];
    for (const site of await this.registry.storage.listSites()) {
      if (!this.listed(site.origin)) continue;
      for (const record of await this.currentMaps(site.origin)) results.push(await this.check(site.origin, record.map.path));
    }
    return results;
  }

  private async currentMaps(origin: string): Promise<MapRecord[]> {
    const latest = new Map<string, MapRecord>();
    for (const r of await this.registry.storage.mapsForOrigin(origin)) {
      const seen = latest.get(r.map.path);
      if (!seen || r.added_at > seen.added_at) latest.set(r.map.path, r);
    }
    return [...latest.values()];
  }

  private listed(origin: string): boolean {
    return !this.options.origins || this.options.origins.includes(origin);
  }

  /** Checks one form; concurrent requests for the same form share one check. */
  check(origin: string, path: string): Promise<KeeperCheck> {
    if (!this.listed(origin)) return Promise.resolve({ origin, path, checked_at: this.now().toISOString(), outcome: 'paused', detail: 'The keeper only visits listed sites for now.', cost_usd: 0, ms: 0 });
    const key = `${origin}|${path}`;
    const running = this.queue.get(key);
    if (running) return running;
    const job = this.checkNow(origin, path).finally(() => this.queue.delete(key));
    this.queue.set(key, job);
    return job;
  }

  private async checkNow(origin: string, path: string): Promise<KeeperCheck> {
    const started = performance.now();
    let cost = 0;
    const done = async (outcome: CheckOutcome, detail: string, extra: Partial<KeeperCheck> = {}): Promise<KeeperCheck> => {
      const result: KeeperCheck = { origin, path, checked_at: this.now().toISOString(), outcome, detail, cost_usd: Math.round(cost * 1e6) / 1e6, ms: Math.round(performance.now() - started), ...extra };
      await this.registry.storage.putCached('keeper-check', `${origin}|${path}`, result);
      return result;
    };
    const current = (await this.currentMaps(origin)).find((r) => r.map.path === path);
    if (!current) return done('error', 'No map for this form.');

    const robots = await (this.options.fetch ?? fetch)(`${origin}/robots.txt`).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    if (!robotsAllows(robots, path)) return done('robots', 'robots.txt asks automated visitors not to load this page.');

    const context = await (await this.getBrowser()).newContext({ viewport: VIEWPORT, userAgent: `Mozilla/5.0 (compatible; ${KEEPER_AGENT}; +${this.registry.url})`, extraHTTPHeaders: { 'Usher-Agent': 'usher-keeper' } });
    try {
      const page = await context.newPage();
      // One request per form per run: load it once, never submit.
      const res = await page.goto(origin + path, { waitUntil: 'load', timeout: 30_000 }).catch(() => null);
      if (!res || res.status() >= 400) return await done('error', res ? `HTTP ${res.status()}` : 'could not load');
      if (new URL(page.url()).pathname !== path) return await done('unreachable', 'This form is only reachable after earlier steps are submitted; the keeper never submits. Agents re-read and share it.');
      const scan: Scan = await page.evaluate(scanScript());
      // The form this map is for: the candidate with the map's fingerprint, or else the one most
      // like it (the page may hold other forms, which the map was never for).
      const candidates = await Promise.all(candidateForms(scan.forms, current.map.form.intent).map(async (f) => ({ form: f, fp: await fingerprint(f.elements) })));
      if (!candidates.length) return await done('error', 'No form to map on the page any more.');
      const { form, fp } = candidates.find((c) => c.fp.digest === current.digest) ?? candidates.sort((a, b) => similarity(b.fp.signature, current.map.fingerprint.signature) - similarity(a.fp.signature, current.map.fingerprint.signature))[0]!;
      await this.knock(page.url(), fp);
      if (fp.digest === current.digest) return await done('unchanged', 'Matches the current map.');
      // Changed back to a version we already have: restore it, no model needed.
      const earlier = await this.registry.storage.getMap(origin, fp.digest);
      if (earlier) {
        await this.registry.replaceMap(current, earlier.map);
        return await done('restored', 'The form changed back to an earlier version; that map is current again.', { from: current.digest, to: fp.digest, review: false });
      }

      // Changed. Triage cheaply, then rebuild: carry labels over if cosmetic, recompile if real.
      let verdict: { change: 'cosmetic' | 'real'; consequential_changed: boolean; summary: string } = { change: 'real', consequential_changed: true, summary: 'not triaged' };
      if (this.options.triage) {
        const result = await this.options.triage.chat({
          model: this.options.triage.model,
          temperature: 0,
          messages: [
            { role: 'system', content: TRIAGE },
            { role: 'user', content: JSON.stringify({ old: describe([...current.map.fields.map((f) => ({ kind: 'field', control: f.control, label: f.label, required: f.required })), ...current.map.actions.map((a) => ({ kind: 'action', control: a.kind, label: a.label, required: false }))]), new: describe(form.elements) }) },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'usher_triage', strict: true, schema: { type: 'object', additionalProperties: false, required: ['change', 'consequential_changed', 'summary'], properties: { change: { type: 'string', enum: ['cosmetic', 'real'] }, consequential_changed: { type: 'boolean' }, summary: { type: 'string' } } } },
          },
        });
        cost += costUsd(this.options.triage.model, result.usage) ?? 0;
        verdict = parseJsonContent(result.content) as typeof verdict;
      }

      let map: UsherMap | null = null;
      let how = '';
      if (verdict.change === 'cosmetic') {
        const labels = carryLabels(current.map, form);
        const validation = labels ? validateLabels(labels, form.elements) : null;
        if (validation?.ok) {
          map = mergeMap({ form: form as ScannedForm, fingerprint: fp, validation, origin, path, provenance: { source: 'compiled', compiler: `keeper (labels carried over from ${current.digest.slice(0, 19)}…)`, created_at: this.now().toISOString(), verified: false } });
          how = 'labels carried over';
        }
      }
      if (!map) {
        if (!this.options.compiler) return await done('no_model', `Changed (${verdict.summary}) but no model is configured to rebuild it.`, { from: current.digest });
        const compiled = await compilePage(page, { chat: this.options.compiler.chat, model: this.options.compiler.model, formIndex: form.index });
        cost += compiled.cost_usd ?? 0;
        map = compiled.map;
        how = `recompiled with ${compiled.model}`;
      }
      // Keep the edges the old version had: the way forward still leads where it did.
      const edges = new Map(current.map.actions.filter((a) => a.leads_to).map((a) => [a.key, a.leads_to!]));
      map = { ...map, actions: map.actions.map((a) => (edges.has(a.key) && !a.leads_to ? { ...a, leads_to: edges.get(a.key)! } : a)) };
      const consequential = (m: UsherMap) => [...m.fields, ...m.actions].filter((e) => e.risk !== 'safe').map((e) => `${e.key}:${e.risk}`).sort().join(',');
      const review = verdict.consequential_changed || consequential(map) !== consequential(current.map);
      await this.registry.replaceMap(current, map);
      return await done(verdict.change === 'cosmetic' && how === 'labels carried over' ? 'cosmetic' : 'rebuilt', `${verdict.summary} Rebuilt: ${how}.`, { from: current.digest, to: map.fingerprint.digest, review });
    } catch (err) {
      return await done('error', err instanceof Error ? err.message.split('\n')[0]!.slice(0, 200) : String(err));
    } finally {
      await context.close();
    }
  }
}

