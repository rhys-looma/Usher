// Hosted Usher (the registry's /mcp): the same tools as @usher-run/mcp, over MCP's streamable HTTP
// transport, so an assistant can add a URL instead of installing anything. Each connection gets
// its own Ed25519 key, minted on first use and held in memory only; the registry knocks for it
// in-process and marks its sessions and tokens as hosted (identity "hosted", token claim
// act.sub = "hosted"), so sites can allow or block hosted agents as a class. It acts only on sites
// that have joined Usher (and the demo site); for anywhere else, the local server, with the
// user's own key. Nothing outlives a connection except the session log the site already gets.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Browser } from 'playwright';
import { publicHost } from '@usher/core/public-fetch';
import { generateAgentIdentity, signRequest, type AgentIdentity, type Fingerprint, type UsherMap, type UsherPlan } from '@usher/core';
import { RegistryError, knockRequest, notJoinedMessage, RateLimiter, type JoinedSite, type KnockInput, type KnockResponse, type Registry, type Reply, type RunReport } from '@usher/registry';
import { registerRegistryTools, type RegistryTools } from '../../registry/src/mcp.ts';
import type { FallbackModel, RegistryTransport } from '../../agent/src/index.ts';
import { CARD_META, registerCards } from './apps.ts';
import { registerFillTools } from './fill.ts';

export interface HostedLimits {
  /** New connections per client address an hour. */
  connectionsPerAddressHour: number;
  /** Requests per client address a minute, across its connections. */
  requestsPerAddressMinute: number;
  /** Requests per connection a minute. */
  requestsPerConnectionMinute: number;
  /** usher_fill calls per connection an hour. */
  fillsPerConnectionHour: number;
  /** usher_fill calls per client address an hour. */
  fillsPerAddressHour: number;
  /** Fills running at once, across every connection (each is a browser context). */
  concurrentFills: number;
  /** Connections open at once. */
  maxConnections: number;
  /** A connection with no request for this long is closed. */
  idleMinutes: number;
}

// Assistants such as claude.ai connect from their provider's addresses, so many users can share
// one address: the per-address limits are a ceiling, the per-connection ones the everyday limit.
export const HOSTED_LIMITS: HostedLimits = {
  connectionsPerAddressHour: 300,
  requestsPerAddressMinute: 1200,
  requestsPerConnectionMinute: 60,
  fillsPerConnectionHour: 10,
  fillsPerAddressHour: 120,
  concurrentFills: 3,
  maxConnections: 500,
  idleMinutes: 30,
};

export interface HostedOptions {
  registry: Registry;
  version: string;
  /** For pages with no map: the registry's model, within its daily spend cap. */
  fallback?: FallbackModel;
  /** One browser for every connection; each fill gets a fresh context. */
  browser: () => Promise<Browser>;
  limits?: Partial<HostedLimits>;
  /** Let fills reach private addresses (local development and tests only). */
  allowPrivate?: boolean;
  /** How long a fill may run to its next decision, and wait for an answer (tests shorten them). */
  timeouts?: { stepMs?: number; decisionMs?: number };
}

export interface HostedMcp {
  /** Handles a request to /mcp; `client` is the caller's address (for limits, never stored). */
  handle(req: IncomingMessage, res: ServerResponse, client: string, body: unknown): Promise<void>;
  readonly connections: number;
  close(): Promise<void>;
}

interface Connection {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  fill: { close: () => Promise<void> };
  seen: number;
}

function unwrap<T>(reply: Reply): T {
  if (reply.status >= 400) {
    const body = reply.body as { error?: string; message?: string };
    throw new RegistryError(reply.status, body.error ?? 'error', body.message ?? `Registry error ${reply.status}.`);
  }
  return reply.body as T;
}

/**
 * The registry, in-process, signing as one hosted connection, and only on sites that have joined.
 * No submit_map: a hosted connection's key lasts one connection, so it never shares maps.
 */
function inProcess(registry: Registry, identity: () => Promise<AgentIdentity>) {
  return {
    knock: async (input: KnockInput): Promise<KnockResponse> => {
      const origin = new URL(input.url).origin;
      if (!(await registry.joined(origin))) throw new Error(notJoinedMessage(origin));
      return unwrap(await registry.knock(await signRequest(knockRequest(input), await identity()), null, { hosted: true }));
    },
    lookup: async (origin: string, path: string, fingerprint: Fingerprint): Promise<{ match: KnockResponse['match']; map: UsherMap | null }> => unwrap(await registry.lookupPage({ origin, path, fingerprint })),
    getMap: async (origin: string, digest: string) => unwrap(await registry.getMap(origin, digest)),
    getPlan: async (url: string): Promise<UsherPlan> => unwrap(await registry.getPlan(url)),
    reportRun: async (report: RunReport): Promise<{ recorded: boolean }> => unwrap(await registry.reportRun(await signRequest(report, await identity()), null, { hosted: true })),
  } satisfies RegistryTools;
}

const jsonRpcError = (res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
};

/** One line per joined site: "- Brightwater (its host): health insurance quote, car insurance quote." */
export function siteList(joined: JoinedSite[]): string {
  return joined.map((j) => `- ${j.name} (${new URL(j.origin).host}): ${j.demo ? 'demo ' : ''}${[...new Set(j.journeys.map((x) => x.label))].join(', ')}.`).join('\n');
}

export function hostedInstructions(listed: string): string {
  return `Hosted Usher fills forms for the person on sites that have joined Usher:
${listed || '- (none yet)'}
When the person asks for something on one of these, call usher_fill with the site and the task as they said them and their details word for word. usher_fill pauses for the person at every consent and before anything is submitted, by default: the person never has to ask for that. Show them its decisions word for word, never answer for them, and pass their reply to usher_confirm. For sites not listed, the person can run Usher locally with their own key: npx -y @usher-run/mcp`;
}

export function hostedMcp(options: HostedOptions): HostedMcp {
  const limits = { ...HOSTED_LIMITS, ...options.limits };
  const { registry } = options;
  const connections = new Map<string, Connection>();
  const opened = new RateLimiter(limits.connectionsPerAddressHour, 3_600_000);
  const perAddress = new RateLimiter(limits.requestsPerAddressMinute, 60_000);
  const perConnection = new RateLimiter(limits.requestsPerConnectionMinute, 60_000);
  const fillsPerAddress = new RateLimiter(limits.fillsPerAddressHour, 3_600_000);
  let running = 0;

  const drop = async (id: string) => {
    const c = connections.get(id);
    if (!c) return;
    connections.delete(id);
    await c.fill.close();
    await c.transport.close().catch(() => undefined);
  };
  const sweep = setInterval(() => {
    const cutoff = Date.now() - limits.idleMinutes * 60_000;
    for (const [id, c] of connections) if (c.seen < cutoff) void drop(id);
  }, 60_000);
  sweep.unref();

  // The sites a connection is told about, from the registry, refreshed every minute as sites join.
  let directory: { at: number; text: Promise<string> } | undefined;
  const sites = () => {
    if (!directory || Date.now() - directory.at > 60_000) directory = { at: Date.now(), text: registry.joinedSites().then(siteList, () => '') };
    return directory.text;
  };

  async function connect(client: string): Promise<StreamableHTTPServerTransport> {
    const listed = await sites();
    // The connection's key: minted when a tool first needs it, never written anywhere.
    let identity: Promise<AgentIdentity> | undefined;
    const mint = () => (identity ??= generateAgentIdentity().then((g) => g.identity));
    const tools = inProcess(registry, mint);
    const server = new McpServer(
      { name: 'usher', version: options.version },
      {
        instructions: hostedInstructions(listed),
      },
    );
    registerRegistryTools(server, tools, { knockMeta: CARD_META });
    // Results as cards in clients with MCP Apps; Claude gets this server's dedicated origin.
    registerCards(server, { serverUrl: `${registry.url}/mcp` });
    const transport = async (): Promise<RegistryTransport> => ({
      kind: 'hosted',
      identity: await mint(),
      knock: tools.knock,
      lookup: (url, fingerprint) => tools.lookup(new URL(url).origin, new URL(url).pathname, fingerprint),
      getPlan: (url) => tools.getPlan(url).catch(() => null),
      resolve: (site, task) => registry.resolveTask(site, task),
      submitMap: async () => ({ digest: '', stored: false }),
      reportRun: tools.reportRun,
      logEvents: async (eventsUrl, token, events) => {
        const sid = /\/sessions\/(s_[A-Za-z0-9_-]+)\/events$/.exec(new URL(eventsUrl).pathname)?.[1];
        if (sid) await registry.appendEvents(sid, `Usher ${token}`, { events });
      },
      close: async () => undefined,
    });
    const fill = registerFillTools(server, {
      transport,
      browser: options.browser,
      perHour: limits.fillsPerConnectionHour,
      toolMeta: CARD_META,
      ...(options.timeouts?.stepMs && { stepTimeoutMs: options.timeouts.stepMs }),
      ...(options.timeouts?.decisionMs && { decisionTimeoutMs: options.timeouts.decisionMs }),
      // A joined site is still a page from the internet: its redirects and requests stay public.
      ...(!options.allowPrivate && { allowHost: publicHost }),
      ...(options.fallback && { fallback: options.fallback }),
      admit: async (url) => {
        let origin: string;
        try {
          origin = new URL(url).origin;
        } catch {
          return { refused: 'That is not a URL.' };
        }
        if (!(await registry.joined(origin))) return { refused: notJoinedMessage(origin) };
        if (!fillsPerAddress.allow(client)) return { refused: 'Too many fills from this address this hour; try again later, or run Usher locally: npx -y @usher-run/mcp' };
        if (running >= limits.concurrentFills) return { refused: 'Hosted Usher is busy with other fills; try again in a minute, or run Usher locally: npx -y @usher-run/mcp' };
        running++;
        let released = false;
        return { release: () => void (released || ((released = true), running--)) };
      },
    });
    let transportRef!: StreamableHTTPServerTransport;
    transportRef = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Plain JSON replies: nothing here streams, and every proxy on the way handles JSON.
      enableJsonResponse: true,
      onsessioninitialized: (id) => void connections.set(id, { transport: transportRef, server, fill, seen: Date.now() }),
    });
    transportRef.onclose = () => {
      if (transportRef.sessionId) void drop(transportRef.sessionId);
    };
    return server.connect(transportRef).then(() => transportRef);
  }

  return {
    get connections() {
      return connections.size;
    },
    async handle(req, res, client, body) {
      if (!perAddress.allow(client)) return jsonRpcError(res, 429, 'Too many requests from this address; slow down.', { 'Retry-After': '60' });
      const id = req.headers['mcp-session-id'];
      const sid = Array.isArray(id) ? id[0] : id;
      if (sid) {
        const c = connections.get(sid);
        if (!c) return jsonRpcError(res, 404, 'No such connection: it closed or expired. Reconnect to start a new one.');
        if (!perConnection.allow(sid)) return jsonRpcError(res, 429, 'Too many requests on this connection; slow down.', { 'Retry-After': '60' });
        c.seen = Date.now();
        return c.transport.handleRequest(req, res, body);
      }
      if (req.method !== 'POST' || !isInitializeRequest(body)) return jsonRpcError(res, 400, 'Start a connection with an initialize request.');
      if (connections.size >= limits.maxConnections) return jsonRpcError(res, 503, 'Hosted Usher has too many connections open; try again shortly, or run it locally: npx -y @usher-run/mcp', { 'Retry-After': '60' });
      if (!opened.allow(client)) return jsonRpcError(res, 429, 'Too many new connections from this address; try again later.', { 'Retry-After': '600' });
      const transport = await connect(client);
      await transport.handleRequest(req, res, body);
    },
    async close() {
      clearInterval(sweep);
      for (const id of [...connections.keys()]) await drop(id);
    },
  };
}
