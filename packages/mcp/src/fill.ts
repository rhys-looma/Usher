// usher_fill, usher_confirm, usher_cancel: Usher does the filling. The agent hands over its user's
// values by semantic key; the MCP server knocks with the agent's own key, runs Usher's executor in
// its own headless browser (a fresh context per call) and fills every page by the map. Before a page
// that needs the user, it stops once with every decision it knows of for the rest of the journey (with
// a plan): consents, the submit, and required values it doesn't have. Each comes with the page's own
// words as verbatim blocks: the consent wording and the terms it links to, the text beside the submit.
// The agent puts them to its user word for word and answers them all in one usher_confirm. It stops
// again only if a later page shows a decision, or new wording for one, that wasn't known. At the end
// it returns the result page's title and its figures (amounts, references, validity) verbatim, the
// final URL and a screenshot. Values never leave this process except into the site's own form, and
// are never echoed back: what was submitted is listed by key.

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Browser, Page } from 'playwright';
import { z } from 'zod';
import { budgeted, compilerModel, modelApi, preflight, vocabulary, type ChatFn, type MapAction, type MapField, type SpendLedger, type UsherPlan } from '@usher/core';
import type { KnockResponse } from '@usher/registry';
import { RateLimiter } from '../../registry/src/rate-limit.ts';
import { httpTransport, runAgent, type AgentEvent, type FallbackModel, type PageDecisions, type Profile, type RegistryTransport, type RunResult, type UserChannel } from '../../agent/src/index.ts';
import { blockHash, consentBlocks, disclosureBlock, resultFacts, type Block } from './blocks.ts';

export type DecisionKind = 'required_consent' | 'optional_consent' | 'submit' | 'missing_value';

/** One thing the user decides, with the page's own label for it. */
export interface Decision {
  key: string;
  label: string;
  kind: DecisionKind;
  /** The path of the page that asks it. */
  page: string;
  control?: string;
  options?: string[];
  /** What is assumed when no answer is given (optional consents: false). */
  default?: boolean;
}

type Answer = boolean | string;

interface Pending {
  decisions: Decision[];
  blocks: Block[];
  resolve: (stop?: string) => void;
}

interface Job {
  id: string;
  run: Promise<RunResult>;
  page?: Page;
  actions: { page: string; action: string; key: string }[];
  answers: Map<string, Answer>;
  /** Hashes of the verbatim blocks already put to the user. */
  shown: Set<string>;
  /** Decisions the plan shows for the rest of the journey. */
  planned: Decision[];
  pending?: Pending;
  pauses: number;
  outcome?: { title: string; facts: Block[]; image?: string };
  /** The last knock: where the session log takes the record of what was shown. */
  knock?: KnockResponse;
  transport?: RegistryTransport;
  /** Wakes whoever waits for the next decision or the end. */
  wait: Promise<void>;
  rearm: () => void;
  expires: NodeJS.Timeout;
  started: number;
}

export interface FillOptions {
  /** The registry, over HTTP, signing with the key in keyFile; or `transport` instead. */
  registryUrl?: string;
  keyFile?: string;
  /** How each fill reaches the registry (hosted connections: in-process, with the connection's key). */
  transport?: () => Promise<RegistryTransport>;
  /** Checked before a fill starts: a refusal to return instead, or null to go ahead. */
  admit?: (url: string) => Promise<{ refused: string } | { release: () => void }>;
  /** For pages with no map: Muse Spark (MODEL_API_KEY), within the daily cap. */
  fallback?: FallbackModel;
  /** Launch the browser (tests and the hosted endpoint pass their own, and close it themselves). */
  browser?: () => Promise<Browser>;
  /** How long a run may go before it reaches a decision or the end. */
  stepTimeoutMs?: number;
  /** How long a decision set waits for usher_confirm or usher_cancel. */
  decisionTimeoutMs?: number;
  /** Every request a fill's browser makes must reach a host this allows (hosted: public only). */
  allowHost?: (host: string) => Promise<boolean>;
  /** usher_fill calls per hour. */
  perHour?: number;
  /** Tool metadata for usher_fill and usher_confirm (the card their results render as). */
  toolMeta?: Record<string, unknown>;
}

/** The model for pages with no map, within a daily spend cap kept in ~/.usher/spend.json. */
export function capFallback(env: NodeJS.ProcessEnv = process.env): FallbackModel | undefined {
  if (!env.MODEL_API_KEY) return undefined;
  const file = join(homedir(), '.usher', 'spend.json');
  const ledger: SpendLedger = {
    spent: async (day) => ((JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as Record<string, number>)[day] ?? 0),
    add: async (day, usd) => {
      const all = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as Record<string, number>;
      all[day] = (all[day] ?? 0) + usd;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(all), { mode: 0o600 });
    },
  };
  const chat: ChatFn = budgeted(modelApi(), Number(env.USHER_DAILY_MODEL_BUDGET_USD ?? 1), ledger);
  return { chat, model: compilerModel(), logDir: null };
}

/** Chromium, installed on first use if this machine doesn't have it yet. */
async function launchChromium(): Promise<Browser> {
  const { chromium } = await import('playwright');
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    if (!/Executable doesn't exist|playwright install/i.test(String(err))) throw err;
    const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
    await promisify(execFile)(process.execPath, [cli, 'install', 'chromium'], { timeout: 600_000 });
    return chromium.launch({ headless: true });
  }
}

const FILL_DESCRIPTION =
  'Fill a whole form journey for your user, by meaning. Pass the starting page URL, the intent (for example quote.car_insurance) and the values you already have, keyed by Usher vocabulary keys (person.first_name, contact.email, vehicle.registration, …). Usher fills the pages in its own browser and pauses before consents and submissions: it returns a set of decisions (required and optional consents, the submit, and any required value it is missing) with verbatim blocks from the page. Put every decision to your user, and show every block marked verbatim to them word for word: never summarise it, and never answer a decision on the user\'s behalf, even when you think you know the answer. Then pass all their answers at once to usher_confirm. Values with the wrong format come back first as problems by key, before anything runs. When the journey completes you get the result page\'s title, its figures as verbatim facts (show them as they are), the final URL and a screenshot.';

const CONFIRM_DESCRIPTION =
  'Pass your user\'s answers to the decision set usher_fill (or a previous usher_confirm) returned, all at once, keyed by each decision\'s key: true or false for consents and the submit, the value itself for a missing value. Only send answers your user actually gave, in their words, after they have seen the decisions and every verbatim block; never decide for them. An optional consent left out counts as no. If your user says no to a required consent or to the submit, the fill stops there and nothing is submitted.';

const describe = (job: Job) => ({ page: job.page?.url() });
export function registerFillTools(server: McpServer, options: FillOptions): { close: () => Promise<void> } {
  const jobs = new Map<string, Job>();
  // Every vocabulary field the user can give up front, by name, so clients that build forms from a
  // tool's schema (rather than passing free JSON) see the keys; custom.* and the rest pass through.
  // Untyped beyond that, and checked in the tool: some clients can't read a union of types.
  const valuesSchema = z
    .object(Object.fromEntries(vocabulary.entries.filter((e) => e.kind === 'field' && e.default_risk !== 'needs_user').map((e) => [e.key, z.string().optional().describe(e.meaning)])))
    .catchall(z.any())
    .describe('The user\'s values by vocabulary key: text, numbers or true/false. Select and radio values are the option values. Leave out what you don\'t have: usher_fill asks for it.');
  const limiter = new RateLimiter(options.perHour ?? 20, 3_600_000);
  let browser: Promise<Browser> | undefined;
  const stepTimeout = options.stepTimeoutMs ?? 120_000;
  const decisionTimeout = options.decisionTimeoutMs ?? 600_000;

  const reply = (value: unknown, image?: string) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }, ...(image ? [{ type: 'image' as const, data: image, mimeType: 'image/png' }] : [])],
    structuredContent: value as Record<string, unknown>,
  });
  const failure = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

  /** A screenshot of the page with every value masked. */
  async function maskedShot(page: Page | undefined): Promise<string | undefined> {
    if (!page || page.isClosed()) return undefined;
    const shot = await page.screenshot({ mask: [page.locator('input, select, textarea')], maskColor: '#191942' }).catch(() => undefined);
    return shot?.toString('base64');
  }

  /** Records in the session log which verbatim blocks were put to the user: by key and hash, never the text. */
  async function logShown(job: Job, blocks: Block[], path: string): Promise<void> {
    const knock = job.knock;
    const shown = blocks.filter((b) => b.verbatim);
    if (!knock || !shown.length) return;
    const ts = new Date().toISOString();
    const events = shown.map((b) => ({
      ts,
      source: 'agent' as const,
      action: 'shown' as const,
      path,
      ...(b.source.key && { key: b.source.key }),
      // A linked page's text is someone else's: only its hash is kept, as for every block.
      detail: { block: b.kind, sha256: blockHash(b.text), ...(b.source.url && new URL(b.source.url).pathname !== path && { linked: true }) },
    }));
    await job.transport?.logEvents?.(knock.events_url, knock.token, events).catch(() => undefined);
  }

  /** Waits for the job's next decision set or its end, and says which. */
  async function next(job: Job) {
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), stepTimeout).unref());
    const ended = job.run.then((r) => ({ r }));
    for (;;) {
      if (job.pending) {
        const { decisions, blocks } = job.pending;
        return reply({
          status: 'needs_decision',
          id: job.id,
          instructions: 'Show your user every block marked verbatim word for word, put each decision to them, and pass all their answers to usher_confirm at once. Never answer for them.',
          decisions,
          blocks,
          actions_so_far: job.actions.length,
          elapsed_ms: Math.round(performance.now() - job.started),
        });
      }
      const woke = await Promise.race([ended, job.wait.then(() => 'changed' as const), timeout]);
      if (woke === 'timeout') {
        const image = await maskedShot(job.page);
        await finish(job);
        return reply({ status: 'failed', id: job.id, reason: `No decision or end within ${stepTimeout / 1000} s; the run was stopped.`, ...describe(job) }, image);
      }
      if (woke === 'changed') continue;
      const r = woke.r;
      const image = r.outcome === 'completed' ? job.outcome?.image : await maskedShot(job.page);
      await finish(job);
      const submitted = [...new Set(job.actions.filter((a) => a.action === 'fill' || a.action === 'handoff').map((a) => a.key))];
      return reply(
        {
          status: r.outcome,
          id: job.id,
          ...(r.reason && { reason: r.reason }),
          ...(r.problems?.length && { problems: r.problems.map((p) => ({ key: p.key, message: p.message })) }),
          session: r.session,
          ...(r.outcome === 'completed' && job.outcome && { result: { title: job.outcome.title, final_url: r.final_url, facts: job.outcome.facts.map((f) => f.text) } }),
          final_url: r.final_url,
          ...(job.outcome?.facts.length && { blocks: job.outcome.facts }),
          // What was submitted, by key: the values themselves are never echoed back.
          submitted,
          actions: job.actions,
          pauses: job.pauses,
          used_model: r.pages.filter((p) => p.map_source === 'compiled').map((p) => p.path),
          elapsed_ms: Math.round(performance.now() - job.started),
        },
        image,
      );
    }
  }

  async function finish(job: Job): Promise<void> {
    clearTimeout(job.expires);
    jobs.delete(job.id);
    job.pending?.resolve('The fill was abandoned.');
    await job.page?.context().close().catch(() => undefined);
  }

  /** What the plan shows the user will be asked across the journey, before any page is open. */
  function plannedDecisions(plan: UsherPlan, values: Profile): Decision[] {
    const out: Decision[] = [];
    for (const input of plan.inputs) {
      const page = input.steps[0] ?? plan.start;
      const options = input.options?.items.map((o) => o.label);
      if (input.risk === 'needs_user') {
        out.push(input.control === 'checkbox' ? { key: input.key, label: input.label, kind: input.required ? 'required_consent' : 'optional_consent', page, control: 'checkbox', ...(!input.required && { default: false }) } : { key: input.key, label: input.label, kind: 'missing_value', page, control: input.control, ...(options && { options }) });
      } else if (input.required && !input.shown_if && values[input.key] === undefined) {
        out.push({ key: input.key, label: input.label, kind: 'missing_value', page, control: input.control, ...(options && { options }) });
      }
    }
    for (const c of plan.consequential) if (c.risk === 'consequential') out.push({ key: c.key, label: c.label, kind: 'submit', page: c.path });
    return out;
  }

  const meta = options.toolMeta ? { _meta: options.toolMeta } : {};
  server.registerTool('usher_fill', { title: 'Fill a form with Usher', description: FILL_DESCRIPTION, inputSchema: { url: z.string().url(), intent: z.string(), values: valuesSchema }, ...meta }, async (args) => {
    const odd = Object.entries(args.values).filter(([, v]) => !['string', 'number', 'boolean'].includes(typeof v)).map(([k]) => k);
    if (odd.length) return failure(`Values must be text, numbers or true/false: ${odd.join(', ')}.`);
    if (!limiter.allow('fill')) return failure('Too many fills this hour; try again later.');
    const admitted = options.admit ? await options.admit(args.url) : { release: () => undefined };
    if ('refused' in admitted) return failure(admitted.refused);
    const values = Object.fromEntries(Object.entries(args.values).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v])) as Profile;
    const base = options.transport ? await options.transport() : await httpTransport(options.registryUrl!, options.keyFile);
    // Before anything runs: the plan's inputs. Wrong values come back now; missing ones are asked later.
    const plan = await base.getPlan(args.url).catch(() => null);
    if (plan) {
      const checked = preflight(plan.inputs.filter((i) => i.risk !== 'needs_user'), values);
      const wrong = checked.problems.filter((p) => p.problem !== 'missing');
      if (wrong.length) {
        await base.close?.();
        admitted.release();
        return reply({ status: 'invalid', problems: wrong.map((p) => ({ key: p.key, message: p.message, ...(p.expected && { expected: p.expected }) })) });
      }
    }
    browser ??= (options.browser ?? launchChromium)();
    let wake!: () => void;
    const job: Job = {
      id: `f_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      actions: [],
      answers: new Map(),
      shown: new Set(),
      planned: plan ? plannedDecisions(plan, values) : [],
      pauses: 0,
      started: performance.now(),
      run: undefined as unknown as Promise<RunResult>,
      wait: new Promise<void>((r) => (wake = r)),
      rearm: () => {
        const w = wake;
        job.wait = new Promise<void>((r) => (wake = r));
        w();
      },
      expires: setTimeout(() => void finish(job), decisionTimeout + stepTimeout).unref(),
    };
    const transport: RegistryTransport = { ...base, knock: async (input) => (job.knock = await base.knock(input)) };
    job.transport = transport;
    // Lines on the result page that repeat what the user typed are theirs: never echoed back.
    const optionKeys = new Set(plan?.inputs.filter((i) => ['select', 'radio', 'checkbox'].includes(i.control)).map((i) => i.key));
    const supplied = Object.entries(values).filter(([k, v]) => typeof v === 'string' && !optionKeys.has(k)).map(([, v]) => v as string);
    const terms = new Map<string, string | null>();

    /** Puts a decision set to the user and waits for the answers; a reason to stop, or nothing. */
    const ask = (decisions: Decision[], blocks: Block[], path: string) =>
      new Promise<string | undefined>((resolve) => {
        if (!jobs.has(job.id)) return resolve('The fill was abandoned.');
        // Every wording put to the user, so a page that shows the same words isn't asked again.
        for (const b of blocks) job.shown.add(blockHash(b.text));
        job.pauses++;
        void logShown(job, blocks, path);
        job.pending = { decisions, blocks, resolve };
        clearTimeout(job.expires);
        job.expires = setTimeout(() => void finish(job), decisionTimeout).unref();
        job.rearm();
      });

    const kindOf = (f: MapField): DecisionKind => (f.control === 'checkbox' ? (f.required ? 'required_consent' : 'optional_consent') : 'missing_value');
    const decisionFor = (f: MapField, kind: DecisionKind, path: string): Decision => ({
      key: f.key,
      label: f.label,
      kind,
      page: path,
      ...(f.control && { control: f.control }),
      ...(f.options && kind === 'missing_value' && { options: f.options.items.map((o) => o.label) }),
      ...(kind === 'optional_consent' && { default: false }),
    });

    const user: UserChannel = {
      async review(d: PageDecisions, page: Page) {
        const here: Decision[] = [
          ...d.userOnly.map((f) => decisionFor(f, kindOf(f), d.path)),
          ...d.confirmFields.map((f) => decisionFor(f, 'optional_consent', d.path)),
          ...(d.advance ? [{ key: d.advance.key, label: d.advance.label, kind: 'submit' as const, page: d.path }] : []),
          ...d.missing.map((f) => decisionFor(f, 'missing_value', d.path)),
        ];
        // The page's own words for each: consent wording (and linked terms), the text by the submit.
        const blocks: Block[] = [];
        for (const f of d.userOnly.filter((f) => f.control === 'checkbox')) blocks.push(...(await consentBlocks(page, f, terms)));
        if (d.advance) {
          const disclosure = await disclosureBlock(page, d.advance as MapAction);
          if (disclosure) blocks.push(disclosure);
        }
        for (const f of d.missing) blocks.push({ kind: 'question', text: f.label, verbatim: false, source: { key: f.key, url: page.url() } });
        // Ask what isn't answered yet, and again anything whose wording the user hasn't seen.
        const unseen = new Set(blocks.filter((b) => b.verbatim && !job.shown.has(blockHash(b.text))).map((b) => b.source.key));
        const toAsk = here.filter((q) => !job.answers.has(q.key) || unseen.has(q.key));
        if (toAsk.length) {
          for (const q of toAsk) job.answers.delete(q.key);
          const keys = new Set(toAsk.map((q) => q.key));
          const later = job.planned.filter((q) => !keys.has(q.key) && !job.answers.has(q.key) && !here.some((h) => h.key === q.key));
          const laterBlocks: Block[] = later.map((q) => ({ kind: q.kind === 'missing_value' ? 'question' : q.kind === 'submit' ? 'disclosure' : 'consent', text: q.label, verbatim: false, source: { key: q.key } }));
          const stop = await ask([...toAsk, ...later], [...blocks.filter((b) => !b.source.key || keys.has(b.source.key)), ...laterBlocks.filter((b) => b.kind !== 'disclosure')], d.path);
          if (stop) return { stop };
        }
        const profile = Object.fromEntries(d.missing.filter((f) => job.answers.has(f.key)).map((f) => [f.key, job.answers.get(f.key)!])) as Profile;
        return { profile };
      },
      async confirm(element: MapAction | MapField) {
        return job.answers.get(element.key) === true;
      },
      async handoff(field: MapField, page: Page) {
        // The user's own answer, entered as they gave it; nothing from `values`.
        const answer = job.answers.get(field.key);
        if (answer === undefined) return;
        const target = page.getByLabel(field.label, { exact: true });
        if (field.control === 'checkbox') await (answer === true ? target.check() : target.uncheck()).catch(() => undefined);
        else if (typeof answer === 'string') await target.fill(answer).catch(() => undefined);
      },
    };
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'action') job.actions.push({ page: event.path, action: event.action, key: event.key });
    };
    // needs_user keys are never taken from values: only the user's answer at the pause fills them.
    const profile = Object.fromEntries(Object.entries(values).filter(([k]) => !job.planned.some((q) => q.key === k && q.kind !== 'missing_value'))) as Profile;
    job.run = (async (): Promise<RunResult> => {
      try {
        return await runAgent({
          browser: await browser!,
          url: args.url,
          intent: args.intent,
          profile,
          registry: transport,
          user,
          ...(options.fallback && { fallback: options.fallback }),
          ...(options.allowHost && { allowHost: options.allowHost }),
          onPage: (page) => void (job.page = page),
          onEvent,
          onFinish: async (page, outcome) => {
            if (outcome !== 'completed') return;
            const { title, facts } = await resultFacts(page, supplied);
            job.outcome = { title, facts, ...(await maskedShot(page).then((image) => image && { image })) };
            await logShown(job, facts, new URL(page.url()).pathname);
          },
        });
      } catch (err) {
        // A run that broke (or whose page a cancel closed) ends as failed, never as a crash.
        return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err), session: null, final_url: job.page?.url() ?? args.url, pages: [], maps_submitted: 0, transport: 'http', total_ms: 0, knock_ms: 0, model_ms: 0, fill_ms: 0, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 }, cost_usd: 0, plan_used: false };
      } finally {
        await transport.close?.();
        admitted.release();
        job.rearm();
      }
    })();
    jobs.set(job.id, job);
    return next(job);
  });

  server.registerTool(
    'usher_confirm',
    {
      title: 'Answer the decisions',
      description: CONFIRM_DESCRIPTION,
      inputSchema: {
        id: z.string(),
        answers: z.record(z.string(), z.any()).optional().describe('The user\'s answer to each decision, by its key: true or false for consents and the submit, the value for a missing value.'),
        answer: z.any().optional().describe('Older clients: the answer when only one decision is pending.'),
      },
      ...meta,
    },
    async (args) => {
      const job = jobs.get(args.id);
      const pending = job?.pending;
      if (!job || !pending) return failure(`Nothing is waiting under ${args.id}.`);
      const given: Record<string, unknown> = { ...(args.answers ?? {}) };
      if (args.answer !== undefined && pending.decisions.length === 1 && given[pending.decisions[0]!.key] === undefined) given[pending.decisions[0]!.key] = args.answer;
      const yes = (v: unknown) => v === true || (typeof v === 'string' && /^(true|yes|y|agree|agreed|ok|confirm(ed)?)$/i.test(v.trim()));
      const no = (v: unknown) => v === false || (typeof v === 'string' && /^(false|no|n|decline(d)?|disagree)$/i.test(v.trim()));
      const unanswered = pending.decisions.filter((d) => given[d.key] === undefined && d.kind !== 'optional_consent');
      const unclear = pending.decisions.filter((d) => given[d.key] !== undefined && d.kind !== 'missing_value' && !yes(given[d.key]) && !no(given[d.key]));
      if (unanswered.length || unclear.length)
        return failure(
          `Answer every decision, as your user answered it: ${[...unanswered, ...unclear].map((d) => `${d.key} ("${d.label}")`).join(', ')}. Consents and the submit take true or false; nothing has been entered or submitted.`,
        );
      for (const d of pending.decisions) {
        const v = given[d.key];
        job.answers.set(d.key, d.kind === 'missing_value' ? String(v) : v === undefined ? false : yes(v));
      }
      const refused = pending.decisions.find((d) => (d.kind === 'required_consent' || d.kind === 'submit') && job.answers.get(d.key) === false);
      job.pending = undefined;
      pending.resolve(refused ? `The user said no to "${refused.label}".` : undefined);
      return next(job);
    },
  );

  server.registerTool(
    'usher_cancel',
    {
      title: 'Abandon a fill',
      description: 'Your user said no, or changed their mind: abandon the fill usher_fill started. Nothing more is entered or submitted.',
      inputSchema: { id: z.string() },
    },
    async (args) => {
      const job = jobs.get(args.id);
      if (!job) return failure(`No fill ${args.id}.`);
      await finish(job);
      return reply({ status: 'cancelled', id: args.id, actions: job.actions });
    },
  );

  return {
    async close() {
      for (const job of [...jobs.values()]) await finish(job);
      if (browser && !options.browser) await (await browser).close().catch(() => undefined);
    },
  };
}
