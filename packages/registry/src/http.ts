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
      if (preflight) {
        res.writeHead(corsRoute ? 204 : 405, corsRoute ? { 'Access-Control-Max-Age': '600' } : {});
        return void res.end();
      }

      // Per client address, in memory only.
      const client = clientAddress(req, options.proxyHops);
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
      if (route === 'POST /maps/lookup') return send(res, await registry.lookupPage(await readJson(req)));
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
      if (options.demo && process.env.USHER_DEMO === '1' && isLoopback(req) && (url.pathname === '/demo' || url.pathname.startsWith('/demo/'))) return await options.demo(req, res, url);
      if (options.web && (await options.web.handle(req, res, url))) return;
      send(res, { status: 404, body: { error: 'not_found', message: `${route} is not a registry endpoint.` } });
    } catch (err) {
      const bad = err instanceof SyntaxError || (err as Error).message === 'too_large';
      if (!bad) console.error(err);
      if (!res.headersSent) send(res, { status: bad ? 400 : 500, body: { error: bad ? 'invalid_request' : 'internal_error', message: bad ? 'Expected a JSON body under 256 KB.' : 'Something went wrong.' } });
    }
  };
}

export interface StartOptions extends Omit<HttpOptions, 'web'> {
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
  port?: number;
  host?: string;
  /** Public URL (REGISTRY_PUBLIC_URL); without one, the address the server listens on. */
  url?: string;
  threshold?: number;
  /** Store and share maps agents submit (default true; production turns it off). */
  acceptMaps?: boolean;
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
    ...(options.signingKey && { signingKey: options.signingKey }),
    ...(options.retiredKeys && { retiredKeys: options.retiredKeys }),
    ...(options.directories && { directories: options.directories }),
    ...(options.claims && { claims: options.claims }),
    ...(options.acceptMaps !== undefined && { acceptMaps: options.acceptMaps }),
  });
  const web = options.web ? new Web(registry, { ...options.web, ...(options.proxyHops && { proxyHops: options.proxyHops }), ...(options.chat && options.model && { chat: options.chat, model: options.model }) }) : undefined;
  const server = createServer(
    registryHandler(registry, {
      ...(options.siteScript && { siteScript: options.siteScript }),
      ...(web && { web }),
      ...(options.proxyHops && { proxyHops: options.proxyHops }),
      ...(options.hsts && { hsts: true }),
      ...(options.limits && { limits: options.limits }),
      ...(options.hourly && { hourly: options.hourly }),
      ...(options.demo && { demo: options.demo }),
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
  server.on('close', () => {
    clearInterval(pruning);
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
      await options.storage.close?.();
    },
  };
}
