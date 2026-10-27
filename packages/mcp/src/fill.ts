// usher_fill, usher_confirm, usher_cancel: Usher does the filling. The agent hands over its user's
// values by semantic key; the MCP server knocks with the agent's own key, runs Usher's executor in
// its own headless browser (a fresh context per call), fills every page by the map, and stops for
// the user at each decision: a consequential action, or a field that is the user's to answer
// (needs_user fields are never filled from `values`). The agent asks its user and answers with
// usher_confirm or usher_cancel. Values never leave this process except into the site's own form.

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
import { budgeted, compilerModel, modelApi, type ChatFn, type MapAction, type MapField, type SpendLedger } from '@usher/core';
import { RateLimiter } from '../../registry/src/rate-limit.ts';
import { httpTransport, runAgent, type AgentEvent, type FallbackModel, type Profile, type RunResult, type UserChannel } from '../../agent/src/index.ts';

/** What the caller is asked to decide. */
interface Decision {
  kind: 'confirm' | 'needs_user';
  key: string;
  label: string;
  risk: string;
  page: string;
  /** For needs_user: what the field takes. */
  control?: string;
  options?: string[];
}

interface Job {
  id: string;
  run: Promise<RunResult>;
  page?: Page;
  actions: { page: string; action: string; key: string }[];
  decision?: Decision & { answer: (value: boolean | string | null) => void };
  /** Wakes whoever waits for the next decision or the end. */
  changed: () => void;
  wait: Promise<void>;
  expires: NodeJS.Timeout;
  started: number;
}

export interface FillOptions {
  registryUrl: string;
  keyFile: string;
  /** For pages with no map: Muse Spark (MODEL_API_KEY), within the daily cap. */
  fallback?: FallbackModel;
  /** Launch the browser (tests pass their own). */
  browser?: () => Promise<Browser>;
  /** How long a run may go before it reaches a decision or the end. */
  stepTimeoutMs?: number;
  /** How long a decision waits for usher_confirm or usher_cancel. */
  decisionTimeoutMs?: number;
  /** usher_fill calls per hour. */
  perHour?: number;
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

const describe = (job: Job) => ({ page: job.page?.url() });

export function registerFillTools(server: McpServer, options: FillOptions): { close: () => Promise<void> } {
  const jobs = new Map<string, Job>();
  const limiter = new RateLimiter(options.perHour ?? 20, 3_600_000);
  let browser: Promise<Browser> | undefined;
  const stepTimeout = options.stepTimeoutMs ?? 120_000;
  const decisionTimeout = options.decisionTimeoutMs ?? 600_000;

  const text = (value: unknown, image?: string) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }, ...(image ? [{ type: 'image' as const, data: image, mimeType: 'image/png' }] : [])],
    structuredContent: value as Record<string, unknown>,
  });

  /** A screenshot of the page with every value masked: for failures, so the agent can see why. */
  async function maskedShot(page: Page | undefined): Promise<string | undefined> {
    if (!page || page.isClosed()) return undefined;
    const shot = await page.screenshot({ mask: [page.locator('input, select, textarea')], maskColor: '#191942' }).catch(() => undefined);
    return shot?.toString('base64');
  }

  /** Waits for the job's next decision or its end, and says which. */
  async function next(job: Job) {
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), stepTimeout).unref());
    const ended = job.run.then((r) => ({ r }));
    for (;;) {
      if (job.decision) {
        const { answer: _, ...decision } = job.decision;
        return text({ status: 'needs_decision', id: job.id, decision, actions_so_far: job.actions.length, elapsed_ms: Math.round(performance.now() - job.started) });
      }
      const woke = await Promise.race([ended, job.wait.then(() => 'changed' as const), timeout]);
      if (woke === 'timeout') {
        const image = await maskedShot(job.page);
        await finish(job);
        return text({ status: 'failed', id: job.id, reason: `No decision or end within ${stepTimeout / 1000} s; the run was stopped.`, ...describe(job) }, image);
      }
      if (woke !== 'changed') {
        const r = woke.r;
        // Values that failed pre-flight: nothing ran, so the caller fixes them and tries again.
        const invalid = Boolean(r.problems?.length) && job.actions.length === 0;
        const image = r.outcome === 'completed' || invalid ? undefined : await maskedShot(job.page);
        await finish(job);
        return text(
          {
            status: invalid ? 'invalid' : r.outcome,
            id: job.id,
            ...(r.reason && { reason: r.reason }),
            ...(r.problems && { problems: r.problems.map((p) => ({ key: p.key, message: p.message })) }),
            session: r.session,
            final_url: r.final_url,
            actions: job.actions,
            used_model: r.pages.filter((p) => p.map_source === 'compiled').map((p) => p.path),
            elapsed_ms: Math.round(performance.now() - job.started),
          },
          image,
        );
      }
    }
  }

  async function finish(job: Job): Promise<void> {
    clearTimeout(job.expires);
    jobs.delete(job.id);
    job.decision?.answer(null);
    await job.page?.context().close().catch(() => undefined);
  }

  server.registerTool(
    'usher_fill',
    {
      title: 'Fill a form with Usher',
      description:
        'Fill a whole form journey for your user, by meaning, in one call. Pass the starting page URL, the intent (for example quote.car_insurance) and the user\'s values keyed by Usher vocabulary keys (person.first_name, contact.email, vehicle.registration, …). Usher knocks with your key, fills every page from the site\'s map in its own browser, and stops at each decision for your user: a consequential action (such as Get my quote) or a field only the user may answer (such as a declaration). Ask your user, then call usher_confirm with the id (and the user\'s answer for a needs_user field) or usher_cancel. Invalid values come back first as problems by key, before anything runs.',
      inputSchema: { url: z.string().url(), intent: z.string(), values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) },
    },
    async (args) => {
      if (!limiter.allow('fill')) return { isError: true, content: [{ type: 'text' as const, text: 'Too many fills this hour; try again later.' }] };
      browser ??= (options.browser ?? launchChromium)();
      const transport = await httpTransport(options.registryUrl, options.keyFile);
      let changed!: () => void;
      const job: Job = {
        id: `f_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        actions: [],
        started: performance.now(),
        run: undefined as unknown as Promise<RunResult>,
        changed: () => changed(),
        wait: new Promise<void>((r) => (changed = r)),
        expires: setTimeout(() => void finish(job), decisionTimeout + stepTimeout).unref(),
      };
      const rearm = () => {
        const wake = changed;
        job.wait = new Promise<void>((r) => (changed = r));
        wake();
      };
      // The user, reached through the calling agent: each decision pauses the run until answered.
      const decide = (decision: Decision) =>
        new Promise<boolean | string | null>((resolve) => {
          // A fill that was cancelled or timed out: every later decision is a no.
          if (!jobs.has(job.id)) return resolve(null);
          job.decision = { ...decision, answer: resolve };
          // Each decision waits its own while for an answer, then the fill is abandoned.
          clearTimeout(job.expires);
          job.expires = setTimeout(() => void finish(job), decisionTimeout).unref();
          rearm();
        });
      const user: UserChannel = {
        async confirm(action: MapAction | MapField, page: Page) {
          const answer = await decide({ kind: 'confirm', key: action.key, label: action.label, risk: action.risk, page: page.url() });
          return answer !== null && answer !== false;
        },
        async handoff(field: MapField, page: Page) {
          const choices = field.options ? field.options.items.map((o) => o.label) : undefined;
          const answer = await decide({ kind: 'needs_user', key: field.key, label: field.label, risk: field.risk, page: page.url(), control: field.control, ...(choices && { options: choices }) });
          // The user's own answer, entered as they gave it; nothing from `values`.
          if (answer === null) return;
          const target = page.getByLabel(field.label, { exact: true });
          if (field.control === 'checkbox') await (answer === true || answer === 'true' || answer === 'yes' ? target.check() : target.uncheck()).catch(() => undefined);
          else if (typeof answer === 'string') await target.fill(answer).catch(() => undefined);
        },
      };
      const onEvent = (event: AgentEvent) => {
        if (event.type === 'action') job.actions.push({ page: event.path, action: event.action, key: event.key });
      };
      // needs_user keys are never taken from values: only the user's answer at the pause fills them.
      job.run = (async (): Promise<RunResult> => {
        try {
          return await runAgent({
            browser: await browser!,
            url: args.url,
            intent: args.intent,
            profile: Object.fromEntries(Object.entries(args.values).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v])) as Profile,
            registry: transport,
            user,
            ...(options.fallback && { fallback: options.fallback }),
            onPage: (page) => void (job.page = page),
            onEvent,
          });
        } catch (err) {
          // A run that broke (or whose page a cancel closed) ends as failed, never as a crash.
          return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err), session: null, final_url: job.page?.url() ?? args.url, pages: [], maps_submitted: 0, transport: 'http', total_ms: 0, knock_ms: 0, model_ms: 0, fill_ms: 0, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 }, cost_usd: 0, plan_used: false };
        } finally {
          await transport.close?.();
          rearm();
        }
      })();
      jobs.set(job.id, job);
      return next(job);
    },
  );

  server.registerTool(
    'usher_confirm',
    {
      title: 'Go ahead with a decision',
      description: 'Your user agreed to the decision usher_fill stopped at: go ahead and continue to the end, or to the next decision. For a needs_user field, pass the user\'s own answer (true or false for a checkbox, otherwise the text).',
      inputSchema: { id: z.string(), answer: z.union([z.boolean(), z.string()]).optional() },
    },
    async (args) => {
      const job = jobs.get(args.id);
      if (!job?.decision) return { isError: true, content: [{ type: 'text' as const, text: `Nothing is waiting under ${args.id}.` }] };
      const { answer } = job.decision;
      job.decision = undefined;
      answer(args.answer ?? true);
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
      if (!job) return { isError: true, content: [{ type: 'text' as const, text: `No fill ${args.id}.` }] };
      await finish(job);
      return text({ status: 'cancelled', id: args.id, actions: job.actions });
    },
  );

  return {
    async close() {
      for (const job of [...jobs.values()]) await finish(job);
      if (browser) await (await browser).close().catch(() => undefined);
    },
  };
}
