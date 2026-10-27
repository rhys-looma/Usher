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
import { RegistryClient } from './client.ts';
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

export async function createMcpServer(registryUrl: string, keyFile?: string, version = '0.1.0'): Promise<McpServer> {
  const client = new RegistryClient(registryUrl.replace(/\/$/, ''), await loadOrCreateIdentity(keyFile));
  const server = new McpServer({ name: 'usher', version });

  server.registerTool(
    'knock',
    {
      title: 'Knock on a form',
      description:
        'Knock before filling a form on a site that uses Usher (its forms carry data-usher-knock). Returns the map of the form (fields by semantic key, risk, locators), the site rules, and a short-lived token to bind in the page with window.usher.bind(token). Pass the page fingerprint for an exact match and the session id to continue a multi-step journey. If the page publishes its own map (<script type="application/usher+json" data-usher-map>), use that and pass its digest as have_map: the reply then carries only the rules and token.',
      inputSchema: {
        url: z.string().url(),
        intent: z.string().optional(),
        fingerprint: fingerprint.optional(),
        session: z.string().optional(),
        confirmed: z.array(z.string()).optional().describe('Keys your user has just confirmed (e.g. form.submit), when knocking right before acting on them.'),
        have_map: z.string().optional().describe('The digest of the map the page publishes itself (data-usher-digest), if you are using it.'),
      },
    },
    (args) =>
      guarded(() =>
        client.knock({
          url: args.url,
          ...(args.intent && { intent: args.intent }),
          ...(args.fingerprint && { fingerprint: args.fingerprint as Fingerprint }),
          ...(args.session && { session: args.session }),
          ...(args.confirmed && { confirmed: args.confirmed }),
          ...(args.have_map && { have_map: args.have_map }),
        }),
      ),
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

  server.registerTool(
    'get_plan',
    {
      title: 'Get a plan',
      description:
        'Get the plan for a multi-step journey starting at this page: its steps (maps joined by where each step leads) and every input it will ask for by semantic key, with required, constraints and allowed options, so you can check your user\'s data before starting and ask for anything missing.',
      inputSchema: { url: z.string().url() },
    },
    (args) => guarded(() => client.getPlan(args.url)),
  );

  server.registerTool(
    'submit_map',
    {
      title: 'Submit a map',
      description: 'Submit a map built for a page that had none, so the next agent gets a fast path. Must validate against the Usher map schema; never include values.',
      inputSchema: { map: z.record(z.string(), z.unknown()) },
    },
    (args) => guarded(() => client.submitMap(args.map as unknown as UsherMap)),
  );

  server.registerTool(
    'report_run',
    {
      title: 'Report a run',
      description: 'Report how a run went (outcome, timings, token usage) to the session log. Structure only, never values.',
      inputSchema: { session: z.string(), url: z.string().url(), outcome: z.enum(['completed', 'stopped', 'failed']), summary: z.record(z.string(), z.unknown()).optional() },
    },
    (args) => guarded(() => client.reportRun({ session: args.session, url: args.url, outcome: args.outcome, ...(args.summary && { summary: args.summary }) })),
  );

  return server;
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
