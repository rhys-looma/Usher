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
import type { SiteTool } from '@usher/registry';
import type { registerFillTools } from './fill.ts';

export { paramFor, siteTools, toolNameFor, type SiteTool, type SiteToolParam } from '@usher/registry';

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
