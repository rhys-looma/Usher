// HTTP API for the registry. Plain node:http. CORS is open only on the endpoints the site script
// calls from a site's own origin; everything else is same-origin or server-to-server.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { clientAddress, requestScheme, requestUrl } from './forwarded.ts';
import { RateLimiter } from './rate-limit.ts';
import type { AddressInfo } from 'node:net';
import type { ChatFn, PrivateJwk, PublicJwk } from '@usher/core';
import { Registry, type Reply } from './registry.ts';
import { Web, type WebOptions } from './web/routes.ts';
import { Keeper, type KeeperOptions } from './keeper.ts';
import type { Walkthroughs } from './walkthrough.ts';
import type { ThemeDeriver } from './theme-derive.ts';
import type { Storage } from './storage.ts';

const MAX_BODY = 256_000;

export interface HttpOptions {
  /** Path of the built site script, served at /usher.js and /usher/<version>.js. */
  siteScript?: string;
  /** The map viewer and dashboard pages. */
  web?: Web;
  /**
   * Trusted proxies in front (TRUSTED_PROXY_HOPS; CloudFront then the ALB is 2): the client is the
   * X-Forwarded-For entry that many from the right, and the scheme is CloudFront-Forwarded-Proto,
   * else X-Forwarded-Proto. 0 trusts no forwarded header.
   */
  proxyHops?: number;
  /** Send Strict-Transport-Security (when served over HTTPS). */
  hsts?: boolean;
  /** Per-client-address limits per minute, by route group. */
  limits?: Partial<Record<'knock' | 'drift' | 'events' | 'read' | 'write', number>>;
  /**
   * Per-client-address limits per hour on what a person does a few times at most: registering a
   * site and checking its claim (each check fetches from the internet), the interest form, and
   * signing in.
   */
  hourly?: Partial<Record<'signup' | 'interest' | 'login', number>>;
  /** The demo stage at /demo: served only when USHER_DEMO=1, and only to this machine. */
  demo?: DemoHandler;
  /** Hosted MCP at /mcp (MCP's streamable HTTP transport). */
  mcp?: McpEndpoint;
}

/** The origin a site app's path names: https, except a local development host (the mock site in tests). */
export function siteOrigin(host: string): string {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  return `${local ? 'http' : 'https'}://${host.toLowerCase()}`;
}

/** Hosted MCP (packages/mcp/src/hosted.ts), mounted at /mcp, and at /mcp/<host> for each site's app. It keeps its own limits. */
export interface McpEndpoint {
  handle(req: IncomingMessage, res: ServerResponse, client: string, body: unknown, site?: string): Promise<void>;
  close(): Promise<void>;
}

export { clientAddress, requestScheme, requestUrl };

export type DemoHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

/** Whether a request comes from this machine (the demo is never served to anyone else). */
export function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? '';
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

// Endpoints the site script calls from a site's pages.
const CORS_ROUTES = [/^GET \/maps\/current$/, /^POST \/maps\/lookup$/, /^POST \/drift$/, /^POST \/sessions\/s_[A-Za-z0-9_-]+\/events$/, /^GET \/\.well-known\/usher-keys\.json$/, /^POST \/sites\/[^/]+\/blocked$/];

interface SiteScript {
  version: string;
  body: Buffer;
}

async function loadScript(path: string | undefined): Promise<SiteScript | null> {
  if (!path) return null;
  const body = await readFile(path).catch(() => null);
  return body && { version: createHash('sha256').update(body).digest('hex').slice(0, 12), body };
}

async function readRaw(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('too_large');
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return JSON.parse(Buffer.from(await readRaw(req)).toString('utf8') || 'null');
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function send(res: ServerResponse, reply: Reply, headers: Record<string, string> = {}): void {
  res.writeHead(reply.status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(reply.body));
}

export function registryHandler(registry: Registry, options: HttpOptions = {}) {
  // Site script events come in bursts while an agent fills a form, so they have their own allowance.
  const limits = { knock: 120, drift: 60, events: 1200, read: 600, write: 300, ...options.limits };
  const limiters = Object.fromEntries(Object.entries(limits).map(([k, max]) => [k, new RateLimiter(max, 60_000)])) as Record<keyof typeof limits, RateLimiter>;
  const hourly = { signup: 20, interest: 5, login: 30, ...options.hourly };
  const hourlyLimiters = Object.fromEntries(Object.entries(hourly).map(([k, max]) => [k, new RateLimiter(max, 3_600_000)])) as Record<keyof typeof hourly, RateLimiter>;
  const hourlyGroup = (route: string): keyof typeof hourly | null =>
    /^POST \/(sites|sites\/new|sites\/new\/claim|sites\/lost|sites\/[^/]+\/verify|dashboard\/verify)$/.test(route) ? 'signup' : route === 'POST /interest' ? 'interest' : /^POST \/(dashboard|admin)\/login$/.test(route) ? 'login' : null;
  const started = Date.now();
  let script: Promise<SiteScript | null> | undefined;
  // Reloaded when the build changes (a deploy), so the versioned path always matches the file.
  const siteScript = async () => {
    const current = await (script ??= loadScript(options.siteScript));
    setTimeout(() => (script = undefined), 60_000).unref();
    return current;
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // HEAD is GET without a body: Node already leaves the body out of a HEAD response, so every
    // route answers it (uptime checks and curl -I use it).
    if (req.method === 'HEAD') req.method = 'GET';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Nothing is cached unless its route says so (the site script, keys, specifications, images):
    // CloudFront and browsers follow these headers.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (options.hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    try {
      const url = new URL(req.url ?? '/', 'http://registry');
      const route = `${req.method} ${url.pathname}`;
      const preflight = req.method === 'OPTIONS';
      const corsRoute = CORS_ROUTES.some((r) => r.test(preflight ? route.replace(/^OPTIONS/, String(req.headers['access-control-request-method'] ?? 'GET')) : route));
      if (corsRoute) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Usher-Site-Key, Content-Digest, Signature, Signature-Input, Signature-Agent');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      }
      // /mcp/<host>: one site's assistant app (https only, as every joined site is).
      const siteApp = /^\/mcp\/([a-z0-9.-]+(?::\d+)?)\/?$/i.exec(url.pathname)?.[1];
      const isMcp = (url.pathname === '/mcp' || Boolean(siteApp)) && Boolean(options.mcp);
      // Browser-based MCP clients connect from their own origin; there are no cookies here.
      if (isMcp) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
        if (preflight) {
          res.writeHead(204, { 'Access-Control-Max-Age': '600' });
          return void res.end();
        }
      }
      if (preflight) {
        res.writeHead(corsRoute ? 204 : 405, corsRoute ? { 'Access-Control-Max-Age': '600' } : {});
        return void res.end();
      }

      // Per client address, in memory only.
      const client = clientAddress(req, options.proxyHops);
      if (isMcp && options.mcp) {
        const site = siteApp ? siteOrigin(siteApp) : undefined;
        // Someone opening the address in a browser gets a pointer, not a protocol error.
        if (req.method === 'GET' && !req.headers['mcp-session-id'] && !String(req.headers.accept ?? '').includes('text/event-stream')) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          if (site) return void res.end(`${await registry.siteName(site)}'s assistant app, run by Usher. Add ${registry.url}${url.pathname} to your assistant as a remote MCP server (connector); there is nothing to install.\n`);
          return void res.end(`Usher's hosted MCP server. Add ${registry.url}/mcp to your assistant as a remote MCP server (connector); there is nothing to install.\nIt acts on sites that have joined Usher. For any other site, run it locally with your own key: npx -y @usher-run/mcp\n`);
        }
        const body = req.method === 'POST' ? await readJson(req).catch(() => undefined) : undefined;
        return await options.mcp.handle(req, res, client, body, site);
      }
      const group = route === 'POST /knock' ? 'knock' : route === 'POST /drift' ? 'drift' : /^POST \/sessions\/[^/]+\/events$/.test(route) ? 'events' : req.method === 'GET' ? 'read' : 'write';
      if (!limiters[group].allow(`${group}|${client}`)) return send(res, { status: 429, body: { error: 'rate_limited', message: 'Too many requests from this address; slow down.' } }, { 'Retry-After': '60' });
      const slow = hourlyGroup(route);
      if (slow && !hourlyLimiters[slow].allow(`${slow}|${client}`)) return send(res, { status: 429, body: { error: 'rate_limited', message: 'Too many tries from this address. Try again in an hour.' } }, { 'Retry-After': '3600' });

      if (route === 'GET /healthz') {
        const health = await registry.health();
        return send(res, { status: health.ok ? 200 : 503, body: { ...health, uptime_s: Math.round((Date.now() - started) / 1000), site_script: (await siteScript())?.version ?? null } }, { 'Cache-Control': 'no-store' });
      }
      if (route === 'GET /.well-known/usher-keys.json') return send(res, { status: 200, body: await registry.keySet() }, { 'Cache-Control': 'public, max-age=300' });
      const versioned = /^\/usher\/([0-9a-f]{12})\.js$/.exec(url.pathname);
      if (route === 'GET /usher.js' || (versioned && req.method === 'GET')) {
        const current = await siteScript();
        if (!current) return send(res, { status: 404, body: { error: 'not_found', message: 'Site script not configured.' } });
        if (versioned && versioned[1] !== current.version) return send(res, { status: 404, body: { error: 'not_found', message: `No site script version ${versioned[1]}; the current one is /usher/${current.version}.js.` } });
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          // A versioned path never changes; the plain one is short-lived so updates reach sites.
          'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
          ETag: `"${current.version}"`,
          'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        return void res.end(current.body);
      }
      if (route === 'GET /usher/version.json') {
        const current = await siteScript();
        return send(res, { status: current ? 200 : 404, body: current ? { version: current.version, path: `/usher/${current.version}.js` } : { error: 'not_found' } }, { 'Cache-Control': 'public, max-age=300' });
      }
      // Agent writes: the body, and the Web Bot Auth signature over it if the agent sent one.
      const signed = async () => {
        const raw = await readRaw(req);
        const via = await registry.verifyHttpAgent({ method: req.method ?? 'POST', url: requestUrl(req, options.proxyHops), headers: req.headers }, raw);
        return { body: JSON.parse(Buffer.from(raw).toString('utf8') || 'null') as unknown, via };
      };
      if (route === 'POST /knock') {
        const { body, via } = await signed();
        return send(res, await registry.knock(body, via));
      }
      if (route === 'GET /plans') return send(res, await registry.getPlan(url.searchParams.get('url')));
      // A site and a task in a person's words, to a journey on a joined site.
      if (route === 'GET /resolve') {
        const site = url.searchParams.get('site');
        if (!site) return send(res, { status: 400, body: { error: 'invalid_request', message: 'Expected ?site= (and ?task=).' } });
        return send(res, { status: 200, body: await registry.resolveTask(site.slice(0, 300), url.searchParams.get('task')?.slice(0, 300) ?? undefined) });
      }
      if (route === 'POST /maps/lookup') return send(res, await registry.lookupPage(await readJson(req), req.headers.authorization));
      if (route === 'POST /maps') {
        const { body, via } = await signed();
        return send(res, await registry.submitMap(body, via));
      }
      if (route === 'POST /runs') {
        const { body, via } = await signed();
        return send(res, await registry.reportRun(body, via));
      }
      if (route === 'POST /drift') return send(res, await registry.drift(await readJson(req), header(req, 'usher-site-key')));
      if (route === 'POST /sites') return send(res, await registry.registerSite(await readJson(req)));
      const verify = /^\/sites\/([^/]+)\/verify$/.exec(url.pathname);
      if (verify && req.method === 'POST') return send(res, await registry.verifySite(decodeURIComponent(verify[1]!), req.headers.authorization));
      if (route === 'GET /maps/current') {
        return send(res, await registry.currentMap(url.searchParams.get('origin'), url.searchParams.get('path')), { 'Cache-Control': 'public, max-age=3600' });
      }
      const blocked = /^\/sites\/([^/]+)\/blocked$/.exec(url.pathname);
      if (blocked && req.method === 'POST') return send(res, await registry.reportBlocked(decodeURIComponent(blocked[1]!), header(req, 'usher-site-key'), await readJson(req)));
      const rules = /^\/sites\/([^/]+)\/rules(?:\/(r_[A-Za-z0-9_-]+)\/confirm)?$/.exec(url.pathname);
      if (rules) {
        const origin = decodeURIComponent(rules[1]!);
        if (req.method === 'GET' && !rules[2]) return send(res, await registry.getRules(origin, req.headers.authorization));
        if (req.method === 'POST' && !rules[2]) return send(res, await registry.proposeRules(origin, req.headers.authorization, await readJson(req)));
        if (req.method === 'POST' && rules[2]) return send(res, await registry.confirmRules(origin, rules[2], req.headers.authorization));
      }
      const map = /^\/maps\/(sha256:[0-9a-f]{64})$/.exec(url.pathname);
      if (map && req.method === 'GET') {
        const origin = url.searchParams.get('origin');
        if (!origin) return send(res, { status: 400, body: { error: 'invalid_request', message: 'Maps belong to an origin: add ?origin=.' } });
        return send(res, await registry.getMap(origin, map[1]!));
      }
      const session = /^\/sessions\/(s_[A-Za-z0-9_-]+)(\/events)?$/.exec(url.pathname);
      if (session && req.method === 'GET' && !session[2]) return send(res, await registry.getSession(session[1]!, req.headers.authorization));
      if (session && req.method === 'POST' && session[2]) return send(res, await registry.appendEvents(session[1]!, req.headers.authorization, await readJson(req)));
      if (options.demo && process.env.USHER_DEMO === '1' && isLoopback(req) && (url.pathname === '/demo' || url.pathname.startsWith('/demo/')) && !url.pathname.startsWith('/demo/dashboard')) return await options.demo(req, res, url);
      if (options.web && (await options.web.handle(req, res, url))) return;
      send(res, { status: 404, body: { error: 'not_found', message: `${route} is not a registry endpoint.` } });
    } catch (err) {
      const bad = err instanceof SyntaxError || (err as Error).message === 'too_large';
      if (!bad) console.error(err);
      if (!res.headersSent) send(res, { status: bad ? 400 : 500, body: { error: bad ? 'invalid_request' : 'internal_error', message: bad ? 'Expected a JSON body under 256 KB.' : 'Something went wrong.' } });
    }
  };
}

export interface StartOptions extends Omit<HttpOptions, 'web' | 'mcp'> {
  /** The keeper: scheduled checks and drift rebuilds. */
  keeper?: KeeperOptions;
  signingKey?: PrivateJwk;
  retiredKeys?: PublicJwk[];
  storage: Storage;
  /** Serve the map viewer and dashboard. */
  web?: Omit<WebOptions, 'chat' | 'model'>;
  chat?: ChatFn;
  model?: string;
  explainer?: { chat: ChatFn; model: string };
  /** The registry's clock (tests). */
  now?: () => Date;
  /** Hosted MCP at /mcp, made once the registry exists. */
  mcp?: (registry: Registry) => McpEndpoint;
  /** The walkthrough mapper, made once the registry exists. */
  walkthroughs?: (registry: Registry) => Walkthroughs;
  /** Reads a site's look for its assistant app's theme, on join and on the owner's refresh. */
  themes?: (registry: Registry) => ThemeDeriver;
  port?: number;
  host?: string;
  /** Public URL (REGISTRY_PUBLIC_URL); without one, the address the server listens on. */
  url?: string;
  threshold?: number;
  /** Store maps agents submit, private to each agent until verified (default true). */
  acceptMaps?: boolean;
  /** Maps one agent may submit per hour (default 20). */
  submitLimit?: number;
  /** The demo site whose dashboard anyone can read at /demo/dashboard. */
  publicDemo?: { origin: string; keepAgents?: string[] };
  /** Fetching agents' key directories: allow http:// and private hosts (local development). */
  directories?: { allowHttp?: boolean; fetch?: typeof fetch };
  /** Checking domain claims: allow private origins (local development), and test doubles. */
  claims?: { allowPrivate?: boolean; fetch?: typeof fetch; resolveTxt?: (name: string) => Promise<string[][]> };
}

export interface RunningRegistry {
  url: string;
  registry: Registry;
  keeper?: Keeper;
  server: Server;
  close(): Promise<void>;
}

/** The address a server listens on, as a URL: for local use, when no public URL is configured. */
export function listeningUrl(server: Server): string {
  const a = server.address() as AddressInfo;
  const host = a.address === '0.0.0.0' || a.address === '::' ? hostname() : a.family === 'IPv6' ? `[${a.address}]` : a.address;
  return `http://${host}:${a.port}`;
}

export async function startRegistry(options: StartOptions): Promise<RunningRegistry> {
  let url = options.url ?? '';
  const registry = new Registry({
    storage: options.storage,
    url: () => url,
    ...(options.threshold !== undefined && { threshold: options.threshold }),
    ...(options.chat && options.model && { chat: options.chat, model: options.model }),
    ...(options.explainer && { explainer: options.explainer }),
    ...(options.now && { now: options.now }),
    ...(options.signingKey && { signingKey: options.signingKey }),
    ...(options.retiredKeys && { retiredKeys: options.retiredKeys }),
    ...(options.directories && { directories: options.directories }),
    ...(options.claims && { claims: options.claims }),
    ...(options.acceptMaps !== undefined && { acceptMaps: options.acceptMaps }),
    ...(options.submitLimit !== undefined && { submitLimit: options.submitLimit }),
    ...(options.publicDemo && { publicDemo: options.publicDemo }),
  });
  const mcp = options.mcp?.(registry);
  const walkthroughs = options.web && options.walkthroughs?.(registry);
  const themes = options.themes?.(registry);
  if (themes) {
    // A site that joins gets a proposed theme from its own pages, unless it has one already.
    registry.onJoined = (origin) => void (async () => {
      const record = await registry.siteTheme(origin);
      if (!record.approved && !record.proposed) await themes.derive(origin);
    })().catch(() => undefined);
  }
  const web = options.web ? new Web(registry, { ...options.web, ...(mcp && { hostedMcp: true }), ...(walkthroughs && { walkthroughs }), ...(themes && { themes }), ...(options.proxyHops && { proxyHops: options.proxyHops }), ...(options.chat && options.model && { chat: options.chat, model: options.model }) }) : undefined;
  const server = createServer(
    registryHandler(registry, {
      ...(options.siteScript && { siteScript: options.siteScript }),
      ...(web && { web }),
      ...(options.proxyHops && { proxyHops: options.proxyHops }),
      ...(options.hsts && { hsts: true }),
      ...(options.limits && { limits: options.limits }),
      ...(options.hourly && { hourly: options.hourly }),
      ...(options.demo && { demo: options.demo }),
      ...(mcp && { mcp }),
    }),
  );
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve));
  url ||= listeningUrl(server);
  await registry.signingKey();
  // The keeper's runs also refresh the map viewer's picker; the first refresh warms its cache.
  const refreshPicker = web ? () => web.viewer.refreshPicker() : undefined;
  const keeper = options.keeper ? new Keeper(registry, { ...options.keeper, ...(refreshPicker && { afterRun: refreshPicker }) }) : undefined;
  if (refreshPicker && options.keeper) setTimeout(() => void refreshPicker().catch(() => undefined), 20_000).unref();
  if (keeper) {
    // A drift report from a site script triggers a check of that form, in the background.
    registry.onDrift = (origin, path) => void keeper.check(origin, path).catch(() => undefined);
    // A new agent map on a site the keeper visits: rebuilt and compared, in the background.
    registry.onUnverifiedMap = (record) => void keeper.verifyAgentMap(record).catch(() => undefined);
    // Where the keeper visits, it alone verifies agents' maps; only where it can rebuild them.
    registry.keeperVisits = (origin) => keeper.visits(origin) && Boolean(options.keeper?.compiler);
    keeper.start();
  }
  // Keep each site's sessions only as long as its policy says, and re-check domain claims daily.
  const prune = async () => {
    for (const site of await options.storage.listSites()) await registry.pruneSessions(site.origin).catch(() => undefined);
    await registry.pruneUnregisteredSessions().catch(() => undefined);
    await registry.recheckClaims().catch(() => undefined);
  };
  void prune();
  const pruning = setInterval(prune, 3_600_000);
  pruning.unref();
  // The public demo explains itself: recent sessions every ten minutes (cached while nothing changes,
  // within the daily model budget).
  const demo = options.publicDemo;
  const explaining = demo ? setInterval(() => void registry.explainOrigin(demo.origin).catch(() => undefined), 600_000) : undefined;
  explaining?.unref();
  server.on('close', () => {
    clearInterval(pruning);
    clearInterval(explaining);
    void web?.viewer.close();
  });
  return {
    url,
    registry,
    ...(keeper && { keeper }),
    server,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await keeper?.close();
      await mcp?.close();
      await options.storage.close?.();
    },
  };
}
