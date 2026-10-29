// Site apps (LU-57): the hosted MCP server scoped to one joined site, at /mcp/<host>. Its tools are
// generated from the site's plans, one per journey: the name from the intent
// (quote.health_insurance is get_health_insurance_quote, unless the owner renames it), the
// description from the journey's title and the site's own guidance, and the parameters from the
// plan's ask_first by semantic key, with the site's labels, its options as enums and its formats.
// Underneath is usher_fill: the same engine, pauses, verbatim wording and usher_confirm. None of
// the generic tools (knock, get_plan and the rest) are here, and the endpoint acts on no other site.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Registry, SiteApp } from '@usher/registry';
import type { registerFillTools } from './fill.ts';

/** A tool name from an intent: quote.health_insurance is get_health_insurance_quote; contact.callback is request_callback. */
export function toolNameFor(intent: string): string {
  const [verb, ...rest] = intent.split('.');
  const object = rest.join('_');
  const name = verb === 'quote' ? `get_${object}_quote` : verb === 'contact' ? `request_${object}` : verb === 'apply' ? `apply_for_${object}` : `${verb}_${object}`;
  return name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 64);
}

/** A parameter name from a semantic key: person.first_name is person_first_name. */
export const paramFor = (key: string) => key.replace(/[^A-Za-z0-9_]+/g, '_');

export interface SiteToolParam {
  name: string;
  key: string;
  description: string;
  options?: string[];
  required: boolean;
}

export interface SiteTool {
  name: string;
  intent: string;
  url: string;
  title: string;
  description: string;
  params: SiteToolParam[];
}

/** The tools a site's app shows, from its plans and the owner's settings (renamed, hidden, described). */
export async function siteTools(registry: Registry, origin: string, app: SiteApp): Promise<SiteTool[]> {
  const name = await registry.siteName(origin);
  const rules = (await registry.storage.getPolicy(origin))?.text;
  const out: SiteTool[] = [];
  for (const journey of await registry.journeys(origin)) {
    const own = app.tools?.[journey.intent] ?? {};
    if (own.hidden) continue;
    const found = await registry.browserPlanFor(`${origin}${journey.start}`, journey.intent);
    if (!found) continue;
    const params: SiteToolParam[] = found.view.ask_first.map((a) => ({
      name: paramFor(a.key),
      key: a.key,
      description: [a.label, a.theirs ? 'Their own answer: only as they said it; Usher puts it back to them before anything is submitted.' : '', a.format ? `As ${a.format}.` : '', a.only_if ? `Only ${a.only_if}.` : ''].filter(Boolean).join(' '),
      ...(a.options && !a.more_options && { options: a.options }),
      required: a.required,
    }));
    const title = `${journey.title.replace(/^(.)/, (c) => c.toUpperCase())} from ${name}`;
    const description = [
      own.description?.trim() || `${title}.`,
      'Give what the person has told you by these parameters, or their own words in details. Usher fills the form on the site; anything missing, and anything that is theirs to decide (the site\'s own wording, word for word, and the final step), comes back as a short set of questions for them, which you put to them and answer with usher_confirm. Never answer for them.',
      `Runs under ${name}'s rules${rules ? `: ${rules.trim()}` : '.'}`,
    ].join(' ');
    out.push({ name: own.name?.trim() || toolNameFor(journey.intent), intent: journey.intent, url: `${origin}${journey.start}`, title, description, params });
  }
  return out;
}

export type FillCall = ReturnType<typeof registerFillTools>['fill'];

/** Registers a site's generated tools, each a fill of its journey by key. */
export function registerSiteTools(server: McpServer, tools: SiteTool[], fill: FillCall, meta?: Record<string, unknown>): void {
  for (const tool of tools) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const p of tool.params) shape[p.name] = (p.options?.length ? z.enum(p.options as [string, ...string[]]) : z.string()).optional().describe(p.description);
    shape.details = z.string().optional().describe('Or the person\'s details in their own words, word for word. Usher reads them against the form\'s own fields.');
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: shape, annotations: { title: tool.title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, ...(meta && { _meta: meta }) },
      async (args: Record<string, unknown>) => {
        const values: Record<string, string> = {};
        for (const p of tool.params) if (typeof args[p.name] === 'string' && args[p.name] !== '') values[p.key] = args[p.name] as string;
        return (await fill({ url: tool.url, intent: tool.intent, values, ...(typeof args.details === 'string' && args.details.trim() && { details: args.details }) })) as CallToolResult;
      },
    );
  }
}
