// The plan path, for an assistant that drives its own browser (the product; usher_fill is the
// fallback for assistants with none). get_plan hands over the journey as Usher mapped it, with the
// rules in plain words and what to ask the person first; where the client shows MCP Apps cards,
// the ask-first questions, the site's declaration word for word and its final step render as
// Usher's card. prepare_run takes the person's answers and hands the plan back with each value in
// the site's own form against its field, and, on a joined site, the token in an entry URL. Usher
// never opens the site with the person's values; their own browser does. Values live only in the
// reply: nothing is stored, logged or kept in a session.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { confirmableStops, placeValues, type BrowserPlan, type ChatFn, type Profile } from '@usher/core';
import type { KnockInput, KnockResponse, Registry } from '@usher/registry';
import { mapDetails } from './details.ts';
import { shortName, type Decision } from './fill.ts';

export interface PlanToolOptions {
  registry: Registry;
  /** The knock as this connection (hosted: in-process, signed with the connection's key). */
  knock: (input: KnockInput) => Promise<KnockResponse>;
  /** Reading the person's details in their own words (Muse Spark, within the daily cap). */
  details?: { chat: ChatFn; model: string };
  /** The card a plan renders as, in clients with MCP Apps. */
  meta?: Record<string, unknown>;
}

export const GET_PLAN_DESCRIPTION =
  'Use this first when your user wants a form filled and you can drive a browser yourself. Returns Usher\'s plan for the journey: the rules in plain words, ask_first (every detail to ask your user for, in one go, before you start), the steps in order with each field\'s key, label, options, format and where to find it, and the stops where you must show your user the site\'s own wording and wait. Then call prepare_run with their answers. If Usher hasn\'t mapped the site, it says so: fill it by sight.';

export const PREPARE_RUN_DESCRIPTION =
  'Call after get_plan, with your user\'s answers: values by key (from ask_first), or their details as they said them, and confirmed: the stop keys they have said yes to (the declaration, the final step). Returns the plan with each value in the site\'s own form against its field, problems by key for anything the site won\'t accept (ask your user again), and on a joined site an entry_url carrying the token: open it, fill in order by the find hints, run each lookup with the value given, stop at every stop and wait for your user, and submit only after they confirm. Usher keeps none of the values.';

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
      const value = { status: 'needs_decision', plan_for: 'browser', url: found.view.steps[0]!.url, intent: found.plan.intent, decisions, blocks, plan: found.view };
      const lead = `Usher's plan for ${found.view.site.name} (${found.view.known}). Ask your user for ask_first in one go, unless the Usher card is showing it, then call prepare_run with their answers and the stops they confirm.`;
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
      const confirmable = new Set(confirmableStops(found.view));
      const confirmed = (args.confirmed ?? []).filter((k) => confirmable.has(k));
      let entry: { entry_url: string; expires_at: string; session: string; confirmed: string[] } | { token_error: string } | undefined;
      if (found.view.site.joined) {
        try {
          const k = await options.knock({ url: found.view.steps[0]!.url, ...(found.plan.intent && { intent: found.plan.intent }), ...(confirmed.length && { confirmed }) });
          entry = k.entry_url ? { entry_url: k.entry_url, expires_at: k.expires_at, session: k.session, confirmed } : { token_error: 'The registry gave no entry URL.' };
        } catch (err) {
          entry = { token_error: err instanceof Error ? err.message : String(err) };
        }
      }
      const value = { status: 'ready', plan: placed, ...entry };
      const lead = placed.problems?.length
        ? `Some answers won't fit the site: ${placed.problems.map((p) => p.key).join(', ')}. Ask your user again, then call prepare_run once more.`
        : entry && 'entry_url' in entry
          ? 'Open entry_url in your browser, then fill each step in order by the find hints and values given, run each lookup, and stop at every stop for your user. The token is in the entry URL and lasts 10 minutes.'
          : 'Open the first step\'s url in your browser, then fill each step in order by the find hints and values given, and stop at every stop for your user.';
      return { content: [{ type: 'text' as const, text: lead }, { type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
    },
  );
}
