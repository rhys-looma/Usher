// The registry's web pages: home, map viewer, map pages and the site dashboard.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Registry } from '../registry.ts';
import { Dashboard, type DashboardHooks } from './dashboard.ts';
import { html, page } from './html.ts';
import { Viewer, mapPage, viewerPage, type ViewerOptions } from './viewer.ts';

export interface WebOptions extends Omit<ViewerOptions, 'storage'> {
  hooks?: DashboardHooks;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20_000) throw new Error('too_large');
  }
  return new URLSearchParams(body);
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location });
  res.end();
}

function homePage(): string {
  return page(
    'Usher registry',
    html`<h1>Usher</h1>
<p class="lede">An open protocol and script tag that lets websites control AI agents on their forms, and gives agents a fast, trusted way in. Three things: a <b>map</b> of each form, a <b>knock</b> before an agent fills it, and a <b>log</b> of what it did, by meaning, never values.</p>
<div class="grid">
  <a class="card" href="/viewer"><b>Map viewer</b><br><span class="muted">Paste a page with a form and see the map Usher builds for it.</span></a>
  <a class="card" href="/dashboard"><b>Site dashboard</b><br><span class="muted">For site owners: agents on your forms, your rules, drift.</span></a>
</div>`,
  );
}

export class Web {
  readonly viewer: Viewer;
  private dashboard?: Dashboard;

  constructor(
    private readonly registry: Registry,
    private readonly options: WebOptions,
  ) {
    this.viewer = new Viewer({ ...options, storage: registry.storage });
  }

  /** Explanations come from the registry unless the caller supplies its own. */
  private get hooks(): DashboardHooks {
    return this.options.hooks ?? { explanations: (o: string) => this.registry.explanations(o), explain: (o: string) => this.registry.explainOrigin(o) };
  }

  private async board(): Promise<Dashboard> {
    this.dashboard ??= new Dashboard(this.registry, await this.registry.derivedSecret('dashboard'), this.hooks);
    return this.dashboard;
  }

  /** Handles a page request; false if the path is not a page. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /') return sendHtml(res, 200, homePage()), true;
    if (route === 'GET /viewer') return sendHtml(res, 200, viewerPage()), true;
    if (route === 'POST /viewer') {
      const target = (await readForm(req)).get('url') ?? '';
      // The client address limits how often one visitor can compile; it is never stored.
      const result = await this.viewer.compile(target, req.socket.remoteAddress ?? 'unknown');
      if (!result.ok) return sendHtml(res, result.reason === 'rate_limited' ? 429 : 422, viewerPage({ url: target, error: result })), true;
      const source = `${result.cached ? 'from cache' : `compiled by ${result.model}`} in ${(result.ms / 1000).toFixed(1)}s${result.cost_usd ? `, $${result.cost_usd.toFixed(4)}` : ''}`;
      return sendHtml(res, 200, mapPage(result.map, { source })), true;
    }
    if (route === 'GET /maps/view') {
      const origin = url.searchParams.get('origin') ?? '';
      const digest = url.searchParams.get('digest') ?? '';
      const record = await this.registry.storage.getMap(origin, digest);
      if (!record) return sendHtml(res, 404, page('Not found', html`<h1>No such map</h1>`)), true;
      return sendHtml(res, 200, mapPage(record.map, { source: `held by this registry since ${record.added_at.slice(0, 10)}`, record })), true;
    }

    if (!url.pathname.startsWith('/dashboard')) return false;
    const board = await this.board();
    if (route === 'POST /dashboard/login') {
      const origin = await board.login(res, await readForm(req));
      return origin ? redirect(res, '/dashboard') : sendHtml(res, 401, board.loginPage('That origin and secret key do not match a registered site.')), true;
    }
    if (route === 'POST /dashboard/logout') return board.logout(res), redirect(res, '/dashboard'), true;

    const origin = board.originOf(req);
    if (!origin) return sendHtml(res, req.method === 'GET' && url.pathname === '/dashboard' ? 200 : 401, board.loginPage()), true;
    if (route === 'GET /dashboard') return sendHtml(res, 200, await board.overview(origin)), true;
    if (route === 'POST /dashboard/rules') {
      const text = (await readForm(req)).get('text') ?? '';
      const reply = await this.registry.proposeRulesFor(origin, text);
      const notice = reply.status === 201 ? html`<div class="card notice">Proposed. Check the policy below, then confirm it to apply.</div>` : html`<div class="card error">${(reply.body as { message?: string }).message ?? 'The rules could not be turned into a policy.'}</div>`;
      return sendHtml(res, reply.status === 201 ? 200 : 422, await board.overview(origin, notice)), true;
    }
    const confirm = /^\/dashboard\/rules\/(r_[A-Za-z0-9_-]+)\/confirm$/.exec(url.pathname);
    if (confirm && req.method === 'POST') {
      const reply = await this.registry.confirmRulesFor(origin, confirm[1]!);
      return sendHtml(res, reply.status, await board.overview(origin, reply.status === 200 ? html`<div class="card notice">Rules applied.</div>` : html`<div class="card error">That draft is no longer pending.</div>`)), true;
    }
    if (route === 'POST /dashboard/explain') {
      const failure = await this.hooks.explain?.(origin);
      return sendHtml(res, 200, await board.overview(origin, failure ? html`<div class="card error">${failure}</div>` : html`<div class="card notice">Explanations updated.</div>`)), true;
    }
    const session = /^\/dashboard\/sessions\/(s_[A-Za-z0-9_-]+)(\/explain)?$/.exec(url.pathname);
    if (session && (req.method === 'GET' || session[2])) {
      if (session[2] && req.method === 'POST') await this.registry.explainSession(origin, session[1]!, true).catch(() => null);
      const body = await board.sessionPage(origin, session[1]!);
      return sendHtml(res, body ? 200 : 404, body ?? page('Not found', html`<h1>No such session for ${origin}</h1>`)), true;
    }
    const map = /^\/dashboard\/maps\/(sha256(?::|%3A)[0-9a-f]{64})$/.exec(url.pathname);
    if (map && req.method === 'GET') {
      const record = await this.registry.storage.getMap(origin, decodeURIComponent(map[1]!));
      if (!record) return sendHtml(res, 404, page('Not found', html`<h1>No such map for ${origin}</h1>`)), true;
      return sendHtml(res, 200, mapPage(record.map, { source: record.submitted_by ? 'shared by an agent' : `compiled by ${record.map.provenance.compiler ?? 'the registry'}`, record })), true;
    }
    return sendHtml(res, 404, page('Not found', html`<h1>Page not found</h1>`)), true;
  }
}
