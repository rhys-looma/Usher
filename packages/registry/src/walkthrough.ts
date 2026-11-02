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
// An owner's run is a conversation. Where a walk would end (a page with no form, a journey's last
// button, a page that won't move on) Usher stops and asks, offering the site's declared journeys and
// the page's own links. The owner picks one, clicks the live page, or says what they want in words:
// Muse Spark turns the words into one of those moves (a choice by id, a path on the site, finish or
// wait); code checks it and code moves the browser. Every top-level navigation stays on the site's
// origin, whoever asks for it, and nothing but a plain read (GET) leaves for another host, except to
// this registry (the site script's own calls). Clicks are for sites that have joined only: Usher
// never presses anything on a site that hasn't. A run lasts at most 45 minutes, reads the owner's
// words at most 40 times, and only a few run at once. Usher's admin (signed in with the admin key)
// has none of the per-site, per-run or per-day limits: only the registry's daily spend cap, the run
// time (three hours) and the browser's rules, which are the same for everyone.
//
// Test values live in this run's memory only. They are never stored, logged, sent to the model or
// put in an error message, and are dropped when the run ends. Every screenshot and every frame masks
// inputs, selects and chosen options, so no value is in any image. One run per site per UTC day,
// within the registry's daily model budget.

import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import { compilePage, composePlan, costUsd, dismissConsent, parseJsonContent, fillField, generateAgentIdentity, LOOKUP_FILLS, locate, mainForm, matchOption, mapSchemaErrors, scanScript, signRequest, VIEWPORT, type AgentIdentity, type ChatFn, type MapField, type Scan, type ScannedForm, type UsherMap, type UsherPlan } from '@usher/core';
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
  /** Against the published map: elements it didn't have, and (in a fresh run) ones labelled differently. */
  status?: Record<string, 'new' | 'changed'>;
}

/** A line of the conversation: Usher's words (with its choices while it waits), or the owner's. */
export interface ChatMessage {
  from: 'usher' | 'owner';
  text: string;
  at: string;
  /** Where Usher can go next, while it waits for the owner. */
  options?: Choice[];
  /** The pages this is about (indexes into the run's pages), shown as thumbnails. */
  pages?: number[];
}

/** A place Usher can go next: a declared journey or a link on the page, always on the site. */
export interface Choice {
  id: string;
  label: string;
  path: string;
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
  /** The conversation with the owner (an owner's run only). */
  chat?: ChatMessage[];
  /** Waiting for the owner to say where to go. */
  waiting?: boolean;
  /** The owner may click the live page (the site has joined). */
  clickable?: boolean;
  /** update: each page starts from its published map, the owner's corrections kept; fresh: Muse Spark labels everything again. */
  mode?: 'update' | 'fresh';
  /** Against the maps the registry serves now, per page: keys added, removed or changed. */
  diff?: { path: string; added: string[]; removed: string[]; changed: string[] }[];
  published_at?: string;
}

export type WalkthroughEvent =
  | { type: 'log'; text: string }
  | { type: 'frame'; data: string }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'waiting'; waiting: boolean }
  | { type: 'cost'; usd: number }
  | { type: 'url'; url: string }
  | { type: 'done'; status: WalkthroughStatus; reason?: string };

/** What the owner chose while Usher waited: a page on the site, a click on the live page, or the end. */
type Move = { path: string } | { click: { x: number; y: number } } | { finish: true };

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
  /** How long an owner's run waits for an answer before it finishes. Default ten minutes. */
  pauseMs?: number;
  /** The longest a run may last. Default 45 minutes. */
  maxRunMs?: number;
  /** Runs at once, across every site (each holds a browser). Default 4. */
  maxLive?: number;
  /** Starts per site per day, whatever a run gave back. Default 5. */
  maxStarts?: number;
  /** What one site's conversations may spend on reading the owner's words, per day (USD). Default 0.25. */
  chatBudgetUsd?: number;
  /** The model and budget for runs Usher's admin starts: the registry's whole daily cap, not the owners' share. */
  admin?: { compiler: { chat: ChatFn; model: string }; spend: { today: () => Promise<number>; cap: number } };
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
  /** An owner's run: Usher asks where a walk would end. */
  conversation: boolean;
  /** While Usher waits: its choices, the page it is on, and how to answer. */
  waiting?: { options: Choice[]; at: { path: string; title: string }; resolve: (move: Move | null) => void };
  /** Journeys the owner asked for next ("then the callback"), by path, in order. */
  queue: string[];
  /** What the owner said while Usher was busy, read at the next stop. */
  pending?: string;
  /** Muse Spark is reading the owner's words; and how many times it has this run. */
  reading: boolean;
  reads: number;
  /** The site has joined, so the owner may click its pages. */
  joined: boolean;
  /** When the run must end, whatever it's doing. */
  deadline: number;
  /** Started by Usher's admin: no per-site, per-run or per-day limits. */
  admin: boolean;
}

const MAX_CHOICES = 6;
const MAX_STOPS = 30;
const MAX_CHAT = 200;
const MAX_READS = 40;

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
export async function ownPagesOnly(context: BrowserContext, origin: string, options: { allowPrivate?: boolean; registry?: string } = {}): Promise<void> {
  const verdicts = new Map<string, Promise<boolean>>();
  const registry = options.registry ? new URL(options.registry).origin : null;
  await context.route('**/*', async (route) => {
    const target = new URL(route.request().url());
    if (route.request().isNavigationRequest() && !route.request().frame().parentFrame() && target.origin !== origin) return route.abort('blockedbyclient');
    // Usher's browser is no one's proxy: only reads leave the site, from any frame (the registry excepted).
    if (target.origin !== origin && target.origin !== registry && !['GET', 'HEAD'].includes(route.request().method())) return route.abort('blockedbyclient');
    if (options.allowPrivate) return route.continue();
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
  async refusal(origin: string, start: string, admin = false): Promise<string | null> {
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
    if (this.live.size >= (this.o.maxLive ?? 4)) return 'Usher is mapping several sites right now. Try again in a few minutes.';
    const budget = admin && this.o.admin ? this.o.admin.spend : this.o.spend;
    const spent = await budget.today();
    if (spent + (this.o.estimateUsd ?? 0.6) > budget.cap) return `Today's model budget (${budget.cap}) can't cover a walkthrough; it resets at midnight UTC.`;
    if (admin) return null;
    const starts = (await this.storage.getCached<{ n: number }>('walkthrough-starts', `${origin}|${this.day()}`))?.n ?? 0;
    if (starts >= (this.o.maxStarts ?? 5)) return `${this.o.maxStarts ?? 5} walkthroughs started today; the next can start after midnight UTC.`;
    const limit = this.o.dailyLimit?.(origin) ?? 1;
    const used = (await this.storage.getCached<{ n: number }>('walkthrough-runs', `${origin}|${this.day()}`))?.n ?? 0;
    if (used >= limit) return `One walkthrough per site per day${limit > 1 ? ` (this site: ${limit})` : ''}; the next can start after midnight UTC.`;
    return null;
  }

  /** Starts a run; values are held in this run's memory only. */
  async start(input: { origin: string; start: string; values?: TestValues; generated?: boolean; pressFinal: boolean; by: 'owner' | 'operator'; conversation?: boolean; admin?: boolean; fresh?: boolean }): Promise<{ id: string } | { refused: string }> {
    const refused = await this.refusal(input.origin, input.start, input.admin);
    if (refused) return { refused };
    const key = `${input.origin}|${this.day()}`;
    await this.storage.putCached('walkthrough-runs', key, { n: ((await this.storage.getCached<{ n: number }>('walkthrough-runs', key))?.n ?? 0) + 1 });
    // Starts are counted apart from runs: a run that maps nothing gives its run back, never its start.
    await this.storage.putCached('walkthrough-starts', key, { n: ((await this.storage.getCached<{ n: number }>('walkthrough-starts', key))?.n ?? 0) + 1 });
    const run: WalkthroughRun = { id: `w_${randomUUID().replace(/-/g, '').slice(0, 16)}`, origin: input.origin, start: input.start, by: input.by, status: 'running', started_at: this.now().toISOString(), pages: [], cost_usd: 0, log: [] };
    // A site with published maps is updated unless the owner asks for a fresh start.
    run.mode = !input.fresh && (await this.o.registry.currentMaps(input.origin)).size ? 'update' : 'fresh';
    if (run.mode === 'update') run.log.push('Updating your published maps: each page starts from its map, with your corrections; anything new is marked.');
    const joined = Boolean((await this.storage.getSite(input.origin))?.claim) || input.origin === this.o.registry.demoOrigin;
    const live: Live = { run, listeners: new Set(), cancelled: false, conversation: Boolean(input.conversation), queue: [], reading: false, reads: 0, joined, admin: Boolean(input.admin), deadline: this.now().getTime() + (input.admin ? 3 * 60 * 60_000 : (this.o.maxRunMs ?? 45 * 60_000)) };
    if (live.conversation) {
      run.chat = [];
      run.clickable = joined;
    }
    this.live.set(run.id, live);
    // The owner's values or the generated person, for this run only.
    const values: TestValues = { ...(input.generated ? { ...TEST_PERSON, 'policy.start_date': testStartDate(this.now()) } : {}), ...(input.values ?? {}) };
    // Usher never submits to a site that hasn't joined: on a listed site the walk maps every page
    // and stops before the final step, whatever was ticked.
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
    live.waiting?.resolve(null);
    return true;
  }

  /** The owner picks one of Usher's choices, or "finish". */
  choose(origin: string, id: string, option: string): boolean {
    const live = this.live.get(id);
    if (!live || live.run.origin !== origin || !live.waiting) return false;
    if (option === 'finish') {
      this.post(live, { from: 'owner', text: 'Finish here.' });
      live.waiting.resolve({ finish: true });
      return true;
    }
    const choice = live.waiting.options.find((o) => o.id === option);
    if (!choice) return false;
    this.post(live, { from: 'owner', text: choice.label });
    live.waiting.resolve({ path: choice.path });
    return true;
  }

  /** The owner clicks the live page while Usher waits; the lock keeps wherever it leads on the site. */
  click(origin: string, id: string, x: number, y: number): boolean {
    const live = this.live.get(id);
    if (!live || live.run.origin !== origin || !live.waiting || !live.joined) return false;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > VIEWPORT.width || y > VIEWPORT.height) return false;
    this.post(live, { from: 'owner', text: 'Clicked the page.' });
    live.waiting.resolve({ click: { x: Math.round(x), y: Math.round(y) } });
    return true;
  }

  /** The owner says something. While Usher waits, Muse Spark reads it against the choices; else it waits for the next stop. */
  async message(origin: string, id: string, text: string): Promise<string | null> {
    const live = this.live.get(id);
    if (!live || live.run.origin !== origin || !live.conversation) return 'That run has finished.';
    const words = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!words) return 'Say something first.';
    if (live.reading) return 'Usher is still reading your last message.';
    this.post(live, { from: 'owner', text: words });
    if (!live.admin && live.reads >= MAX_READS) {
      this.post(live, { from: 'usher', text: "I've read as many messages as one run allows. Pick one of the choices, or start a new run tomorrow." });
      return null;
    }
    if (!live.waiting) {
      live.pending = words;
      this.post(live, { from: 'usher', text: "Got it. I'll come back to that when I've finished this page." });
      return null;
    }
    await this.understand(live, words);
    return null;
  }

  /** The admin's runs use the registry's whole daily cap; everyone else's, the owners' share. */
  private compilerFor(live: Live) {
    return live.admin && this.o.admin ? this.o.admin.compiler : this.o.compiler;
  }

  /** A line of the conversation, kept on the run and sent to whoever is watching. */
  private post(live: Live, message: Omit<ChatMessage, 'at'>): void {
    const full: ChatMessage = { ...message, at: this.now().toISOString() };
    const chat = (live.run.chat ??= []);
    chat.push(full);
    if (chat.length > MAX_CHAT) chat.splice(0, chat.length - MAX_CHAT);
    for (const l of live.listeners) l({ type: 'chat', message: full });
  }

  /**
   * The owner's words, read by Muse Spark against what Usher can do here. The model sees the page's
   * path and title, the pages mapped so far, the choices and the owner's words; never a value from a
   * form. It picks a move; code checks it (a choice that exists, a path on this site) and moves.
   */
  private async understand(live: Live, words: string): Promise<void> {
    const waiting = live.waiting;
    if (!waiting) return;
    const compiler = this.compilerFor(live);
    if (!compiler) return this.post(live, { from: 'usher', text: "I can't read messages on this registry. Pick one of the choices instead." });
    const budget = live.admin && this.o.admin ? this.o.admin.spend : this.o.spend;
    const spent = await budget.today();
    if (spent + 0.02 > budget.cap) return this.post(live, { from: 'usher', text: "Today's model budget is spent, so I can't read messages until midnight UTC. Pick one of the choices instead." });
    const ledger = `${live.run.origin}|${this.day()}`;
    const siteSpent = (await this.storage.getCached<{ usd: number }>('walkthrough-chat-spend', ledger))?.usd ?? 0;
    if (!live.admin && siteSpent >= (this.o.chatBudgetUsd ?? 0.25)) return this.post(live, { from: 'usher', text: "Your site's messages for today are used up, so I can't read more until midnight UTC. The choices and clicking still work." });
    let answer: { reply?: string; move?: string; option?: string | null; path?: string | null; then?: string[] };
    live.reading = true;
    live.reads++;
    try {
      const recent = (live.run.chat ?? []).slice(-8).map((m) => `${m.from}: ${m.text}`);
      const result = await compiler.chat({
        model: compiler.model,
        temperature: 0,
        messages: [
          { role: 'system', content: MOVE_SYSTEM },
          {
            role: 'user',
            content: JSON.stringify({
              site: live.run.origin,
              at: waiting.at,
              mapped: live.run.pages.map((p) => ({ path: p.path, title: p.title })),
              choices: waiting.options,
              recent,
              owner_says: words,
            }),
          },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'usher_walk_move', strict: true, schema: MOVE_SCHEMA } },
      });
      const cost = costUsd(compiler.model, result.usage) ?? 0.01;
      live.run.cost_usd += cost;
      await this.storage.putCached('walkthrough-chat-spend', ledger, { usd: siteSpent + cost });
      for (const l of live.listeners) l({ type: 'cost', usd: live.run.cost_usd });
      answer = parseJsonContent(result.content) as typeof answer;
    } catch {
      return this.post(live, { from: 'usher', text: "Sorry, I couldn't read that. Pick one of the choices, or try saying it another way." });
    } finally {
      live.reading = false;
    }
    if (live.waiting !== waiting) return;
    const reply = String(answer.reply ?? '').slice(0, 400);
    if (reply) this.post(live, { from: 'usher', text: reply });
    const byId = (id: string | null | undefined) => waiting.options.find((o) => o.id === id);
    live.queue = (answer.then ?? []).map((id) => byId(id)?.path).filter((p): p is string => Boolean(p));
    if (answer.move === 'option' && byId(answer.option)) return waiting.resolve({ path: byId(answer.option)!.path });
    if (answer.move === 'path' && answer.path) {
      const path = onSite(live.run.origin, answer.path);
      if (path) return waiting.resolve({ path });
      return this.post(live, { from: 'usher', text: "That isn't a page on your site, so I'll stay here." });
    }
    if (answer.move === 'finish') return waiting.resolve({ finish: true });
  }

  /** Waits for the owner: a choice, a click, words, or ten quiet minutes. A queued journey goes first. */
  private async ask(live: Live, question: string, options: Choice[], at: { path: string; title: string }): Promise<Move | null> {
    while (live.queue.length) {
      const path = live.queue.shift()!;
      const queued = options.find((o) => o.path === path);
      if (queued) {
        this.post(live, { from: 'usher', text: `Next, as you asked: ${queued.label}.` });
        return { path: queued.path };
      }
    }
    this.post(live, { from: 'usher', text: question, options });
    const emit = (waiting: boolean) => {
      live.run.waiting = waiting;
      for (const l of live.listeners) l({ type: 'waiting', waiting });
    };
    emit(true);
    const move = await new Promise<Move | null>((resolve) => {
      const wait = Math.max(0, Math.min(this.o.pauseMs ?? 10 * 60_000, live.deadline - this.now().getTime()));
      const timer = setTimeout(() => answer(null), wait);
      // The first answer wins: a second choice or click arriving together finds nothing waiting.
      const answer = (m: Move | null) => {
        clearTimeout(timer);
        live.waiting = undefined;
        resolve(m);
      };
      live.waiting = { options, at, resolve: answer };
      if (live.pending) {
        const words = live.pending;
        live.pending = undefined;
        void this.understand(live, words);
      }
    });
    live.waiting = undefined;
    emit(false);
    if (!move && !live.cancelled) this.post(live, { from: 'usher', text: "I haven't heard from you for a while, so I'll finish here. Everything mapped so far is kept." });
    return move;
  }

  /** Where Usher can go from this page: the site's declared journeys first, then the page's links; never off the site, never a page already mapped. */
  private async choices(page: Page, run: WalkthroughRun, declared: DeclaredJourney[], visited: Set<string>): Promise<Choice[]> {
    const mapped = new Set([...run.pages.map((p) => p.path), ...visited]);
    const here = new URL(page.url()).pathname;
    const links = await page
      .evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.getAttribute('aria-label') || a.querySelector('strong, b, h1, h2, h3, h4')?.textContent || (a as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) })))
      .catch(() => [] as { href: string; text: string }[]);
    const out: Choice[] = [];
    const seen = new Set<string>();
    const add = (href: string, label: string) => {
      let url: URL;
      try {
        url = new URL(href, run.origin);
      } catch {
        return;
      }
      const key = url.pathname;
      if (url.origin !== run.origin || !label || seen.has(key) || mapped.has(key) || key === here) return;
      if (/^\/(__|\.well-known\/|static\/)/.test(key) || /\.(css|js|json|png|jpe?g|gif|svg|webp|ico|pdf|zip)$/i.test(key)) return;
      seen.add(key);
      out.push({ id: `c${out.length + 1}`, label, path: `${url.pathname}${url.search}` });
    };
    for (const j of declared) {
      const link = links.find((l) => {
        try {
          return new URL(l.href).pathname === j.start;
        } catch {
          return false;
        }
      });
      add(j.start, link?.text || intentWords(j.intent));
    }
    for (const l of links) add(l.href, l.text);
    return out.slice(0, MAX_CHOICES);
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
    const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: false });
    await ownPagesOnly(context, run.origin, { allowPrivate: this.o.allowPrivate ?? false, registry: this.o.registry.url });
    const page = await context.newPage();
    // One tab: anything the site opens in another is closed.
    context.on('page', (other) => void (other !== page && other.close().catch(() => undefined)));
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
      const declared = await declaredJourneys(page);
      let starts = [new URL(run.start).pathname, new URL(page.url()).pathname];
      let intent: string | undefined;
      let session: string | undefined;
      let published: Map<string, UsherMap> | undefined;
      // A journey starts on the first page, and on any page Usher goes to at the owner's word (not
      // one reached by the form's own button): each gets the intent the site declares for it.
      let newJourney = true;
      if (live.conversation) this.post(live, { from: 'usher', text: `I'm on ${new URL(page.url()).pathname} of ${host}. I'll map each form I find and ask you when I need to know where to go.` });
      // In a conversation, where a walk would end Usher asks the owner instead: true when it has
      // somewhere to go (and has gone), false to finish.
      let stops = 0;
      // Pages already seen this run (with a form or not): never offered again.
      const visited = new Set<string>();
      const stop = async (question: string): Promise<boolean> => {
        visited.add(new URL(page.url()).pathname);
        if (!live.conversation || live.cancelled || ++stops > MAX_STOPS || this.now().getTime() > live.deadline) return false;
        const at = { path: new URL(page.url()).pathname, title: await page.title().catch(() => '') };
        const move = await this.ask(live, question, await this.choices(page, run, declared, visited), at);
        if (!move || 'finish' in move) return false;
        const before = page.url();
        if ('click' in move) {
          await page.mouse.click(move.click.x, move.click.y).catch(() => undefined);
          await page.waitForURL((u) => u.toString() !== before, { timeout: 5_000 }).catch(() => undefined);
        } else {
          await page.goto(new URL(move.path, run.origin).toString(), { waitUntil: 'load', timeout: 30_000 }).catch(() => undefined);
        }
        await page.waitForLoadState('load').catch(() => undefined);
        // The lock blocks other origins; this is the belt to its braces.
        if (new URL(page.url()).origin !== run.origin) await page.goto(before, { waitUntil: 'load' }).catch(() => undefined);
        say(`On ${new URL(page.url()).pathname}, as the owner asked.`);
        newJourney = true;
        starts = [new URL(page.url()).pathname];
        session = undefined;
        return true;
      };
      for (let step = 1; step <= (this.o.maxPages ?? (live.conversation ? 30 : 10)); step++) {
        if (live.cancelled) return await finish('cancelled', 'Cancelled by the owner.');
        if (this.now().getTime() > live.deadline) {
          if (live.conversation) this.post(live, { from: 'usher', text: "This run has reached its time limit, so I'll finish here. Everything mapped so far is kept." });
          break;
        }
        const path = new URL(page.url()).pathname;
        const title = await page.title();
        emit({ type: 'url', url: page.url() });
        if (live.conversation && run.pages.some((p) => p.path === path)) {
          if (await stop(`I've already mapped ${title || path}. Where next?`)) {
            step--;
            continue;
          }
          break;
        }
        let scan: Scan = await page.evaluate(scanScript());
        let form = mainForm(scan.forms);
        if (!form || !form.elements.some((e) => e.kind === 'field' && e.visible)) {
          say(`${title || path}: no form to fill. The task ends here.`);
          const question = run.pages.length
            ? `${title || path} has no form, so that journey ends here. Map another, or finish?`
            : `${title || path} has no form to map. Where should I go?`;
          if (await stop(question)) {
            step--;
            continue;
          }
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

        const compiler = this.compilerFor(live)!;
        say(`Labelling with ${compiler.model} (vote mode).`);
        const compiled = await compilePage(page, { chat: compiler.chat, model: compiler.model, vote: true, boxes: true, logDir: this.o.logDir ?? null });
        run.cost_usd += compiled.cost_usd ?? 0;
        emit({ type: 'cost', usd: run.cost_usd });
        const map = compiled.map;
        // Against the published map: in an update, its labels (the owner's corrections among them) win.
        published ??= await this.o.registry.currentMaps(run.origin);
        const status = againstPublished(map, published.get(path), run.mode === 'update');
        const fresh = Object.values(status).filter((s) => s === 'new').length;
        if (published.has(path)) say(run.mode === 'update' ? `Kept the published labels${fresh ? `; ${plural(fresh, 'element')} new since then` : ', nothing new'}.` : `Against the published map: ${plural(fresh, 'new element')}, ${plural(Object.values(status).filter((s) => s === 'changed').length, 'labelled differently', 'labelled differently')}.`);
        // One intent for the whole journey, the site's if it declares one.
        if (newJourney) {
          newJourney = false;
          const chosen = journeyIntent(declared, starts, map.form.intent);
          intent = chosen.intent;
          if (intent) say(`The task's intent: ${intent}${chosen.declared ? ', as the site declares it' : ''}.`);
        }
        if (intent) map.form.intent = intent;
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

        const record: WalkthroughPage = { path, title, map, screenshot, width: size.width, height: size.height, conditions, unexplored: explored.unexplored, lists, ...(Object.keys(status).length && { status }) };
        run.pages.push(record);
        if (live.conversation) {
          const yours = map.fields.filter((f) => f.risk === 'needs_user').length;
          const shows = conditions.length ? `, ${plural(conditions.length, 'answer')} that ${conditions.length === 1 ? 'shows' : 'show'} more` : '';
          this.post(live, { from: 'usher', text: `Mapped “${title || path}”: ${plural(map.fields.length, 'field')}${yours ? `, ${yours} only the person can answer` : ''}${shows}.`, pages: [run.pages.length - 1] });
        }

        const advance = map.actions.find((a) => a.key === 'form.submit' || a.key === 'search.submit') ?? map.actions.find((a) => ADVANCE.includes(a.key));
        if (!advance) {
          if (await stop(`I can't find a way forward from ${title || path}. Where next?`)) continue;
          await finish('stopped', `No way forward on ${path}.`);
          break;
        }
        if (advance.risk !== 'safe' && !pressFinal) {
          if (await stop(`That task is mapped up to “${advance.label}”, which I won't press on this run. Map another, or finish?`)) continue;
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
          if (await stop(`${title || path} didn't move on after “${advance.label}”: the site may have refused a test value. Try somewhere else, or finish?`)) continue;
          await finish('failed', `${path} did not move on after "${advance.label}": the site may have refused a test value.`);
          break;
        }
        const next = new URL(page.url()).pathname;
        advance.leads_to = next;
        record.leads_to = next;
        say(`Next: ${next}.`);
      }
      if (!ending) await finish(run.pages.length ? 'completed' : 'stopped', run.pages.length ? undefined : "No form on the start page: start on a journey's first page instead. This run doesn't count towards today's.");
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
      // A run that labelled nothing cost nothing: it gives back the day's walkthrough it took.
      if (!run.pages.length && !run.cost_usd) {
        const key = `${run.origin}|${run.started_at.slice(0, 10)}`;
        const n = (await this.storage.getCached<{ n: number }>('walkthrough-runs', key))?.n ?? 0;
        if (n > 0) await this.storage.putCached('walkthrough-runs', key, { n: n - 1 });
      }
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
/** A journey a site declares in its /.well-known/usher.json: where it starts, and its intent. */
export interface DeclaredJourney {
  start: string;
  intent: string;
}

/**
 * The intent of the whole journey: the one the site declares for where it starts, else the one the
 * model named on its first page. Every page of the journey gets it, so a token from a knock on any
 * page is for the intent the site's server checks (a model names intents in its own words, and not
 * always the same way on every page).
 */
export function journeyIntent(declared: DeclaredJourney[], starts: string[], named: string | undefined): { intent: string | undefined; declared: boolean } {
  const found = declared.find((j) => starts.includes(j.start));
  return found ? { intent: found.intent, declared: true } : { intent: named, declared: false };
}

const INTENT = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/** The journeys the site declares (spec/knock.md), read from the page's own origin; none if it has no file. */
async function declaredJourneys(page: Page): Promise<DeclaredJourney[]> {
  const found: unknown = await page
    .evaluate(async () => {
      const res = await fetch('/.well-known/usher.json', { credentials: 'omit' });
      return res.ok ? res.json() : null;
    })
    .catch(() => null);
  const journeys = (found as { journeys?: unknown } | null)?.journeys;
  if (!Array.isArray(journeys)) return [];
  return journeys
    .filter((j): j is DeclaredJourney => typeof j?.start === 'string' && j.start.startsWith('/') && typeof j?.intent === 'string' && INTENT.test(j.intent))
    .slice(0, 50)
    .map((j) => ({ start: j.start, intent: j.intent }));
}

export function withoutBoxes(map: UsherMap): UsherMap {
  return { ...map, fields: map.fields.map(({ box: _b, ...f }) => f), actions: map.actions.map(({ box: _b, ...a }) => a) };
}

/**
 * Matches each element of a newly labelled page to the published map's: the same kind of element
 * with an id or name in common, else the same label. With keep, a matched element takes the
 * published key, risk and label (the owner's corrections among them), unless that makes the map
 * invalid. Returns the elements the published map didn't have (new) and, without keep, those
 * labelled differently (changed).
 */
export function againstPublished(map: UsherMap, published: UsherMap | undefined, keep: boolean): Record<string, 'new' | 'changed'> {
  if (!published) return {};
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  type El = { el: UsherMap['fields'][number] | UsherMap['actions'][number]; kind: string };
  const all = (m: UsherMap): El[] => [...m.fields.map((el) => ({ el, kind: `field:${el.control}` })), ...m.actions.map((el) => ({ el, kind: `action:${el.kind}` }))];
  const handles = (el: El['el']) => new Set(el.locators.filter((l) => l.by === 'id' || l.by === 'name').map((l) => `${l.by}=${l.value}`));
  const old = all(published);
  const used = new Set<El['el']>();
  const before = structuredClone(map);
  const status: Record<string, 'new' | 'changed'> = {};
  for (const { el, kind } of all(map)) {
    const mine = handles(el);
    const match =
      old.find((o) => !used.has(o.el) && o.kind === kind && [...handles(o.el)].some((h) => mine.has(h)))?.el ??
      old.find((o) => !used.has(o.el) && o.kind === kind && norm(o.el.label) === norm(el.label))?.el;
    if (!match) {
      status[el.id] = 'new';
      continue;
    }
    used.add(match);
    if (keep) Object.assign(el, { key: match.key, risk: match.risk, label: match.label });
    else if (match.key !== el.key || match.risk !== el.risk) status[el.id] = 'changed';
  }
  if (keep && mapSchemaErrors(map)) {
    Object.assign(map, before);
    return againstPublished(map, published, false);
  }
  return status;
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

/** How a walk's conversation turns the owner's words into a move. */
const MOVE_SYSTEM = `You help a website's owner map their site's forms with Usher. Usher's browser is paused on a page of the owner's site and is waiting for the owner to say where to go next.

Choose one move from what the owner says:
- "option": go to one of the listed choices (give its id in "option").
- "path": go to another page on the same site the owner names (give a path starting with /, in "path").
- "finish": the owner is done.
- "wait": anything else, such as a question, or something unclear. Answer it or ask what they mean.

If they ask for several journeys in order, take the first now and put the ids of the rest, in order, in "then".
"reply" is one or two short, plain sentences to the owner about what you're doing. Never ask for personal details, and never repeat any.`;

const MOVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'move', 'option', 'path', 'then'],
  properties: {
    reply: { type: 'string' },
    move: { type: 'string', enum: ['option', 'path', 'finish', 'wait'] },
    option: { type: ['string', 'null'] },
    path: { type: ['string', 'null'] },
    then: { type: 'array', items: { type: 'string' } },
  },
};

/** A path on the site's own origin, or null: never another host, a protocol or a backslash trick. */
export function onSite(origin: string, path: string): string | null {
  if (!/^\/(?![\/\\])[^\s\\]*$/.test(path)) return null;
  try {
    const url = new URL(path, origin);
    return url.origin === origin ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

/** A declared journey's intent in words, for a choice with no link text: quote.mortgage → "Mortgage quote". */
function intentWords(intent: string): string {
  const [verb = '', ...rest] = intent.split('.');
  const what = rest.join(' ').replace(/_/g, ' ');
  const words = `${what} ${verb}`.trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
