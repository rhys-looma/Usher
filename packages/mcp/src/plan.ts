// The plan path, for an assistant that drives its own browser (the product; usher_fill is the
// fallback for assistants with none). get_plan hands over the journey as Usher mapped it, with the
// rules in plain words and what to ask the person first; where the client shows MCP Apps cards,
// the ask-first questions, the site's declaration word for word and its final step render as
// Usher's card. prepare_run takes the person's answers and hands the plan back with each value in
// the site's own form against its field, and, on a joined site, the token in an entry URL. Usher
// never opens the site with the person's values; their own browser does. Values live only in the
// reply: nothing is stored, logged or kept in a session.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { confirmableStops, placeValues, type BrowserPlan, type ChatFn, type Profile } from '@usher/core';
import type { KnockInput, KnockResponse, Registry } from '@usher/registry';
import { mapDetails } from './details.ts';
import { shortName, type Decision } from './fill.ts';

/**
 * Which plans have been prepared, so a card left open in the chat can tell when the person answered
 * in the chat instead and close itself. Holds a random id, the connection, the start URL and a
 * time: never a value. Shared across connections (a card's calls may come in on another one); an
 * hour, then forgotten.
 */
export class PlanTickets {
  private readonly open = new Map<string, { connection: string; url: string; at: number; prepared?: true }>();
  constructor(private readonly now: () => number = Date.now) {}

  issue(connection: string, url: string): string {
    this.prune();
    const id = `p_${randomBytes(12).toString('base64url')}`;
    this.open.set(id, { connection, url, at: this.now() });
    return id;
  }

  /** prepare_run ran: by the plan_id it was given, or for the same start URL on the same connection. */
  prepared(id: string | undefined, connection: string, url: string): void {
    const own = id ? this.open.get(id) : undefined;
    if (own) own.prepared = true;
    else for (const t of this.open.values()) if (t.connection === connection && t.url === url) t.prepared = true;
  }

  status(id: string): 'waiting' | 'prepared' | 'unknown' {
    const t = this.open.get(id);
    return !t || this.now() - t.at > HOUR ? 'unknown' : t.prepared ? 'prepared' : 'waiting';
  }

  private prune(): void {
    const cutoff = this.now() - HOUR;
    for (const [id, t] of this.open) if (t.at < cutoff || this.open.size > 5000) this.open.delete(id);
  }
}
const HOUR = 3_600_000;

export interface PlanToolOptions {
  registry: Registry;
  /** The knock as this connection (hosted: in-process, signed with the connection's key). */
  knock: (input: KnockInput) => Promise<KnockResponse>;
  /** Reading the person's details in their own words (Muse Spark, within the daily cap). */
  details?: { chat: ChatFn; model: string };
  /** The card a plan renders as, in clients with MCP Apps. */
  meta?: Record<string, unknown>;
  /** Plans issued and prepared, for the card's plan_status; with this connection's id. */
  tickets?: { store: PlanTickets; connection: string };
}

export const GET_PLAN_DESCRIPTION =
  'Use this first when your user wants a form filled and you can drive a browser yourself. Returns Usher\'s plan for the journey: the rules in plain words, ask_first (every detail to ask your user for, in one go, before you start), the steps in order with each field\'s key, label, options, format and where to find it, and the stops where you must show your user the site\'s own wording and wait. Then call prepare_run with their answers. If Usher hasn\'t mapped the site, it says so: fill it by sight.';

export const PREPARE_RUN_DESCRIPTION =
  'Call after get_plan, with your user\'s answers: values by key (from ask_first), or their details as they said them, and confirmed: the stop keys they have said yes to (the final step, and a declaration unless it is user_only). Dates may be 1988-03-14, 14/03/1988 or 14 March 1988. Returns the plan with each value in the site\'s own form against its field, problems by key for anything the site won\'t accept (ask your user again), and on a joined site, once every answer fits, an entry_url carrying the token: open it, fill in order by the find hints, run each lookup with the value given, stop at every stop and wait for your user, ask them to do anything user_only themselves, and submit only after they confirm. Usher keeps none of the values.';

const notMapped = (origin: string) => ({
  content: [{ type: 'text' as const, text: `Usher hasn't mapped ${origin} yet, so there is no plan. Fill it by sight in your user's browser, asking them before anything is submitted. Usher has noted that an assistant asked for it.` }],
  structuredContent: { status: 'not_mapped', origin } as Record<string, unknown>,
});

/** The plan's ask-first questions and confirmable stops as the decision card shows them. */
function decisionsOf(plan: BrowserPlan): { decisions: (Decision & { required?: boolean })[]; blocks: { kind: 'consent'; text: string; verbatim: true; source: { key: string; url: string } }[] } {
  const decisions: (Decision & { required?: boolean })[] = plan.ask_first.map((a) => ({
    key: a.key,
    label: a.label,
    kind: 'missing_value',
    page: '',
    ...(a.control && { control: a.control }),
    ...(a.options && { options: a.options }),
    required: a.required || Boolean(a.theirs),
    short: shortName(a.key, a.label, 'missing_value'),
  }));
  const blocks: ReturnType<typeof decisionsOf>['blocks'] = [];
  const confirmable = new Set(confirmableStops(plan));
  for (const s of plan.stops) {
    if (!confirmable.has(s.key)) continue;
    const url = plan.steps.find((p) => p.n === s.step)?.url ?? plan.site.origin;
    if (s.key.startsWith('consent.')) {
      decisions.push({ key: s.key, label: s.label, kind: 'required_consent', page: new URL(url).pathname, short: shortName(s.key, s.label, 'required_consent') });
      if (s.verbatim) blocks.push({ kind: 'consent', text: s.verbatim, verbatim: true, source: { key: s.key, url } });
    } else decisions.push({ key: s.key, label: s.label, kind: 'submit', page: new URL(url).pathname, short: shortName(s.key, s.label, 'submit') });
  }
  return { decisions, blocks };
}

export function registerPlanTools(server: McpServer, options: PlanToolOptions): void {
  server.registerTool(
    'get_plan',
    {
      title: 'Get the plan for a form',
      description: GET_PLAN_DESCRIPTION,
      inputSchema: {
        url: z.string().url().describe('The site\'s page where the journey starts, or its home page.'),
        intent: z.string().optional().describe('What the person wants done, as an Usher intent (quote.life_insurance), if you know it.'),
      },
      annotations: { title: 'Get the plan for a form', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ...(options.meta && { _meta: options.meta }),
    },
    async (args) => {
      const found = await options.registry.browserPlanFor(args.url, args.intent);
      if (!found) return notMapped(new URL(args.url).origin);
      const { decisions, blocks } = decisionsOf(found.view);
      const url = found.view.steps[0]!.url;
      const plan_id = options.tickets?.store.issue(options.tickets.connection, url);
      const value = { status: 'needs_decision', plan_for: 'browser', url, intent: found.plan.intent, ...(plan_id && { plan_id }), decisions, blocks, plan: found.view };
      const lead = `Usher's plan for ${found.view.site.name} (${found.view.known}). Ask your user for ask_first in one go, unless the Usher card is showing it, then call prepare_run with their answers and the stops they confirm${plan_id ? `, and plan_id ${plan_id}` : ''}.`;
      return { content: [{ type: 'text' as const, text: lead }, { type: 'text' as const, text: JSON.stringify(found.view) }], structuredContent: value as Record<string, unknown> };
    },
  );

  server.registerTool(
    'prepare_run',
    {
      title: 'Prepare the run with the person\'s answers',
      description: PREPARE_RUN_DESCRIPTION,
      inputSchema: {
        url: z.string().url(),
        intent: z.string().optional(),
        values: z.record(z.string(), z.union([z.string(), z.boolean()])).optional().describe('Answers by key, from ask_first.'),
        details: z.string().optional().describe('Or the person\'s details in their own words, word for word.'),
        confirmed: z.array(z.string()).optional().describe('Stop keys the person has said yes to: consent.declaration, form.submit.'),
        plan_id: z.string().optional().describe('The plan_id get_plan gave, so the Usher card knows your user answered in the chat.'),
      },
      annotations: { title: 'Prepare the run with the person\'s answers', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const found = await options.registry.browserPlanFor(args.url, args.intent);
      if (!found) return notMapped(new URL(args.url).origin);
      const values: Profile = {};
      if (args.details && options.details) {
        // Read with the plan's inputs; never logged (logDir null), never kept.
        const mapped = await mapDetails(options.details.chat, options.details.model, found.plan, args.details, { logDir: null, given: (k) => args.values?.[k] !== undefined });
        Object.assign(values, mapped.values);
      }
      Object.assign(values, args.values ?? {});
      const placed = placeValues(found.view, found.plan, found.maps, values);
      options.tickets?.store.prepared(args.plan_id, options.tickets.connection, found.view.steps[0]!.url);
      const confirmable = new Set(confirmableStops(found.view));
      const confirmed = (args.confirmed ?? []).filter((k) => confirmable.has(k));
      let entry: { entry_url: string; expires_at: string; session: string; confirmed: string[] } | { token_error: string } | undefined;
      // No token while answers won't fit: it lasts ten minutes, and the assistant asks again first.
      if (found.view.site.joined && !placed.problems?.length) {
        try {
          const k = await options.knock({ url: found.view.steps[0]!.url, ...(found.plan.intent && { intent: found.plan.intent }), ...(confirmed.length && { confirmed }) });
          entry = k.entry_url ? { entry_url: k.entry_url, expires_at: k.expires_at, session: k.session, confirmed } : { token_error: 'The registry gave no entry URL.' };
        } catch (err) {
          entry = { token_error: err instanceof Error ? err.message : String(err) };
        }
      }
      const value = { status: placed.problems?.length ? 'needs_answers' : 'ready', plan: placed, ...entry };
      const lead = placed.problems?.length
        ? `Some answers won't fit the site: ${placed.problems.map((p) => `${p.key} (${p.message})`).join('; ')}. Ask your user again, then call prepare_run once more. There is no entry_url until they fit.`
        : entry && 'entry_url' in entry
          ? 'Open entry_url in your browser, then fill each step in order by the find hints and values given, run each lookup, and stop at every stop for your user. The token is in the entry URL and lasts 10 minutes.'
          : 'Open the first step\'s url in your browser, then fill each step in order by the find hints and values given, and stop at every stop for your user.';
      return { content: [{ type: 'text' as const, text: lead }, { type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
    },
  );
  if (!options.tickets) return;
  const tickets = options.tickets;
  // For the card only: has this plan been prepared (in the chat, say) since it was shown?
  server.registerTool(
    'plan_status',
    {
      title: 'Has this plan been prepared?',
      description: 'For the Usher card: whether prepare_run has run for this plan_id. Assistants don\'t need it.',
      inputSchema: { plan_id: z.string() },
      annotations: { title: 'Has this plan been prepared?', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private' },
    },
    async (args) => {
      const status = tickets.store.status(args.plan_id);
      return { content: [{ type: 'text' as const, text: status }], structuredContent: { status } };
    },
  );
}
