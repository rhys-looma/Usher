// MCP server for agents (LU-21): knock, get_map, submit_map and report_run as tools, signing
// with the agent's own key and calling the registry over HTTP. Published as @usher-run/mcp
// (packages/mcp); from a checkout:
//
//   USHER_REGISTRY_URL=https://registry.example tsx packages/registry/src/mcp.ts
//
// USHER_AGENT_KEY_FILE names the agent's key file (default ~/.usher/agent-key.json, created
// on first use).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Fingerprint, UsherMap } from '@usher/core';
import { RegistryClient, type KnockInput, type RunReport } from './client.ts';
import { loadOrCreateIdentity } from './identity-file.ts';

const fingerprint = z.object({ algo: z.literal('usher-fp-1'), digest: z.string(), signature: z.array(z.string()) });

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

async function guarded(work: () => Promise<unknown>) {
  try {
    return result(await work());
  } catch (err) {
    return { isError: true, content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }] };
  }
}

/** What the tools call: the registry over HTTP (RegistryClient), or in-process for hosted connections. */
export interface RegistryTools {
  knock(input: KnockInput): Promise<unknown>;
  lookup(origin: string, path: string, fingerprint: Fingerprint): Promise<unknown>;
  getMap(origin: string, digest: string): Promise<unknown>;
  getPlan(url: string): Promise<unknown>;
  /** Absent where agents can't share maps (hosted connections). */
  submitMap?(map: UsherMap): Promise<unknown>;
  reportRun(report: RunReport): Promise<unknown>;
}

export async function createMcpServer(registryUrl: string, keyFile?: string, version = '0.1.0', options: { knockMeta?: Record<string, unknown> } = {}): Promise<McpServer> {
  const server = new McpServer({ name: 'usher', version });
  registerRegistryTools(server, new RegistryClient(registryUrl.replace(/\/$/, ''), await loadOrCreateIdentity(keyFile)), options);
  return server;
}

/**
 * knock, get_map, get_plan, report_run, and submit_map where the client can share maps.
 * `knockMeta`: tool metadata for knock (the card its result renders as, in clients with MCP Apps).
 */
export function registerRegistryTools(server: McpServer, client: RegistryTools, options: { knockMeta?: Record<string, unknown>; skip?: string[]; theme?: (origin: string) => Promise<unknown> } = {}): void {
  const skip = new Set(options.skip ?? []);

  server.registerTool(
    'knock',
    {
      title: 'Knock on a form',
      description:
        'On a site that has joined Usher, the token for your session (prepare_run knocks for you once your user has answered; call this yourself only to knock again). Returns entry_url: open it in your browser and the site binds the token, so the final step is accepted. Pass confirmed with the stop keys your user has said yes to (consent.declaration, form.submit). Also returns the map and the site\'s rules. Programs without a browser bind the token with window.usher.bind(token).',
      inputSchema: {
        url: z.string().url(),
        intent: z.string().optional(),
        fingerprint: fingerprint.optional(),
        session: z.string().optional(),
        confirmed: z.array(z.string()).optional().describe('Keys your user has just confirmed (e.g. form.submit), when knocking right before acting on them.'),
      },
      ...(options.knockMeta && { _meta: options.knockMeta }),
    },
    async (args) => {
      const reply = await guarded(() =>
        client.knock({
          url: args.url,
          ...(args.intent && { intent: args.intent }),
          ...(args.fingerprint && { fingerprint: args.fingerprint as Fingerprint }),
          ...(args.session && { session: args.session }),
          ...(args.confirmed && { confirmed: args.confirmed }),
        }),
      );
      // The site's theme, for the ticket card only: in structuredContent, not in the text.
      const theme = 'structuredContent' in reply && options.theme ? await options.theme(new URL(args.url).origin).catch(() => undefined) : undefined;
      return theme && 'structuredContent' in reply ? { ...reply, structuredContent: { ...reply.structuredContent, theme } } : reply;
    },
  );

  server.registerTool(
    'get_map',
    {
      title: 'Get a map',
      description: 'Look up the map for a page (url plus fingerprint), or fetch one by digest (url gives the origin). Maps hold structure only.',
      inputSchema: { url: z.string().url(), digest: z.string().optional(), fingerprint: fingerprint.optional() },
    },
    (args) =>
      guarded(async () => {
        const url = new URL(args.url);
        if (args.digest) return client.getMap(url.origin, args.digest);
        if (args.fingerprint) return client.lookup(url.origin, url.pathname, args.fingerprint as Fingerprint);
        throw new Error('Pass a fingerprint or a digest with the url.');
      }),
  );

  if (!skip.has('get_plan')) server.registerTool(
    'get_plan',
    {
      title: 'Get a plan',
      description:
        'Get the plan for a multi-step journey starting at this page: its steps (maps joined by where each step leads) and every input it will ask for by semantic key, with required, constraints and allowed options, so you can check your user\'s data before starting and ask for anything missing.',
      inputSchema: { url: z.string().url() },
    },
    (args) => guarded(() => client.getPlan(args.url)),
  );

  const submit = client.submitMap?.bind(client);
  if (submit) server.registerTool(
    'submit_map',
    {
      title: 'Submit a map',
      description: 'Submit a map built for a page that had none, so the next agent gets a fast path. Must validate against the Usher map schema; never include values.',
      inputSchema: { map: z.record(z.string(), z.unknown()) },
    },
    (args) => guarded(() => submit(args.map as unknown as UsherMap)),
  );

  server.registerTool(
    'report_run',
    {
      title: 'Report a run',
      description: 'At the end, report how the run went: the outcome, and the pages you reached beyond the plan (each one\'s url, and its fields by label and control, never anything typed), so the journey fills in for the next agent. Structure only, never values.',
      inputSchema: {
        session: z.string(),
        url: z.string().url(),
        outcome: z.enum(['completed', 'stopped', 'failed']),
        summary: z.record(z.string(), z.unknown()).optional(),
        pages: z.array(z.object({ url: z.string().url(), fields: z.array(z.object({ label: z.string(), control: z.string(), options: z.array(z.string()).optional() })).max(60), actions: z.array(z.string()).max(30).optional() })).max(10).optional().describe('Pages reached beyond the plan, by structure only.'),
      },
    },
    (args) => guarded(() => client.reportRun({ session: args.session, url: args.url, outcome: args.outcome, ...((args.summary || args.pages) && { summary: { ...(args.summary ?? {}), ...(args.pages && { pages_beyond_plan: args.pages }) } }) })),
  );
}

// Run directly from a checkout (not when bundled into @usher-run/mcp, which has its own entry).
if (/[\\/]registry[\\/]src[\\/]mcp\.ts$/.test(process.argv[1] ?? '')) {
  const url = process.env.USHER_REGISTRY_URL;
  if (!url) {
    console.error('Set USHER_REGISTRY_URL to the registry URL.');
    process.exit(2);
  }
  const server = await createMcpServer(url, process.env.USHER_AGENT_KEY_FILE);
  await server.connect(new StdioServerTransport());
}
