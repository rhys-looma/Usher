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
import { budgeted, compilerModel, lookupFilled, matchOption, modelApi, pickOption, preflight, vocabulary, type ChatFn, type MapAction, type MapField, type SpendLedger, type UsherPlan } from '@usher/core';
import type { KnockResponse } from '@usher/registry';
import { RateLimiter } from '../../registry/src/rate-limit.ts';
import { fillField, httpTransport, runAgent, type AgentEvent, type FallbackModel, type PageDecisions, type Profile, type RegistryTransport, type RunResult, type UserChannel } from '../../agent/src/index.ts';
import { blockHash, consentBlocks, disclosureBlock, resultFacts, type Block } from './blocks.ts';
import { mapDetails } from './details.ts';

/**
 * confirm_value: an answer that is the person's alone (whether they smoke), entered only as they
 * said it and put back to them with the submit; if they say it isn't right, nothing is submitted.
 */
export type DecisionKind = 'required_consent' | 'optional_consent' | 'submit' | 'missing_value' | 'confirm_value';

/** Keys an agent fills only where the site permits it (health.*); otherwise the person answers them on the site. */
const SENSITIVE = new Set(vocabulary.entries.filter((e) => e.sensitive).map((e) => e.key));

/** The site permits an agent to enter the person's own answer to this input (its rule, from the plan). */
const permitted = (input: { risk: string; rule?: string }) => input.risk === 'needs_user' && (input.rule === 'confirm' || input.rule === 'allow');

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
  /** confirm_value: what the person said, as the site's option reads ("No"). */
  value?: string;
  /** The decision's name in the person's own confirmation ("declaration", "get my quote"). */
  short: string;
}

/** A decision's name in a confirmation the person sends: the action's own words, or the key's last part. */
export function shortName(key: string, label: string, kind: DecisionKind): string {
  return kind === 'submit' ? label.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim() : (key.split('.').pop() ?? key).replace(/_/g, ' ');
}

/** "Confirm: declaration yes, marketing no, get my quote yes, postcode \"WR14 1AA\"". */
export function confirmationPhrase(decisions: Decision[]): string {
  return `Confirm: ${decisions.map((d) => (d.kind === 'missing_value' ? `${d.short} "…"` : `${d.short} yes/no`)).join(', ')}`;
}

/** Reads the person's confirmation into answers by key; undefined for any decision it doesn't settle. */
export function parseConfirmation(text: string, decisions: Decision[]): Record<string, Answer | undefined> {
  const lower = text.toLowerCase();
  const out: Record<string, Answer | undefined> = {};
  for (const d of decisions) {
    const name = d.short.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (d.kind === 'missing_value') {
      // The value keeps the person's own case.
      const m = new RegExp(`${name}\\s*[:=]?\\s*"([^"]*)"`, 'i').exec(text);
      out[d.key] = m?.[1]?.trim() || undefined;
    } else {
      const m = new RegExp(`\\b${name}\\s*[:=]?\\s*(yes|no|true|false|y|n)\\b`).exec(lower);
      out[d.key] = m ? /^(yes|true|y)$/.test(m[1]!) : undefined;
    }
  }
  return out;
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
  /** Keys read from the person's details (never the values). */
  fromDetails?: string[];
  outcome?: { title: string; facts: Block[]; image?: string };
  /** confirm_value answers as the person gave them: entered as said, confirmed before the submit. */
  proposed: Map<string, string>;
  /** Keys the person alone answers that the site permits an agent to enter (health.*, by its rules). */
  permitted: Set<string>;
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
  /** Offer the maps fills build to the transport on every page, not only after a knock (hosted Usher). */
  shareMaps?: boolean;
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
  'Fill a whole form journey for the person on a site that uses Usher: a quote, an application, a booking. Pass the site and the task as they said them, and their details word for word; Usher reads the details against the form\'s own fields, fills every page, and pauses for the person at every consent and before anything is submitted, returning those decisions with the site\'s exact wording. Show them to the person word for word, never answer them yourself, and pass the person\'s reply to usher_confirm. Example: "Get me a health insurance quote from Brightwater. I\'m Sam Taylor, born 2 April 1988, WR14 1AA, just me, non-smoker, …" becomes usher_fill({ site: "Brightwater", task: "health insurance quote", details: "I\'m Sam Taylor, born 2 April 1988, WR14 1AA, just me, non-smoker, …" }). Answers that are the person\'s alone, such as whether they smoke, come back on the decision set for them to confirm; medical questions only where the site allows it, and the person confirms the answer. With exact keys, pass values by Usher vocabulary key (person.first_name, …) instead of details; with the first page, url and intent instead of site and task.';

const CONFIRM_DESCRIPTION =
  'Submits on your user\'s behalf with their answers to the decision set usher_fill (or a previous usher_confirm) returned. Pass their reply word for word as `confirmation` (for example "Confirm: declaration yes, marketing no, get my quote yes"), or their answers keyed by each decision\'s key: true or false for consents and the submit, the value itself for a missing value. Only send answers your user actually gave, after they have seen the decisions and every verbatim block; never decide for them. An optional consent left out counts as no. If your user says no to a required consent or to the submit, the fill stops there and nothing is submitted.';

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

  const reply = (value: unknown, image?: string, lead?: string) => ({
    content: [...(lead ? [{ type: 'text' as const, text: lead }] : []), { type: 'text' as const, text: JSON.stringify(value, null, 2) }, ...(image ? [{ type: 'image' as const, data: image, mimeType: 'image/png' }] : [])],
    structuredContent: value as Record<string, unknown>,
  });

  /** The decision set as plain text, so a client without cards shows the person the same thing. */
  const listing = (decisions: Decision[], blocks: Block[]) => {
    const kinds: Record<DecisionKind, string> = { required_consent: 'Required', optional_consent: 'Optional', submit: 'Action', missing_value: 'Needed', confirm_value: 'Confirm' };
    const lines = decisions.map((d, i) => {
      const own = blocks.filter((b) => b.source.key === d.key && b.verbatim);
      const wording = own.find((b) => b.kind === 'consent')?.text ?? d.label;
      const extra = own.filter((b) => b.kind !== 'consent' || b.text !== wording).map((b) => `\n   ${b.kind === 'disclosure' ? 'The site says' : 'Terms'}${b.source.url ? ` (${b.source.url})` : ''}: “${b.text}”`).join('');
      const said = d.kind === 'confirm_value' ? ` They said: “${d.value}”. Is that right?` : '';
      return `${i + 1}. ${kinds[d.kind]}: ${d.kind === 'submit' ? `press “${wording}”` : `“${wording}”`}${said}${extra}`;
    });
    return `Usher is asking the person, not the agent. Show them each item below word for word, in quotation marks, and ask for their answer; never answer for them.\n\n${lines.join('\n')}\n\nWhen they reply, call usher_confirm with their reply as \`confirmation\`, word for word. A reply in this form works: ${confirmationPhrase(decisions)}.`;
  };
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
        return reply(
          {
          status: 'needs_decision',
          id: job.id,
          instructions: 'Show your user every block marked verbatim word for word, put each decision to them, and pass all their answers to usher_confirm at once. Never answer for them.',
          decisions,
          blocks,
          confirmation_form: confirmationPhrase(decisions),
          ...(job.fromDetails && { read_from_details: job.fromDetails }),
          actions_so_far: job.actions.length,
          elapsed_ms: Math.round(performance.now() - job.started),
          },
          undefined,
          listing(decisions, blocks),
        );
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
    // What the site's own lookups will fill (make and model from a registration) isn't asked for.
    const looked = lookupFilled(plan, (k) => values[k] !== undefined);
    for (const input of plan.inputs) {
      const page = input.steps[0] ?? plan.start;
      const options = input.options?.items.map((o) => o.label);
      // Medical questions are the person's alone, answered on the site, unless the site permits an
      // agent to enter the person's own answer.
      if ((input.sensitive || SENSITIVE.has(input.key)) && !permitted(input)) continue;
      const said = values[input.key];
      if (input.risk === 'needs_user' && input.control !== 'checkbox' && said !== undefined) {
        const items = input.options?.items;
        const option = items ? items.find((o) => o.value === matchOption(items, said)) : undefined;
        if (items && !option) continue;
        out.push({ key: input.key, label: input.label, kind: 'confirm_value', page, control: input.control, value: option?.label ?? String(said), short: shortName(input.key, input.label, 'confirm_value') });
        continue;
      }
      if (input.risk === 'needs_user') {
        const kind: DecisionKind = input.control === 'checkbox' ? (input.required ? 'required_consent' : 'optional_consent') : 'missing_value';
        out.push(input.control === 'checkbox' ? { key: input.key, label: input.label, kind, page, control: 'checkbox', ...(!input.required && { default: false }), short: shortName(input.key, input.label, kind) } : { key: input.key, label: input.label, kind, page, control: input.control, ...(options && { options }), short: shortName(input.key, input.label, kind) });
      } else if (input.required && !input.shown_if && values[input.key] === undefined && !looked.has(input.key)) {
        out.push({ key: input.key, label: input.label, kind: 'missing_value', page, control: input.control, ...(options && { options }), short: shortName(input.key, input.label, 'missing_value') });
      }
    }
    for (const c of plan.consequential) if (c.risk === 'consequential') out.push({ key: c.key, label: c.label, kind: 'submit', page: c.path, short: shortName(c.key, c.label, 'submit') });
    return out;
  }

  const meta = options.toolMeta ? { _meta: options.toolMeta } : {};
  // Honest annotations: filling moves a site's journey on (it presses Continue), and usher_confirm
  // submits for the person, so neither is read-only; neither deletes anything.
  const inputSchema = {
    site: z.string().optional().describe('The site in the person\'s words: its name ("Brightwater"), its address, or any URL on it.'),
    task: z.string().optional().describe('What they want done there, in their words ("health insurance quote", "car insurance quote").'),
    details: z.string().optional().describe('Their details as they gave them, word for word. Usher reads them against the form\'s own fields.'),
    url: z.string().url().optional().describe('The journey\'s first page, if you know it exactly (instead of site and task).'),
    intent: z.string().optional().describe('With url: the intent, such as quote.car_insurance.'),
    values: valuesSchema.optional(),
  };
  server.registerTool('usher_fill', { title: 'Fill a form with Usher', description: FILL_DESCRIPTION, inputSchema, annotations: { title: 'Fill a form with Usher', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, ...meta }, async (args) => {
    const given = args.values ?? {};
    const odd = Object.entries(given).filter(([, v]) => !['string', 'number', 'boolean'].includes(typeof v)).map(([k]) => k);
    if (odd.length) return failure(`Values must be text, numbers or true/false: ${odd.join(', ')}.`);
    if (!args.url && !args.site) return failure('Say which site (its name or address) and what to do there, or pass url and intent.');
    if (args.details && !options.fallback) return failure('Reading details in the person\'s own words needs Muse Spark on this server (MODEL_API_KEY). Pass them by Usher key in values instead.');
    if (!limiter.allow('fill')) return failure('Too many fills this hour; try again later.');
    const base = options.transport ? await options.transport() : await httpTransport(options.registryUrl!, options.keyFile);
    const stop = async (result: ReturnType<typeof failure> | ReturnType<typeof reply>) => (await base.close?.(), result);
    // The journey: url and intent when given, else the site and task in the person's words.
    let url = args.url;
    let intent = args.intent;
    if (!url || !intent) {
      if (!base.resolve) return stop(failure('This server can\'t look sites up by name: pass url and intent.'));
      const found = await base.resolve(args.site ?? url!, args.task).catch((err: Error) => ({ status: 'not_joined' as const, message: err.message }));
      if (found.status === 'not_joined') return stop(failure(found.message));
      if (found.status === 'needs_details') return stop(reply({ status: 'needs_details', message: found.message, choices: found.choices }));
      url ??= found.url;
      intent ??= found.intent;
    }
    const admitted = options.admit ? await options.admit(url) : { release: () => undefined };
    if ('refused' in admitted) return stop(failure(admitted.refused));
    // Before anything runs: the plan's inputs. Wrong values come back now; missing ones are asked later.
    const plan = await base.getPlan(url).catch(() => null);
    let values = Object.fromEntries(Object.entries(given).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v])) as Profile;
    let fromDetails: string[] = [];
    if (args.details) {
      if (!plan) {
        admitted.release();
        return stop(failure('Usher has no plan for this journey yet, so it can\'t read details in the person\'s words. Pass them by Usher key in values.'));
      }
      // Keyed values win, key by key.
      const mapped = await mapDetails(options.fallback!.chat, options.fallback!.model, plan, args.details, { logDir: options.fallback!.logDir, given: () => true }).catch((err: Error) => err);
      if (mapped instanceof Error) {
        admitted.release();
        return stop(failure(`Usher couldn't read the details: ${mapped.message}. Pass them by Usher key in values.`));
      }
      fromDetails = Object.keys(mapped.values).filter((k) => !(k in values)).sort();
      values = { ...mapped.values, ...values };
    }
    if (plan) {
      const inputs = plan.inputs.filter((i) => i.risk !== 'needs_user');
      let checked = preflight(inputs, values);
      // An answer no rule matches to an option: Muse Spark chooses among the labels, or none.
      if (options.fallback && checked.problems.some((p) => p.problem === 'not_an_option')) {
        for (const p of checked.problems.filter((x) => x.problem === 'not_an_option')) {
          const input = inputs.find((i) => i.key === p.key);
          const picked = input?.options ? await pickOption(options.fallback.chat, options.fallback.model, input, input.options.items, String(values[p.key])).catch(() => null) : null;
          if (picked !== null) values = { ...values, [p.key]: picked };
        }
        checked = preflight(inputs, values);
      }
      values = { ...values, ...checked.normalised };
      const wrong = checked.problems.filter((p) => p.problem !== 'missing');
      if (wrong.length) {
        await base.close?.();
        admitted.release();
        return reply({ status: 'invalid', ...(fromDetails.length && { read_from_details: fromDetails }), problems: wrong.map((p) => ({ key: p.key, message: p.message, ...(p.expected && { expected: p.expected }) })) });
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
      proposed: new Map(),
      permitted: new Set(plan?.inputs.filter(permitted).map((i) => i.key)),
      ...(fromDetails.length && { fromDetails }),
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
    for (const q of job.planned) if (q.kind === 'confirm_value') job.proposed.set(q.key, String(values[q.key]));
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
      short: shortName(f.key, f.label, kind),
    });

    const user: UserChannel = {
      async review(d: PageDecisions, page: Page) {
        // A required medical question the site hasn't permitted an agent to enter stops the fill: the
        // person answers it on the site.
        const medical = d.userOnly.filter((f) => SENSITIVE.has(f.key));
        if (medical.some((f) => f.required)) return { stop: `This page asks medical questions (${medical.map((f) => `"${f.label}"`).join(', ')}) that this site leaves to the person: they finish on the site.` };
        // An answer the person gave that is theirs alone (whether they smoke) is entered as they said
        // it, and put back to them with the submit, on the same card: if it isn't right, nothing is
        // submitted.
        const toConfirm = (key: string) => job.planned.some((p) => p.key === key && p.kind === 'confirm_value');
        const confirmNow = d.advance ? job.planned.filter((p) => p.kind === 'confirm_value' && !job.answers.has(p.key)) : [];
        const here: Decision[] = [
          ...confirmNow,
          ...d.userOnly.filter((f) => !SENSITIVE.has(f.key) && !toConfirm(f.key)).map((f) => decisionFor(f, kindOf(f), d.path)),
          // A field the site permits is the person's own answer, not a yes or no to filling it.
          ...d.confirmFields.filter((f) => !job.permitted.has(f.key)).map((f) => decisionFor(f, 'optional_consent', d.path)),
          ...(d.advance ? [{ key: d.advance.key, label: d.advance.label, kind: 'submit' as const, page: d.path, short: shortName(d.advance.key, d.advance.label, 'submit') }] : []),
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
          const laterBlocks: Block[] = later.map((q) => ({ kind: q.kind === 'missing_value' || q.kind === 'confirm_value' ? 'question' : q.kind === 'submit' ? 'disclosure' : 'consent', text: q.label, verbatim: false, source: { key: q.key } }));
          const stop = await ask([...toAsk, ...later], [...blocks.filter((b) => !b.source.key || keys.has(b.source.key)), ...laterBlocks.filter((b) => b.kind !== 'disclosure')], d.path);
          if (stop) return { stop };
        }
        const answered = [...d.missing, ...d.confirmFields.filter((f) => job.permitted.has(f.key))].filter((f) => typeof job.answers.get(f.key) === 'string');
        const profile = Object.fromEntries(answered.map((f) => [f.key, job.answers.get(f.key)!])) as Profile;
        return { profile };
      },
      async confirm(element: MapAction | MapField) {
        // A permitted field is entered as the person said it, and put back to them with the submit.
        if (job.permitted.has(element.key)) return true;
        return job.answers.get(element.key) === true;
      },
      async handoff(field: MapField, page: Page) {
        // The user's own answer, as they gave it at a pause or said it (to be confirmed with the
        // submit); nothing else from `values`. Never a medical question.
        const answer = job.answers.get(field.key) ?? job.proposed.get(field.key);
        if (answer === undefined || SENSITIVE.has(field.key)) return;
        if (field.control === 'checkbox') {
          const target = page.getByLabel(field.label, { exact: true });
          await (answer === true ? target.check() : target.uncheck()).catch(() => undefined);
        } else if (typeof answer === 'string') await fillField(page, field, answer).catch(() => undefined);
      },
    };
    const onEvent = (event: AgentEvent) => {
      if (event.type === 'action') job.actions.push({ page: event.path, action: event.action, key: event.key });
    };
    // needs_user keys are never taken from values: only the user's answer at the pause fills them.
    // A field the site permits stays in: the agent enters it as said, and it is confirmed with the submit.
    const profile = Object.fromEntries(Object.entries(values).filter(([k]) => job.permitted.has(k) || !job.planned.some((q) => q.key === k && q.kind !== 'missing_value'))) as Profile;
    job.run = (async (): Promise<RunResult> => {
      try {
        return await runAgent({
          browser: await browser!,
          url: url!,
          intent: intent!,
          profile,
          registry: transport,
          user,
          ...(options.shareMaps && { shareMaps: true }),
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
        return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err), session: null, final_url: job.page?.url() ?? url!, pages: [], maps_submitted: 0, transport: 'http', total_ms: 0, knock_ms: 0, model_ms: 0, fill_ms: 0, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 }, cost_usd: 0, plan_used: false };
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
        confirmation: z.string().optional().describe('The person\'s reply, word for word (for example "Confirm: declaration yes, marketing no, get my quote yes"). Usher reads the answers from it.'),
        answer: z.any().optional().describe('Older clients: the answer when only one decision is pending.'),
      },
      // It submits on the person's behalf: clients that ask before such actions should ask.
      annotations: { title: 'Submit with the person\'s answers', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      ...meta,
    },
    async (args) => {
      const job = jobs.get(args.id);
      const pending = job?.pending;
      if (!job || !pending) return failure(`Nothing is waiting under ${args.id}.`);
      // The person's own words first; answers by key, where the agent gave them, take precedence.
      const read = args.confirmation ? parseConfirmation(args.confirmation, pending.decisions) : {};
      const given: Record<string, unknown> = { ...Object.fromEntries(Object.entries(read).filter(([, v]) => v !== undefined)), ...(args.answers ?? {}) };
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
        // A confirmed answer is entered as the person gave it; one they say isn't right is not entered.
        if (d.kind === 'confirm_value') job.answers.set(d.key, yes(v) ? job.proposed.get(d.key)! : false);
        else job.answers.set(d.key, d.kind === 'missing_value' ? String(v) : v === undefined ? false : yes(v));
      }
      const refused = pending.decisions.find((d) => (d.kind === 'required_consent' || d.kind === 'submit' || d.kind === 'confirm_value') && job.answers.get(d.key) === false);
      job.pending = undefined;
      // Answered: the wait for the person is over, and the run gets its own time again (a late
      // answer must not cut the rest of the fill short).
      clearTimeout(job.expires);
      job.expires = setTimeout(() => void finish(job), decisionTimeout + stepTimeout).unref();
      pending.resolve(refused ? (refused.kind === 'confirm_value' ? `The user said "${refused.value}" isn't their answer to "${refused.label}". Nothing was submitted: fill again with their answer.` : `The user said no to "${refused.label}".`) : undefined);
      return next(job);
    },
  );

  server.registerTool(
    'usher_cancel',
    {
      title: 'Abandon a fill',
      description: 'Your user said no, or changed their mind: abandon the fill usher_fill started. Nothing more is entered or submitted.',
      inputSchema: { id: z.string() },
      annotations: { title: 'Abandon a fill', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
