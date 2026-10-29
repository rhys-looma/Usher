// How the agent talks to the registry: HTTP directly, or through the Usher MCP server, which
// signs with the same key file. Both give the agent the same three calls.

import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AgentIdentity, Fingerprint, ResultView, UsherMap, UsherPlan } from '@usher/core';
import { RegistryClient, loadOrCreateIdentity, type KnockInput, type KnockResponse, type Resolved, type RunReport } from '@usher/registry';

export interface RegistryTransport {
  /** hosted: the registry in-process, for a hosted MCP connection. */
  readonly kind: 'http' | 'mcp' | 'hosted';
  /** The agent's key, for signing its browser's requests to sites (Web Bot Auth). */
  readonly identity?: AgentIdentity;
  knock(input: KnockInput): Promise<KnockResponse>;
  /** The map for a page by its fingerprint, for sites without a knock lane. */
  lookup(url: string, fingerprint: Fingerprint): Promise<{ match: KnockResponse['match']; map: UsherMap | null }>;
  /** A site and a task in a person's words, to a journey on a joined site. */
  resolve?(site: string, task?: string): Promise<Resolved>;
  /** The plan for a journey from this page, or null if the registry has none. */
  getPlan(url: string): Promise<UsherPlan | null>;
  submitMap(map: UsherMap): Promise<{ digest: string; stored: boolean }>;
  reportRun(report: RunReport): Promise<{ recorded: boolean }>;
  /** The published result view for a page (spec/view.md), or null; registries without views leave it out. */
  resultView?(url: string): Promise<ResultView | null>;
  /** Adds events to a session's log with its token (what the agent put to its user). */
  logEvents?(eventsUrl: string, token: string, events: unknown[]): Promise<void>;
  close(): Promise<void>;
}

export async function httpTransport(registryUrl: string, keyFile?: string): Promise<RegistryTransport> {
  const identity = await loadOrCreateIdentity(keyFile);
  const client = new RegistryClient(registryUrl, identity);
  return {
    kind: 'http',
    identity,
    knock: (input) => client.knock(input),
    getPlan: (url) => client.getPlan(url).catch(() => null),
    resolve: (site, task) => client.resolve(site, task),
    lookup: (url, fingerprint) => {
      const u = new URL(url);
      return client.lookup(u.origin, u.pathname, fingerprint);
    },
    submitMap: (map) => client.submitMap(map),
    reportRun: (report) => client.reportRun(report),
    logEvents: async (eventsUrl, token, events) => {
      await fetch(eventsUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Usher ${token}` }, body: JSON.stringify({ events }) });
    },
    close: async () => undefined,
  };
}

const MCP_SERVER = fileURLToPath(new URL('../../registry/src/mcp.ts', import.meta.url));

/** Starts the Usher MCP server as a child process and calls its tools. */
export async function mcpTransport(registryUrl: string, keyFile?: string): Promise<RegistryTransport> {
  // The same key file the MCP server signs with (created here if new, so both use one key).
  const identity = await loadOrCreateIdentity(keyFile);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', '--import', 'tsx', MCP_SERVER],
    env: { ...(process.env as Record<string, string>), USHER_REGISTRY_URL: registryUrl, ...(keyFile && { USHER_AGENT_KEY_FILE: keyFile }) },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'usher-agent', version: '0.1.0' });
  await client.connect(transport);
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name}: ${(result.content as { text?: string }[])[0]?.text ?? 'failed'}`);
    return result.structuredContent as T;
  };
  return {
    kind: 'mcp',
    identity,
    knock: (input) => call('knock', { ...input }),
    getPlan: (url) => call<UsherPlan>('get_plan', { url }).catch(() => null),
    lookup: (url, fingerprint) => call('get_map', { url, fingerprint }),
    submitMap: (map) => call('submit_map', { map }),
    reportRun: (report) => call('report_run', { ...report }),
    close: () => client.close(),
  };
}
