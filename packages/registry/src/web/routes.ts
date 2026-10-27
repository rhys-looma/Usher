// The registry's web pages: the front page, map viewer, map pages, the site dashboard, the
// specifications, and the admin list of interest.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toBase64Url } from '@usher/core';
import { createUsherCheck } from '@usher/site-middleware';
import { clientAddress } from '../forwarded.ts';
import type { Registry } from '../registry.ts';
import { Dashboard, type DashboardHooks } from './dashboard.ts';
import { html, page, when } from './html.ts';
import { landingPage, loadNumbers, type LandingOptions, type Numbers } from './landing.ts';
import { ROBOTS, privacyPage, securityTxt } from './privacy.ts';
import { claimPage, explainClaim, explainRegistration, keysFile, keysPage, lostPage, startPage, tagPage } from './signup.ts';
import { Viewer, mapPage, viewerPage, type ViewerOptions } from './viewer.ts';

export interface WebOptions extends Omit<ViewerOptions, 'storage'> {
  hooks?: DashboardHooks;
  /** USHER_ADMIN_KEY: signs in to /admin, the list of interest. No admin pages without it. */
  adminKey?: string;
  /** USHER_CONTACT_EMAIL: named on /privacy and in security.txt. */
  contact?: string;
  /**
   * The public map viewer (/viewer and the front page's "Try it"). Off unless set: it opens any URL
   * a visitor gives in a browser, and redirects or the page's own requests can reach private
   * addresses behind the first check. USHER_VIEWER=1; production refuses it until that is fixed.
   */
  viewer?: boolean;
  /** Trusted proxy hops: the visitor's address for the viewer's limits comes from X-Forwarded-For. */
  proxyHops?: number;
}

const SPEC_DIR = new URL('../../../../spec/', import.meta.url);
const OG_IMAGE = new URL('../../assets/og.png', import.meta.url);
/** The intent the interest form's endpoint protects: agents knock for it like any site's. */
export const INTEREST_INTENT = 'contact.interest';

interface Interest {
  ts: string;
  site: string;
  email: string;
  note: string;
  /** Who sent it: a person, or an agent that knocked. */
  via: 'person' | 'agent';
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20_000) throw new Error('too_large');
  }
  return new URLSearchParams(body);
}

function sendText(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, body: string, options: { siteScript?: boolean } = {}): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    // One inline stylesheet and forms that post to themselves. The front page also runs Usher's
    // own site script, which talks only to this origin.
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:;${options.siteScript ? " script-src 'self'; connect-src 'self';" : ''} form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  });
  res.end(body);
}

type UsherCheck = ReturnType<typeof createUsherCheck>;
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location });
  res.end();
}

export class Web {
  readonly viewer: Viewer;
  private dashboard?: Dashboard;
  private readonly started = new Date();

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

  private numbers?: Promise<Numbers>;
  private interestCheck?: UsherCheck;

  /** The front page, with Usher's own site key on its tag. */
  private async landing(extra: Partial<LandingOptions> = {}): Promise<string> {
    this.numbers ??= loadNumbers();
    const own = await this.registry.ownSite();
    return landingPage({ url: this.registry.url, siteKey: own.site_key, numbers: await this.numbers, viewerOn: Boolean(this.options.viewer), ...extra });
  }

  /** The server-side check on the interest form, as any site would run it. Keys come from this registry directly. */
  private async check(): Promise<UsherCheck> {
    if (this.interestCheck) return this.interestCheck;
    const own = await this.registry.ownSite();
    const registry = this.registry;
    this.interestCheck = createUsherCheck({
      registry: registry.url,
      intent: INTEREST_INTENT,
      origin: own.origin,
      siteKey: own.site_key,
      fetch: async (input, init) => (String(input).endsWith('/.well-known/usher-keys.json') ? new Response(JSON.stringify(await registry.keySet()), { headers: { 'Content-Type': 'application/json' } }) : fetch(input, init)),
    });
    return this.interestCheck;
  }

  private signAdmin(value: string, secret: string): string {
    return toBase64Url(createHmac('sha256', secret).update(value).digest());
  }

  private async isAdmin(req: IncomingMessage): Promise<boolean> {
    if (!this.options.adminKey) return false;
    const raw = /(?:^|;\s*)usher_admin=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const [until, mac] = raw?.split('.') ?? [];
    if (!until || !mac || Number(until) < Date.now()) return false;
    const expected = this.signAdmin(until, await this.registry.derivedSecret('admin'));
    return expected.length === mac.length && timingSafeEqual(Buffer.from(expected), Buffer.from(mac));
  }

  private async specFiles(): Promise<string[]> {
    const root = fileURLToPath(SPEC_DIR);
    const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isFile() && /\.(md|json)$/.test(e.name)).map((e) => relative(root, `${e.parentPath}/${e.name}`)).sort();
  }

  /** The front page, the specifications, Usher's own claim file and the admin list; false if none. */
  private async site(req: IncomingMessage, res: ServerResponse, url: URL, route: string): Promise<boolean> {
    if (route === 'GET /') return sendHtml(res, 200, await this.landing(), { siteScript: true }), true;
    if (route === 'GET /og.png') {
      const png = await readFile(OG_IMAGE).catch(() => null);
      if (!png) return false;
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(png), true;
    }
    // Usher's own claim to its origin, like any site's.
    if (route === 'GET /privacy') return sendHtml(res, 200, privacyPage({ url: this.registry.url, ...(this.options.contact && { contact: this.options.contact }) })), true;
    if (route === 'GET /robots.txt') return sendText(res, ROBOTS), true;
    if (route === 'GET /.well-known/security.txt') {
      const text = securityTxt({ url: this.registry.url, started: this.started, ...(this.options.contact && { contact: this.options.contact }) });
      return text ? (sendText(res, text), true) : false;
    }
    if (route === 'GET /.well-known/usher-site.json') {
      const own = await this.registry.ownSite();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
      return res.end(JSON.stringify({ usher_site: '0.1', site_key: own.site_key })), true;
    }
    if (route === 'POST /interest') {
      const form = await readForm(req);
      const check = await (await this.check()).check(req, { form, action: 'form.submit' });
      if (check.status === 'knock_required') return (await this.check()).reject(req, res, check, 'form.submit'), true;
      const site = (form.get('site') ?? '').trim();
      const email = (form.get('email') ?? '').trim();
      const note = (form.get('note') ?? '').trim().slice(0, 200);
      let error = '';
      try {
        if (!/^https?:$/.test(new URL(site).protocol)) error = 'Give your site\'s address, starting https://.';
      } catch {
        error = 'Give your site\'s address, starting https://.';
      }
      if (!error && (!EMAIL.test(email) || email.length > 200)) error = 'That email address doesn\'t look right.';
      if (error) return sendHtml(res, 422, await this.landing({ interest: { error } }), { siteScript: true }), true;
      const record: Interest = { ts: new Date().toISOString(), site: site.slice(0, 300), email, note, via: check.status === 'human' ? 'person' : 'agent' };
      await this.registry.storage.appendLog('interest', record);
      return redirect(res, '/interest/thanks'), true;
    }
    if (route === 'GET /interest/thanks') return sendHtml(res, 200, page('Thank you', html`<h1>Thank you</h1><p class="lede">We'll be in touch about your site. <a href="/">Back to the front page</a>.</p>`)), true;
    if (route === 'GET /spec' || route === 'GET /spec/') {
      const files = await this.specFiles();
      return sendHtml(res, 200, page('Specifications', html`<h1>Specifications</h1><p class="lede">The open specifications, CC BY 4.0. Examples name this server where they name a registry.</p><div class="card"><ul>${files.map((f) => html`<li><a href="/spec/${f}">${f}</a></li>`)}</ul></div>`)), true;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/spec/')) {
      const name = decodeURIComponent(url.pathname.slice('/spec/'.length));
      if (!(await this.specFiles()).includes(name)) return false;
      // Examples use the reserved example domain for a registry; this server is the registry here.
      const text = (await readFile(new URL(name, SPEC_DIR), 'utf8')).replaceAll('https://registry.example', this.registry.url);
      res.writeHead(200, { 'Content-Type': name.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      return res.end(text), true;
    }
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      if (!this.options.adminKey) return sendHtml(res, 404, page('Not found', html`<h1>Page not found</h1>`)), true;
      if (route === 'POST /admin/login') {
        const given = (await readForm(req)).get('key') ?? '';
        if (!timingSafeEqual(sha256(given), sha256(this.options.adminKey))) return sendHtml(res, 401, this.adminLogin('That key is not right.')), true;
        const until = String(Date.now() + 12 * 3600_000);
        res.setHeader('Set-Cookie', `usher_admin=${until}.${this.signAdmin(until, await this.registry.derivedSecret('admin'))}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=43200${this.registry.url.startsWith('https://') ? '; Secure' : ''}`);
        return redirect(res, '/admin'), true;
      }
      if (!(await this.isAdmin(req))) return sendHtml(res, route === 'GET /admin' ? 200 : 401, this.adminLogin()), true;
      if (route === 'GET /admin') {
        const list = ((await this.registry.storage.readLog('interest')) as Interest[]).reverse();
        return sendHtml(
          res,
          200,
          page(
            'Interest',
            html`<h1>Interest</h1><p class="lede">${list.length} from the front page's form, newest first.</p>
<div class="card"><table><thead><tr><th>When</th><th>Site</th><th>Email</th><th>Note</th><th>Sent by</th></tr></thead>
<tbody>${list.map((i) => html`<tr><td>${when(i.ts)}</td><td>${i.site}</td><td>${i.email}</td><td>${i.note}</td><td>${i.via === 'agent' ? 'an agent' : 'a person'}</td></tr>`)}</tbody></table></div>`,
          ),
        ), true;
      }
      return sendHtml(res, 404, page('Not found', html`<h1>Page not found</h1>`)), true;
    }
    return false;
  }

  /** Self-serve signup and the lost-key path (signup.ts). */
  private async signup(req: IncomingMessage, res: ServerResponse, url: URL, route: string): Promise<boolean> {
    const board = await this.board();
    const originOf = (raw: string | null): string | null => {
      try {
        const u = new URL((raw ?? '').trim());
        return /^https?:$/.test(u.protocol) ? u.origin : null;
      } catch {
        return null;
      }
    };
    if (route === 'GET /sites/new') return sendHtml(res, 200, startPage()), true;
    if (route === 'POST /sites/new') {
      const raw = (await readForm(req)).get('origin');
      const origin = originOf(raw);
      if (!origin) return sendHtml(res, 422, startPage({ origin: raw ?? '', error: explainRegistration('invalid_request', '', raw ?? '') })), true;
      const reply = await this.registry.registerSite({ origin });
      if (reply.status !== 201) {
        const body = reply.body as { error: string; message: string };
        return sendHtml(res, reply.status, startPage({ origin, error: explainRegistration(body.error, body.message, origin) })), true;
      }
      const keys = reply.body as { site_key: string; secret_key: string };
      board.signIn(res, origin);
      return sendHtml(res, 201, keysPage({ origin, siteKey: keys.site_key, secretKey: keys.secret_key })), true;
    }
    if (route === 'POST /sites/new/keys') {
      // The keys page posts them back to be saved as a file; nothing is stored or logged.
      const form = await readForm(req);
      const origin = originOf(form.get('origin'));
      const siteKey = form.get('site_key') ?? '';
      const secretKey = form.get('secret_key') ?? '';
      if (!origin || !/^usp_[\w-]{1,64}$/.test(siteKey) || !/^uss_[\w-]{1,64}$/.test(secretKey)) return sendHtml(res, 400, startPage()), true;
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="usher-keys.txt"', 'Cache-Control': 'no-store' });
      return res.end(keysFile({ origin, siteKey, secretKey })), true;
    }
    if (route === 'GET /sites/lost') return sendHtml(res, 200, lostPage()), true;
    if (route === 'POST /sites/lost') {
      const raw = (await readForm(req)).get('origin');
      const origin = originOf(raw);
      if (!origin) return sendHtml(res, 422, lostPage({ origin: raw ?? '', error: 'Enter the address of your site, like https://www.example.com.' })), true;
      const site = await this.registry.storage.getSite(origin);
      const reply = await this.registry.reissueSecret(origin);
      if (reply.status === 404 || !site) return sendHtml(res, 404, lostPage({ origin, error: html`We don't have keys for ${origin}. <a href="/sites/new">Get keys</a>.` })), true;
      if (reply.status !== 200) return sendHtml(res, 422, lostPage({ origin, site, failure: explainClaim(origin, (reply.body as { tried?: { method: string; result: string }[] }).tried ?? []) })), true;
      const keys = reply.body as { site_key: string; secret_key: string };
      board.signIn(res, origin);
      return sendHtml(res, 200, keysPage({ origin, siteKey: keys.site_key, secretKey: keys.secret_key, reissued: true })), true;
    }
    // Steps 2 and 3 belong to the site this browser just got keys for.
    const origin = board.originOf(req);
    const site = origin ? await this.registry.storage.getSite(origin) : undefined;
    if (!site && (route === 'GET /sites/new/tag' || url.pathname === '/sites/new/claim')) return redirect(res, '/sites/new'), true;
    if (route === 'GET /sites/new/tag') return sendHtml(res, 200, tagPage({ url: this.registry.url, siteKey: site!.site_key })), true;
    if (route === 'GET /sites/new/claim') return site!.claim ? redirect(res, '/dashboard') : sendHtml(res, 200, claimPage({ url: this.registry.url, site: site! })), true;
    if (route === 'POST /sites/new/claim') {
      const reply = await this.registry.verifySiteFor(site!.origin);
      if (reply.status === 200) return redirect(res, '/dashboard?welcome'), true;
      return sendHtml(res, 422, claimPage({ url: this.registry.url, site: site!, failure: explainClaim(site!.origin, (reply.body as { tried?: { method: string; result: string }[] }).tried ?? []) })), true;
    }
    return false;
  }

  private adminLogin(error?: string): string {
    return page('Admin', html`<h1>Admin</h1>${error ? html`<div class="card error">${error}</div>` : ''}<form class="card" method="post" action="/admin/login"><p><label>Admin key<br><input type="password" name="key" required autocomplete="off"></label></p><button type="submit">Sign in</button></form>`);
  }

  private async board(): Promise<Dashboard> {
    this.dashboard ??= new Dashboard(this.registry, await this.registry.derivedSecret('dashboard'), this.hooks);
    return this.dashboard;
  }

  /** Handles a page request; false if the path is not a page. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const route = `${req.method} ${url.pathname}`;
    if (await this.site(req, res, url, route)) return true;
    if (url.pathname === '/viewer' && !this.options.viewer) return sendHtml(res, 404, page('Map viewer', html`<h1>The map viewer is switched off for now</h1><p class="lede"><a href="/">Back to the front page</a>.</p>`)), true;
    if (route === 'GET /viewer') return sendHtml(res, 200, viewerPage()), true;
    if (route === 'POST /viewer') {
      const form = await readForm(req);
      const target = form.get('url') ?? '';
      // The client address limits how often one visitor can compile; it is never stored.
      const result = await this.viewer.compile(target, clientAddress(req, this.options.proxyHops));
      const status = result.ok ? 200 : result.reason === 'rate_limited' ? 429 : 422;
      // From the front page's box, a failure is explained there.
      if (!result.ok && form.get('from') === 'home') return sendHtml(res, status, await this.landing({ viewer: { url: target, error: result.message } }), { siteScript: true }), true;
      if (!result.ok) return sendHtml(res, status, viewerPage({ url: target, error: result })), true;
      const source = `${result.cached ? 'from cache' : `compiled by ${result.model}`} in ${(result.ms / 1000).toFixed(1)}s${result.cost_usd ? `, $${result.cost_usd.toFixed(4)}` : ''}`;
      return sendHtml(res, 200, mapPage(result.map, { source, ...(result.flags && { flags: result.flags }) })), true;
    }
    if (route === 'GET /maps/view') {
      const origin = url.searchParams.get('origin') ?? '';
      const digest = url.searchParams.get('digest') ?? '';
      const record = await this.registry.storage.getMap(origin, digest);
      if (!record) return sendHtml(res, 404, page('Not found', html`<h1>No such map</h1>`)), true;
      return sendHtml(res, 200, mapPage(record.map, { source: `held by this registry since ${record.added_at.slice(0, 10)}`, record })), true;
    }

    if (url.pathname.startsWith('/sites/')) return this.signup(req, res, url, route);
    if (!url.pathname.startsWith('/dashboard')) return false;
    const board = await this.board();
    if (route === 'POST /dashboard/login') {
      const origin = await board.login(res, await readForm(req));
      return origin ? redirect(res, '/dashboard') : sendHtml(res, 401, board.loginPage('That origin and secret key do not match a registered site.')), true;
    }
    if (route === 'POST /dashboard/logout') return board.logout(res), redirect(res, '/dashboard'), true;

    const origin = board.originOf(req);
    if (!origin) return sendHtml(res, req.method === 'GET' && url.pathname === '/dashboard' ? 200 : 401, board.loginPage()), true;
    // Nothing is shown until the site has proved it controls its origin.
    const site = await this.registry.storage.getSite(origin);
    if (!site) return board.logout(res), redirect(res, '/dashboard'), true;
    if (route === 'POST /dashboard/verify') {
      const reply = await this.registry.verifySiteFor(origin);
      if (reply.status === 200) return redirect(res, '/dashboard?welcome'), true;
      return sendHtml(res, 422, claimPage({ url: this.registry.url, site, fromDashboard: true, failure: explainClaim(origin, (reply.body as { tried?: { method: string; result: string }[] }).tried ?? []) })), true;
    }
    // Until the site has proved it holds its origin, the dashboard shows what's missing, and nothing else.
    if (!site.claim) return sendHtml(res, req.method === 'GET' && url.pathname === '/dashboard' ? 200 : 403, claimPage({ url: this.registry.url, site, fromDashboard: true })), true;
    if (route === 'GET /dashboard') return sendHtml(res, 200, await board.overview(origin, url.searchParams.has('welcome') ? html`<div class="card notice"><b>You're set up.</b> Agents that knock on your forms will show up here, with what they did, step by step.</div>` : undefined)), true;
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
      return sendHtml(res, 200, mapPage(record.map, { source: record.submitted_by ? 'shared by an agent' : `built by ${record.map.provenance.compiler ?? 'Usher'}`, record, owner: true })), true;
    }
    return sendHtml(res, 404, page('Not found', html`<h1>Page not found</h1>`)), true;
  }
}
