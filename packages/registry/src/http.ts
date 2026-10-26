// HTTP API for the registry. Plain node:http; CORS is open because the site script calls the
// registry from the site's own origin.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { ChatFn } from '@usher/core';
import { Registry, type Reply } from './registry.ts';
import { Web, type WebOptions } from './web/routes.ts';
import type { Storage } from './storage.ts';

const MAX_BODY = 1_000_000;

export interface HttpOptions {
  /** Path of the built site script, served at /usher.js. */
  siteScript?: string;
  /** The map viewer and dashboard pages. */
  web?: Web;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('too_large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
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
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Usher-Site-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    try {
      const url = new URL(req.url ?? '/', 'http://registry');
      const route = `${req.method} ${url.pathname}`;
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Max-Age': '600' });
        return void res.end();
      }
      if (route === 'GET /.well-known/usher-keys.json') return send(res, { status: 200, body: await registry.keySet() }, { 'Cache-Control': 'public, max-age=300' });
      if (route === 'GET /usher.js') {
        if (!options.siteScript) return send(res, { status: 404, body: { error: 'not_found', message: 'Site script not configured.' } });
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
        return void res.end(await readFile(options.siteScript));
      }
      if (route === 'POST /knock') return send(res, await registry.knock(await readJson(req)));
      if (route === 'POST /maps/lookup') return send(res, await registry.lookupPage(await readJson(req)));
      if (route === 'POST /maps') return send(res, await registry.submitMap(await readJson(req)));
      if (route === 'POST /runs') return send(res, await registry.reportRun(await readJson(req)));
      if (route === 'POST /drift') return send(res, await registry.drift(await readJson(req), header(req, 'usher-site-key')));
      if (route === 'POST /sites') return send(res, await registry.registerSite(await readJson(req)));
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
      if (options.web && (await options.web.handle(req, res, url))) return;
      send(res, { status: 404, body: { error: 'not_found', message: `${route} is not a registry endpoint.` } });
    } catch (err) {
      const bad = err instanceof SyntaxError || (err as Error).message === 'too_large';
      if (!bad) console.error(err);
      if (!res.headersSent) send(res, { status: bad ? 400 : 500, body: { error: bad ? 'invalid_request' : 'internal_error', message: bad ? 'Expected a JSON body under 1 MB.' : 'Something went wrong.' } });
    }
  };
}

export interface StartOptions extends Omit<HttpOptions, 'web'> {
  storage: Storage;
  /** Serve the map viewer and dashboard. */
  web?: Omit<WebOptions, 'chat' | 'model'>;
  chat?: ChatFn;
  model?: string;
  explainer?: { chat: ChatFn; model: string };
  port?: number;
  host?: string;
  /** Public URL; defaults to http://localhost:<port>. */
  url?: string;
  threshold?: number;
}

export interface RunningRegistry {
  url: string;
  registry: Registry;
  server: Server;
  close(): Promise<void>;
}

export async function startRegistry(options: StartOptions): Promise<RunningRegistry> {
  let url = options.url ?? '';
  const registry = new Registry({
    storage: options.storage,
    url: () => url,
    ...(options.threshold !== undefined && { threshold: options.threshold }),
    ...(options.chat && options.model && { chat: options.chat, model: options.model }),
    ...(options.explainer && { explainer: options.explainer }),
  });
  const web = options.web ? new Web(registry, { ...options.web, ...(options.chat && options.model && { chat: options.chat, model: options.model }) }) : undefined;
  const server = createServer(registryHandler(registry, { ...(options.siteScript && { siteScript: options.siteScript }), ...(web && { web }) }));
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve));
  url ||= `http://localhost:${(server.address() as AddressInfo).port}`;
  await registry.signingKey();
  // Keep each site's sessions only as long as its policy says.
  const prune = async () => {
    for (const site of await options.storage.listSites()) await registry.pruneSessions(site.origin).catch(() => undefined);
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
    server,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
