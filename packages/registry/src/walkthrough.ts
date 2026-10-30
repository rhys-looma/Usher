// The walkthrough mapper ("Map my site"). For a site whose owner is signed in (or, on the public
// demo site, the operator), Usher's own browser walks the journey from a start page on the site's
// claimed origin. On each page it:
//
// - knocks as the agent "walkthrough:<host>";
// - tries every option of the page's radios and selects (the first twelve), noting what each one
//   shows or hides, which becomes shown_if, and puts the page in the state that shows the most;
// - labels it with Muse Spark in vote mode;
// - runs the site's lookups with the test values and records the lists they reveal (as counts);
// - fills the fields with the test values (and a harmless stand-in for a required field none covers)
//   and goes on, until the result page or a consequential action the owner didn't allow.
//
// The result is a proposal (maps, a plan, and a masked screenshot per page with every element's box)
// that waits for the owner to publish it.
//
// Test values live in this run's memory only. They are never stored, logged, sent to the model or
// put in an error message, and are dropped when the run ends. Every screenshot and every frame masks
// inputs, selects and chosen options, so no value is in any image. One run per site per UTC day,
// within the registry's daily model budget.

import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import { compilePage, composePlan, dismissConsent, parseJsonContent, fillField, generateAgentIdentity, LOOKUP_FILLS, locate, mainForm, matchOption, mapSchemaErrors, scanScript, signRequest, VIEWPORT, type AgentIdentity, type ChatFn, type MapField, type Scan, type ScannedForm, type UsherMap, type UsherPlan } from '@usher/core';
import { publicHost } from '@usher/core/public-fetch';
import { knockRequest } from './client.ts';
import type { Registry } from './registry.ts';
import { standIn, TEST_PERSON, testStartDate } from './walkthrough-persona.ts';

export type WalkthroughStatus = 'running' | 'completed' | 'stopped' | 'failed' | 'cancelled';
export type TestValues = Record<string, string | boolean>;

/** What an option of a radio or select shows: the fields that appear when it is chosen. */
export interface Condition {
  /** The control's key in the page's map, and the option's value. */
  field: string;
  value: string;
  label: string;
  reveals: string[];
}

export interface WalkthroughPage {
  path: string;
  title: string;
  /** The page's map, with each element's box. */
  map: UsherMap;
  /** A full-page PNG, base64, inputs and chosen options masked: no value is in it. */
  screenshot: string;
  width: number;
  height: number;
  conditions: Condition[];
  /** Fields only another option shows (an exclusive branch): seen, not mapped in this run. */
  unexplored: string[];
  /** Lists that appeared when a lookup ran or a combobox opened: counts, not their entries. */
  lists: { label: string; options: number; via: string }[];
  leads_to?: string;
}

export interface WalkthroughRun {
  id: string;
  origin: string;
  start: string;
  by: 'owner' | 'operator';
  status: WalkthroughStatus;
  reason?: string;
  started_at: string;
  finished_at?: string;
  pages: WalkthroughPage[];
  plan?: UsherPlan | null;
  cost_usd: number;
  /** The step log, in plain words; never a value. */
  log: string[];
  /** Against the maps the registry serves now, per page: keys added, removed or changed. */
  diff?: { path: string; added: string[]; removed: string[]; changed: string[] }[];
  published_at?: string;
}

export type WalkthroughEvent = { type: 'log'; text: string } | { type: 'frame'; data: string } | { type: 'done'; status: WalkthroughStatus; reason?: string };

/** A chat edit, proposed and waiting for the owner. */
export interface EditProposal {
  id: string;
  /** The run it is for: a new run makes it stale. */
  run: string;
  text: string;
  changes: { path: string; id: string; element: string; before: { key: string; risk: string; label: string }; key?: string; risk?: string; label?: string; why: string }[];
  /** What the model or the checks would not do, in words. */
  refused: string[];
  /** A site rule in the request, for the rules page rather than the map. */
  rules: string | null;
  /** What the model could not work out. */
  unclear: string | null;
  done?: boolean;
}

export const EDIT_SYSTEM = `You help a website owner correct Usher's proposed map of their form. Usher maps each form element to a semantic key (dotted lowercase words, such as person.first_name, person.smoker, consent.marketing, or custom.<snake_case> when nothing fits) and a risk: safe (an assistant may fill it freely), consequential (it has an effect the person should know about; the person confirms), needs_user (the person must answer it themselves).
You get the proposal, page by page, as elements with an id, label, control, key and risk, and one request from the owner in plain words. Return the changes that request asks for, each naming the page path and element id exactly as given, with the new key, risk or label (null for anything that stays the same) and a short reason. Change only what the owner asked about; if the request covers every page ("everywhere", "on every page"), include each matching element. Never invent ids.
If part of the request is a rule about who may answer or what agents may do on the site, not a correction to a label (for example "only my customers answer medical questions", "agents may never tick marketing consent"), put it in rules, in one sentence, and change nothing for it. If you cannot tell what the owner means, say what is unclear in unclear and return no changes.`;

export const EDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['changes', 'rules', 'unclear'],
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'id', 'key', 'risk', 'label', 'why'],
        properties: {
          path: { type: 'string' },
          id: { type: 'string' },
          key: { type: ['string', 'null'] },
          risk: { type: ['string', 'null'], enum: ['safe', 'consequential', 'needs_user', null] },
          label: { type: ['string', 'null'] },
          why: { type: 'string' },
        },
      },
    },
    rules: { type: ['string', 'null'] },
    unclear: { type: ['string', 'null'] },
  },
};

export interface WalkthroughOptions {
  registry: Registry;
  browser: () => Promise<Browser>;
  /** Muse Spark, within the registry's daily cap. */
  compiler?: { chat: ChatFn; model: string };
  spend: { today: () => Promise<number>; cap: number };
  /** Runs a site may start per UTC day (default 1). */
  dailyLimit?: (origin: string) => number;
  /** What a run is allowed to cost before it starts, to check against the cap. */
  estimateUsd?: number;
  /** Milliseconds between live frames while someone is watching. */
  frameMs?: number;
  /** Most pages one run walks. */
  maxPages?: number;
  /** Let runs reach private addresses (local development and tests only). */
  allowPrivate?: boolean;
  /** Where corrections and compile requests are logged (the compiler log); null for none. */
  logDir?: string | null;
  now?: () => Date;
}

interface Live {
  run: WalkthroughRun;
  listeners: Set<(e: WalkthroughEvent) => void>;
  cancelled: boolean;
}

const ADVANCE = ['form.submit', 'search.submit', 'nav.next', 'form.purchase'];
const MAX_CONTROLS = 12;
const MAX_OPTIONS = 8;
/** Inputs, selects, text areas and chosen options: masked in every screenshot and frame. */
/** What every walkthrough image greys out: anything that can hold or show an answer. */
export const MASK = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), select, textarea, label:has(input:checked), [aria-checked="true"], [aria-selected="true"]';

/**
 * A site's own pages only: Usher's browser never follows the site off its origin. And, as for the
 * viewer and hosted MCP, every request (page, redirect, script, frame) must reach a public address.
 */
export async function ownPagesOnly(context: BrowserContext, origin: string): Promise<void> {
  const verdicts = new Map<string, Promise<boolean>>();
  await context.route('**/*', async (route) => {
    const target = new URL(route.request().url());
    if (route.request().isNavigationRequest() && !route.request().frame().parentFrame() && target.origin !== origin) return route.abort('blockedbyclient');
    if (!verdicts.has(target.hostname)) verdicts.set(target.hostname, publicHost(target.hostname));
    return (await verdicts.get(target.hostname)) ? route.continue() : route.abort('blockedbyclient');
  });
}

/** A field's identity across scans: its name, else its id, else control and label. */
const identityOf = (e: { name?: string; domId?: string; control?: string | null; label: string }) => e.name ?? e.domId ?? `${e.control}:${e.label}`;
const identityOfMapField = (f: MapField) => f.locators.find((l) => l.by === 'name')?.value ?? f.locators.find((l) => l.by === 'id')?.value ?? `${f.control}:${f.label}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export class Walkthroughs {
  private readonly live = new Map<string, Live>();
  private readonly now: () => Date;

  constructor(private readonly o: WalkthroughOptions) {
    this.now = o.now ?? (() => new Date());
  }

  private get storage() {
    return this.o.registry.storage;
  }
  private day() {
    return this.now().toISOString().slice(0, 10);
  }

  /** Why a run can't start now, or null. */
  async refusal(origin: string, start: string): Promise<string | null> {
    const site = await this.storage.getSite(origin);
    // A site Usher's admin listed (only the admin can open its dashboard) may be walked too, read-only:
    // the walk stops before the final step there (start).
    if (!site?.claim && origin !== this.o.registry.demoOrigin && !(await this.o.registry.listedSites()).some((l) => l.origin === origin)) return 'This site has not proved it controls its address yet.';
    let url: URL;
    try {
      url = new URL(start);
    } catch {
      return 'The start page is not an address.';
    }
    if (url.origin !== origin) return `The start page must be on ${origin}.`;
    if (!this.o.compiler) return 'This registry has no model to label pages with.';
    if ([...this.live.values()].some((l) => l.run.origin === origin && l.run.status === 'running')) return 'A walkthrough of this site is already running.';
    const limit = this.o.dailyLimit?.(origin) ?? 1;
    const used = (await this.storage.getCached<{ n: number }>('walkthrough-runs', `${origin}|${this.day()}`))?.n ?? 0;
    if (used >= limit) return `One walkthrough per site per day${limit > 1 ? ` (this site: ${limit})` : ''}; the next can start after midnight UTC.`;
    const spent = await this.o.spend.today();
    if (spent + (this.o.estimateUsd ?? 0.6) > this.o.spend.cap) return `Today's model budget ($${this.o.spend.cap}) can't cover a walkthrough; it resets at midnight UTC.`;
    return null;
  }

  /** Starts a run; values are held in this run's memory only. */
  async start(input: { origin: string; start: string; values?: TestValues; generated?: boolean; pressFinal: boolean; by: 'owner' | 'operator' }): Promise<{ id: string } | { refused: string }> {
    const refused = await this.refusal(input.origin, input.start);
    if (refused) return { refused };
    const key = `${input.origin}|${this.day()}`;
    await this.storage.putCached('walkthrough-runs', key, { n: ((await this.storage.getCached<{ n: number }>('walkthrough-runs', key))?.n ?? 0) + 1 });
    const run: WalkthroughRun = { id: `w_${randomUUID().replace(/-/g, '').slice(0, 16)}`, origin: input.origin, start: input.start, by: input.by, status: 'running', started_at: this.now().toISOString(), pages: [], cost_usd: 0, log: [] };
    const live: Live = { run, listeners: new Set(), cancelled: false };
    this.live.set(run.id, live);
    // The owner's values or the generated person, for this run only.
    const values: TestValues = { ...(input.generated ? { ...TEST_PERSON, 'policy.start_date': testStartDate(this.now()) } : {}), ...(input.values ?? {}) };
    // Usher never submits to a site that hasn't joined: on a listed site the walk maps every page
    // and stops before the final step, whatever was ticked.
    const joined = Boolean((await this.storage.getSite(input.origin))?.claim) || input.origin === this.o.registry.demoOrigin;
    if (input.pressFinal && !joined) run.log.push('This site has not joined Usher, so the walk stops before the final step: Usher never submits to it.');
    void this.walk(live, values, input.pressFinal && joined).finally(() => this.live.delete(run.id));
    return { id: run.id };
  }

  /** The run as it stands: live while it runs, else the last one stored for the site. */
  async get(origin: string): Promise<WalkthroughRun | null> {
    const running = [...this.live.values()].find((l) => l.run.origin === origin);
    return running?.run ?? (await this.storage.getCached<WalkthroughRun>('walkthrough', origin)) ?? null;
  }

  /** Live events for a run: the log so far, then each new line, frame and the end. */
  subscribe(origin: string, id: string, listener: (e: WalkthroughEvent) => void): (() => void) | null {
    const live = this.live.get(id);
    if (!live || live.run.origin !== origin) return null;
    for (const text of live.run.log) listener({ type: 'log', text });
    live.listeners.add(listener);
    return () => live.listeners.delete(listener);
  }

  cancel(origin: string, id: string): boolean {
    const live = this.live.get(id);
    if (!live || live.run.origin !== origin) return false;
    live.cancelled = true;
    return true;
  }

  /** The owner publishes the proposal: each page's map becomes the one agents get. */
  async publish(origin: string): Promise<number> {
    const run = await this.storage.getCached<WalkthroughRun>('walkthrough', origin);
    if (!run || run.status === 'running' || !run.pages.length) return 0;
    for (const page of run.pages) {
      const map = withoutBoxes(page.map);
      await this.o.registry.addMap({ ...map, provenance: { ...map.provenance, source: 'site', verified: true } });
      await this.o.registry.verifyMap(origin, map.fingerprint.digest, 'keeper', 'owner walkthrough');
    }
    await this.storage.putCached('walkthrough', origin, { ...run, published_at: this.now().toISOString() });
    return run.pages.length;
  }

  /** An owner's correction to one element of the proposal: applied, and logged beside the model's answer. */
  async correct(origin: string, path: string, id: string, change: { key?: string; risk?: string; label?: string }): Promise<string | null> {
    const run = await this.storage.getCached<WalkthroughRun>('walkthrough', origin);
    const page = run?.pages.find((p) => p.path === path);
    const el = page && [...page.map.fields, ...page.map.actions].find((e) => e.id === id);
    if (!run || !page || !el) return 'No such element in the last walkthrough.';
    if (change.key !== undefined && !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(change.key)) return 'A key is dotted lowercase words, like person.first_name or custom.how_did_you_hear.';
    if (change.risk !== undefined && !['safe', 'consequential', 'needs_user'].includes(change.risk)) return 'Risk is safe, consequential or needs_user.';
    const before = { key: el.key, risk: el.risk, label: el.label };
    Object.assign(el, { ...(change.key && { key: change.key }), ...(change.risk && { risk: change.risk }), ...(change.label && { label: change.label.slice(0, 200) }) });
    if (mapSchemaErrors(page.map)) {
      Object.assign(el, before);
      return 'That change would make the map invalid.';
    }
    await this.storage.putCached('walkthrough', origin, run);
    // Training data: the owner's answer beside the model's, structure only (W4).
    // The element as a small model would see it (finetune:export builds its example from this).
    const all = [...page.map.fields, ...page.map.actions];
    const at = all.indexOf(el);
    const describe = (e: (typeof all)[number]) => `${'control' in e ? e.control : 'action'}: ${e.label}`;
    const options = 'options' in el && el.options ? `${el.options.total} options: ${el.options.items.slice(0, 8).map((o) => o.label).join(', ')}${el.options.total > 8 ? ', …' : ''}` : null;
    const element = { id, kind: 'control' in el ? 'field' : 'action', control: 'control' in el ? el.control : null, label: before.label, required: 'required' in el ? el.required : false, options, constraints: 'constraints' in el && el.constraints ? el.constraints : null, neighbours: { before: all.slice(Math.max(0, at - 2), at).map(describe), after: all.slice(at + 1, at + 3).map(describe) } };
    const entry = { ts: this.now().toISOString(), task: 'correction', owner_verified: true, origin, site: origin, path, url: `${origin}${path}`, page_title: page.title, form_purpose: page.map.form.purpose, fingerprint: page.map.fingerprint.digest, element, model: before, owner: { key: el.key, risk: el.risk, label: el.label } };
    await this.storage.appendLog('corrections', entry);
    if (this.o.logDir) {
      const { appendLog } = await import('@usher/core');
      await appendLog(this.o.logDir, entry, this.now()).catch(() => undefined);
    }
    return null;
  }

  /**
   * The chat editor: the owner says what to change in words ("the smoker question is the person's
   * own on every page"), Muse Spark proposes changes to the elements by id, and code checks each one
   * the way a row correction is checked. Nothing changes until the owner accepts; accepted changes
   * go through correct(), so each is logged as an owner-verified label. The model sees structure
   * only (ids, labels, controls, keys, risks) and the owner's sentence, never a value.
   */
  async proposeEdits(origin: string, text: string): Promise<EditProposal | string> {
    const run = await this.storage.getCached<WalkthroughRun>('walkthrough', origin);
    if (!run?.pages.length || run.status === 'running') return 'There is no finished walkthrough to change yet.';
    const words = text.trim().slice(0, 1000);
    if (!words) return 'Say what to change.';
    if (!this.o.compiler) return 'This registry has no model to read the request with.';
    const spent = await this.o.spend.today();
    if (spent + 0.05 > this.o.spend.cap) return `Today's model budget ($${this.o.spend.cap}) is spent; it resets at midnight UTC.`;
    const pages = run.pages.map((p) => ({ path: p.path, title: p.title, elements: [...p.map.fields, ...p.map.actions].map((e) => ({ id: e.id, label: e.label, control: 'control' in e ? e.control : e.kind, key: e.key, risk: e.risk })) }));
    const result = await this.o.compiler.chat({
      model: this.o.compiler.model,
      temperature: 0,
      messages: [
        { role: 'system', content: EDIT_SYSTEM },
        { role: 'user', content: `The proposal:\n${JSON.stringify(pages)}\n\nThe owner says: ${words}` },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'usher_edits', strict: true, schema: EDIT_SCHEMA } },
    });
    const answer = parseJsonContent(result.content) as { changes?: { path: string; id: string; key: string | null; risk: string | null; label: string | null; why: string }[]; rules?: string | null; unclear?: string | null };
    const changes: EditProposal['changes'] = [];
    const refused: string[] = [];
    for (const c of answer.changes ?? []) {
      const page = run.pages.find((p) => p.path === c.path);
      const el = page && [...page.map.fields, ...page.map.actions].find((e) => e.id === c.id);
      if (!page || !el) {
        refused.push(`an element that isn't in the walkthrough (${c.path} ${c.id})`);
        continue;
      }
      const change = { ...(c.key && c.key !== el.key && { key: c.key }), ...(c.risk && c.risk !== el.risk && { risk: c.risk }), ...(c.label && c.label !== el.label && { label: c.label.slice(0, 200) }) };
      if (!Object.keys(change).length) continue;
      if (change.key && !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(change.key)) {
        refused.push(`"${el.label}": ${change.key} is not a key`);
        continue;
      }
      if (change.risk && !['safe', 'consequential', 'needs_user'].includes(change.risk)) {
        refused.push(`"${el.label}": ${change.risk} is not a risk`);
        continue;
      }
      changes.push({ path: c.path, id: c.id, element: el.label || el.key, before: { key: el.key, risk: el.risk, label: el.label }, ...change, why: String(c.why ?? '').slice(0, 300) });
    }
    const proposal: EditProposal = { id: `e_${randomUUID().replace(/-/g, '').slice(0, 12)}`, run: run.id, text: words, changes, refused, rules: answer.rules?.trim() || null, unclear: answer.unclear?.trim() || null };
    await this.storage.putCached('walkthrough-edit', origin, proposal);
    return proposal;
  }

  /** The proposal as it waits for the owner, if it is for the current run. */
  async pendingEdits(origin: string): Promise<EditProposal | null> {
    const [proposal, run] = await Promise.all([this.storage.getCached<EditProposal>('walkthrough-edit', origin), this.storage.getCached<WalkthroughRun>('walkthrough', origin)]);
    return proposal && run && proposal.run === run.id && !proposal.done ? proposal : null;
  }

  /** The owner accepts: each change applied as a correction. Returns what could not be applied. */
  async applyEdits(origin: string, id: string): Promise<{ applied: number; failed: string[] } | string> {
    const proposal = await this.pendingEdits(origin);
    if (!proposal || proposal.id !== id) return 'That change is no longer waiting: start again from the walkthrough.';
    let applied = 0;
    const failed: string[] = [];
    for (const c of proposal.changes) {
      const failure = await this.correct(origin, c.path, c.id, { ...(c.key && { key: c.key }), ...(c.risk && { risk: c.risk }), ...(c.label && { label: c.label }) });
      if (failure) failed.push(`"${c.element}": ${failure}`);
      else applied++;
    }
    await this.storage.putCached('walkthrough-edit', origin, { ...proposal, done: true });
    return { applied, failed };
  }

  async discardEdits(origin: string): Promise<void> {
    const proposal = await this.pendingEdits(origin);
    if (proposal) await this.storage.putCached('walkthrough-edit', origin, { ...proposal, done: true });
  }

  // ---------------------------------------------------------------------------------------------

  private async walk(live: Live, values: TestValues, pressFinal: boolean): Promise<void> {
    const { run } = live;
    const emit = (e: WalkthroughEvent) => {
      for (const l of live.listeners) l(e);
    };
    const say = (text: string) => {
      run.log.push(text);
      emit({ type: 'log', text });
    };
    // The end is decided here and announced only once the run is stored, plan and all.
    let ending: { status: WalkthroughStatus; reason?: string } | null = null;
    const finish = async (status: WalkthroughStatus, reason?: string) => {
      ending = { status, ...(reason && { reason }) };
    };
    const host = new URL(run.origin).host;
    const browser = await this.o.browser();
    const context = await browser.newContext({ viewport: VIEWPORT });
    if (!this.o.allowPrivate) await ownPagesOnly(context, run.origin);
    const page = await context.newPage();
    // No single step may stall the run: a control that never answers is skipped.
    page.setDefaultTimeout(8_000);
    let framing = false;
    const frames = setInterval(async () => {
      if (!live.listeners.size || framing) return;
      framing = true;
      try {
        const jpeg = await page.screenshot({ type: 'jpeg', quality: 45, mask: [page.locator(MASK)], maskColor: '#c9ccd4' });
        emit({ type: 'frame', data: jpeg.toString('base64') });
      } catch {
        // Between pages: the next frame will do.
      }
      framing = false;
    }, this.o.frameMs ?? 400);
    const identity: AgentIdentity = (await generateAgentIdentity()).identity;
    const knock = async (url: string, intent?: string, session?: string, confirmed?: string[]) => {
      const reply = await this.o.registry.knock(await signRequest(knockRequest({ url, ...(intent && { intent }), ...(session && { session }), ...(confirmed && { confirmed }) }), identity), null, { walkthrough: host });
      return reply.status < 300 ? (reply.body as { token: string; session: string }) : null;
    };
    try {
      say(`Opening ${run.start}.`);
      await page.goto(run.start, { waitUntil: 'load', timeout: 30_000 });
      let session: string | undefined;
      for (let step = 1; step <= (this.o.maxPages ?? 10); step++) {
        if (live.cancelled) return await finish('cancelled', 'Cancelled by the owner.');
        const path = new URL(page.url()).pathname;
        const title = await page.title();
        let scan: Scan = await page.evaluate(scanScript());
        let form = mainForm(scan.forms);
        if (!form || !form.elements.some((e) => e.kind === 'field' && e.visible)) {
          say(`${title || path}: no form to fill. The journey ends here.`);
          break;
        }
        say(`Extracting ${title || path}: ${plural(form.elements.filter((e) => e.visible).length, 'visible element')}.`);

        // A cookie banner first, with the least consent, so nothing covers the page.
        const consent = await dismissConsent(page, []);
        if (consent.length) say(`Cookie banner: pressed ${consent.map((c) => `"${c}"`).join(', then ')}.`);
        // Every option of each radio and select, to see what it shows.
        const explored = await this.explore(page, form, say, () => live.cancelled);
        scan = await page.evaluate(scanScript());
        form = mainForm(scan.forms) ?? form;

        say(`Labelling with ${this.o.compiler!.model} (vote mode).`);
        const compiled = await compilePage(page, { chat: this.o.compiler!.chat, model: this.o.compiler!.model, vote: true, boxes: true, logDir: this.o.logDir ?? null });
        run.cost_usd += compiled.cost_usd ?? 0;
        const map = compiled.map;
        say(`${plural(map.fields.length + map.actions.length, 'element')} labelled in ${plural(compiled.votes?.runs ?? 1, 'run')}${compiled.votes?.disagreements ? `; the runs disagreed on ${plural(compiled.votes.disagreements, 'element')}` : ''}.`);

        // What each option shows becomes shown_if, written by code from what was seen.
        const conditions: Condition[] = [];
        for (const c of explored.conditions) {
          const controller = map.fields.find((f) => identityOfMapField(f) === c.controller);
          if (!controller) continue;
          conditions.push({ field: controller.key, value: c.value, label: c.label, reveals: c.reveals });
          for (const f of map.fields) if (c.reveals.includes(identityOfMapField(f)) && f !== controller) f.shown_if = { field: controller.key, op: 'equals', value: c.value };
        }
        if (mapSchemaErrors(map)) for (const f of map.fields) delete f.shown_if;

        const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
        const screenshot = (await page.screenshot({ type: 'png', fullPage: true, mask: [page.locator(MASK)], maskColor: '#c9ccd4' })).toString('base64');

        const token = await knock(page.url(), map.form.intent, session);
        if (token) {
          session = token.session;
          await page.evaluate((t) => (window as unknown as { usher?: { bind?: (t: string) => unknown } }).usher?.bind?.(t), token.token).catch(() => undefined);
          say('Knocked as the walkthrough agent: the site opened this page for it.');
        }

        const lists = await this.lists(page, map, values, say);
        const filled = await this.fill(page, map, values);
        say(`Filled ${plural(filled, 'field')} with the test values.`);

        const record: WalkthroughPage = { path, title, map, screenshot, width: size.width, height: size.height, conditions, unexplored: explored.unexplored, lists };
        run.pages.push(record);

        const advance = map.actions.find((a) => a.key === 'form.submit' || a.key === 'search.submit') ?? map.actions.find((a) => ADVANCE.includes(a.key));
        if (!advance) {
          await finish('stopped', `No way forward on ${path}.`);
          break;
        }
        if (advance.risk !== 'safe' && !pressFinal) {
          await finish('stopped', `Stopped before "${advance.label}": pressing it wasn't allowed for this run.`);
          break;
        }
        if (advance.risk !== 'safe') {
          const confirmed = await knock(page.url(), map.form.intent, session, [advance.key]);
          if (confirmed) {
            await page.evaluate((t) => (window as unknown as { usher?: { bind?: (t: string) => unknown } }).usher?.bind?.(t), confirmed.token).catch(() => undefined);
            await page.evaluate((k) => (window as unknown as { usher?: { confirm?: (k: string) => unknown } }).usher?.confirm?.(k), advance.key).catch(() => undefined);
          }
        }
        const target = await locate(page, advance);
        if (!target) {
          await finish('failed', `"${advance.label}" could not be found on ${path}.`);
          break;
        }
        say(`Pressing "${advance.label}".`);
        const before = page.url();
        await target.first().click({ timeout: 10_000 }).catch(() => undefined);
        await page.waitForURL((u) => u.toString() !== before, { timeout: 15_000 }).catch(() => undefined);
        await page.waitForLoadState('load').catch(() => undefined);
        if (page.url() === before) {
          await finish('failed', `${path} did not move on after "${advance.label}": the site may have refused a test value.`);
          break;
        }
        const next = new URL(page.url()).pathname;
        advance.leads_to = next;
        record.leads_to = next;
        say(`Next: ${next}.`);
      }
      if (!ending) await finish(run.pages.length ? 'completed' : 'stopped', run.pages.length ? undefined : 'No form on the start page.');
    } catch (err) {
      // The reason in words; never a value (fills fail by key and label only).
      await finish('failed', err instanceof Error ? err.message.split('\n')[0]!.replace(/:\s*$/, '').slice(0, 200) : 'The walkthrough failed.');
    } finally {
      clearInterval(frames);
      await context.close().catch(() => undefined);
      if (run.pages.length) {
        const maps = new Map(run.pages.map((p) => [p.path, withoutBoxes(p.map)]));
        run.plan = composePlan(run.pages[0]!.path, maps);
        const current = await this.o.registry.currentMaps(run.origin);
        run.diff = run.pages.map((p) => diffMaps(p.path, current.get(p.path), p.map));
      }
      const end: { status: WalkthroughStatus; reason?: string } = ending ?? { status: 'failed', reason: 'The walkthrough stopped unexpectedly.' };
      run.status = end.status;
      if (end.reason) run.reason = end.reason;
      run.finished_at = this.now().toISOString();
      await this.storage.putCached('walkthrough', run.origin, run);
      emit({ type: 'done', status: end.status, ...(end.reason && { reason: end.reason }) });
    }
  }

  /** Each radio and select in turn: every option tried, what it shows recorded, the best left chosen. */
  private async explore(page: Page, form: ScannedForm, say: (t: string) => void, cancelled: () => boolean) {
    const conditions: { controller: string; value: string; label: string; reveals: string[] }[] = [];
    const unexplored = new Set<string>();
    const visible = async () => {
      const scan: Scan = await page.evaluate(scanScript());
      const main = mainForm(scan.forms);
      return new Map((main?.elements ?? []).filter((e) => e.kind === 'field' && e.visible).map((e) => [identityOf(e), e.label]));
    };
    const controls = form.elements.filter((e) => e.kind === 'field' && e.visible && (e.control === 'radio' || e.control === 'select' || e.control === 'buttons') && e.options?.items.length).slice(0, MAX_CONTROLS);
    for (const c of controls) {
      if (cancelled()) break;
      const asField = { id: c.id, key: 'custom.explore', label: c.label, control: c.control!, required: false, risk: 'safe' as const, locators: c.locators ?? [], ...(c.options && { options: c.options }) } as MapField;
      const base = await visible();
      const tried: { value: string; label: string; reveals: string[]; labels: string[] }[] = [];
      for (const option of c.options!.items.slice(0, MAX_OPTIONS)) {
        const ok = await fillField(page, asField, option.value).then(() => true, () => false);
        if (!ok) continue;
        await page.waitForTimeout(400);
        const now = await visible();
        const reveals = [...now.keys()].filter((k) => !base.has(k));
        tried.push({ value: option.value, label: option.label, reveals, labels: reveals.map((k) => now.get(k)!) });
      }
      const opening = tried.filter((t) => t.reveals.length);
      for (const t of opening) {
        conditions.push({ controller: identityOf(c), value: t.value, label: t.label, reveals: t.reveals });
        say(`Trying "${t.label}" on "${c.label}": ${plural(t.reveals.length, 'new field')}.`);
      }
      // Leave the option that shows the most; what only the others show is noted, not mapped.
      const best = opening.sort((a, b) => b.reveals.length - a.reveals.length)[0];
      if (best) {
        await fillField(page, asField, best.value).catch(() => undefined);
        await page.waitForTimeout(400);
        for (const t of opening) if (t !== best) t.labels.filter((l, i) => !best.reveals.includes(t.reveals[i]!)).forEach((l) => unexplored.add(l));
      }
    }
    return { conditions, unexplored: [...unexplored] };
  }

  /** Lookups run with the test values, and comboboxes opened: the lists they show, as counts. */
  private async lists(page: Page, map: UsherMap, values: TestValues, say: (t: string) => void) {
    const found: WalkthroughPage['lists'] = [];
    const selects = async () => {
      const scan: Scan = await page.evaluate(scanScript());
      return (mainForm(scan.forms)?.elements ?? []).filter((e) => e.control === 'select' && e.visible);
    };
    for (const action of map.actions.filter((a) => a.key.startsWith('lookup.'))) {
      const spec = LOOKUP_FILLS[action.key];
      const input = spec && map.fields.find((f) => f.key === spec.input);
      const value = spec && values[spec.input];
      if (!input || value === undefined) continue;
      await fillField(page, input, value).catch(() => undefined);
      const before = new Set((await selects()).map(identityOf));
      const target = await locate(page, action);
      await target?.first().click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
      for (const list of (await selects()).filter((s) => !before.has(identityOf(s)))) {
        found.push({ label: list.label, options: list.options?.total ?? 0, via: action.label });
        say(`"${action.label}": a list of ${plural(list.options?.total ?? 0, 'entry', 'entries')} appears.`);
        // Choose the entry for the test address (by its first line), else the first, so the page can go on.
        const line1 = typeof values['address.line1'] === 'string' ? (values['address.line1'] as string).toLowerCase() : '';
        const pick = list.options?.items.find((o) => line1 && o.label.toLowerCase().startsWith(line1)) ?? list.options?.items[0];
        if (pick && list.locators?.length) await fillField(page, { id: list.id, key: 'custom.lookup_result', label: list.label, control: 'select', required: false, risk: 'safe', locators: list.locators, ...(list.options && { options: list.options }) } as MapField, pick.value).catch(() => undefined);
      }
    }
    const boxes = page.locator('[role="combobox"]');
    for (let i = 0; i < Math.min(await boxes.count(), 5); i++) {
      const box = boxes.nth(i);
      if (!(await box.isVisible().catch(() => false))) continue;
      await box.click({ timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(400);
      const options = await page.locator('[role="option"]:visible').count();
      await page.keyboard.press('Escape').catch(() => undefined);
      if (options) found.push({ label: (await box.getAttribute('aria-label')) ?? 'combobox', options, via: 'combobox' });
    }
    return found;
  }

  /** The test values into the page's fields, in order, where their conditions hold. */
  private async fill(page: Page, map: UsherMap, values: TestValues): Promise<number> {
    let filled = 0;
    const chosen = new Map<string, string | boolean>();
    for (const f of map.fields) {
      // A required field no test value covers gets a harmless stand-in, so the site doesn't refuse the page.
      let value = values[f.key] ?? standIn(f, this.now());
      if (value === undefined) continue;
      // A test answer the site has no option for: its first real option, so the journey goes on.
      const items = f.options?.items;
      if (items?.length && (f.control === 'select' || f.control === 'radio' || f.control === 'buttons') && !matchOption(items, value)) {
        const first = items.find((o) => o.value !== '' && !/^(please )?(select|choose)/i.test(o.label));
        if (!first) continue;
        value = first.value;
      }
      if (f.shown_if && f.shown_if.op === 'equals' && chosen.get(f.shown_if.field) !== undefined && String(chosen.get(f.shown_if.field)) !== f.shown_if.value) continue;
      const target = await locate(page, f);
      if (!target || !(await target.first().isVisible().catch(() => true))) continue;
      if (await fillField(page, f, value).then(() => true, () => false)) {
        filled++;
        chosen.set(f.key, f.options ? (f.options.items.find((o) => o.value === value || o.label.toLowerCase() === String(value).toLowerCase())?.value ?? value) : value);
      }
    }
    return filled;
  }
}

/** A map without its boxes: what agents are served. */
export function withoutBoxes(map: UsherMap): UsherMap {
  return { ...map, fields: map.fields.map(({ box: _b, ...f }) => f), actions: map.actions.map(({ box: _b, ...a }) => a) };
}

function diffMaps(path: string, current: UsherMap | undefined, proposed: UsherMap) {
  const keyed = (m: UsherMap | undefined) => new Map([...(m?.fields ?? []), ...(m?.actions ?? [])].map((e) => [e.label, `${e.key}|${e.risk}`]));
  const before = keyed(current);
  const after = keyed(proposed);
  return {
    path,
    added: [...after.keys()].filter((l) => !before.has(l)),
    removed: [...before.keys()].filter((l) => !after.has(l)),
    changed: [...after.keys()].filter((l) => before.has(l) && before.get(l) !== after.get(l)),
  };
}
