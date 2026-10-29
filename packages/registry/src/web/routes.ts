// The registry's web pages: the front page, map viewer, map pages, the site dashboard, the
// specifications, and the admin list of interest.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetExceeded, toBase64Url } from '@usher/core';
import { createUsherCheck } from '@usher/site-middleware';
import { clientAddress } from '../forwarded.ts';
import { visibleTo, type Registry } from '../registry.ts';
import { Dashboard, recordAdminAction, type DashboardHooks } from './dashboard.ts';
import { html, page, when } from './html.ts';
import { landingPage, loadNumbers, type LandingOptions, type Numbers } from './landing.ts';
import { ROBOTS, privacyPage, securityTxt } from './privacy.ts';
import { DEMO_JS, SITE_JS } from './site-js.ts';
import { RateLimiter } from '../rate-limit.ts';
import { statusPage, statusReport, type StatusSources } from './status.ts';
import { claimPage, explainClaim, explainRegistration, keysFile, keysPage, lostPage, startPage, tagPage } from './signup.ts';
import { Viewer, mapPage, viewerPage, type ViewerOptions, type ViewerResult } from './viewer.ts';
import type { TestValues, Walkthroughs } from '../walkthrough.ts';
import type { Trainer } from '../trainer.ts';
import type { TrainingExample } from '@usher/core';
import { Learning, learningPage, teachingPage } from './learning.ts';
import { ANNOTATE_STYLE, WALKTHROUGH_JS, annotated, startForm, walkthroughCard, walkthroughPage } from './walkthrough.ts';

export interface WebOptions extends Omit<ViewerOptions, 'storage'> {
  hooks?: DashboardHooks;
  /** USHER_ADMIN_KEY: signs in to /admin, the list of interest. No admin pages without it. */
  adminKey?: string;
  /** USHER_CONTACT_EMAIL: named on /privacy and in security.txt. */
  contact?: string;
  /**
   * The map viewer (/viewer and the front page's "Try it"). 'picker' (the default): anyone picks
   * one of `forms`, and a signed-in owner may map pages on their own claimed origin. 'open': any
   * address, for local demos only (USHER_VIEWER=open; production refuses it).
   */
  viewer?: 'picker' | 'open';
  /** Trusted proxy hops: the visitor's address for the viewer's limits comes from X-Forwarded-For. */
  proxyHops?: number;
  /** What /status reports beyond storage: the version and the model spend. */
  status?: Omit<StatusSources, 'started'>;
  /** Hosted MCP is served at /mcp: the front page offers it to assistants. */
  hostedMcp?: boolean;
  /** The walkthrough mapper ("Map my site"), when this registry has a model and a browser for it. */
  walkthroughs?: Walkthroughs;
  /** Automatic retraining of the student (USHER_AUTO_TRAIN), and the secret its deployment sends to fetch the promoted adapter. */
  training?: { trainer: Trainer; secret?: string };
}

/** "key: value" lines from the start form, held in memory for one run only. */
function testValues(text: string): TestValues {
  const out: TestValues = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([a-z][a-z0-9_.]*)\s*[:=]\s*(.*?)\s*$/.exec(line);
    if (m && m[2] !== '') out[m[1]!] = m[2] === 'true' ? true : m[2] === 'false' ? false : m[2]!;
  }
  return out;
}

/** Server-sent events for a run: its log so far, then each line, frame and the end. */
function streamRun(req: IncomingMessage, res: ServerResponse, walkthroughs: Walkthroughs, origin: string, id: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const send = (event: string, data: string) => res.write(`event: ${event}\ndata: ${data.replace(/\n/g, ' ')}\n\n`);
  const unsubscribe = walkthroughs.subscribe(origin, id, (e) => {
    if (e.type === 'frame') send('frame', e.data);
    else if (e.type === 'log') send('log', e.text);
    else {
      send('done', JSON.stringify({ status: e.status }));
      res.end();
    }
  });
  if (!unsubscribe) {
    send('done', '{}');
    res.end();
    return;
  }
  const alive = setInterval(() => res.write(': still here\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(alive);
    unsubscribe();
  });
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

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('too_large');
  }
  return JSON.parse(body || 'null') as unknown;
}

const bearerOf = (req: IncomingMessage) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';

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

const ADMIN_BANNER = (origin: string) =>
  `<div class="card warn"><b>Signed in as Usher's admin</b> on ${origin.replace(/[<>&"]/g, '')}, with its owner's powers. Changes are logged and shown to the owner. <a href="/admin/sites">All sites</a> · <form method="post" action="/dashboard/logout" style="display:inline"><button class="secondary">Leave</button></form></div>`;

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
const sendHtmlPage = sendHtml;

type UsherCheck = ReturnType<typeof createUsherCheck>;
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location });
  res.end();
}

export class Web {
  readonly viewer: Viewer;
  private readonly learning: Learning;
  private dashboard?: Dashboard;
  private readonly started = new Date();

  constructor(
    private readonly registry: Registry,
    private readonly options: WebOptions,
  ) {
    this.viewer = new Viewer({ ...options, storage: registry.storage });
    this.learning = new Learning(registry.storage);
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
    return landingPage({ url: this.registry.url, siteKey: own.site_key, numbers: await this.numbers, forms: this.viewer.forms, demo: Boolean(this.registry.publicDemo), hosted: Boolean(this.options.hostedMcp), ...extra });
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
    if (route === 'GET /learning') return sendHtml(res, 200, learningPage(await this.learning.counters())), true;
    if (route === 'GET /walkthrough.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      return res.end(WALKTHROUGH_JS), true;
    }
    if (route === 'GET /site.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      return res.end(SITE_JS), true;
    }
    if (route === 'GET /demo.js' && this.registry.publicDemo) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      return res.end(DEMO_JS), true;
    }
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
    if (url.pathname.startsWith('/training/') && this.options.training) return this.training(req, res, url, route, this.options.training);
    if (route === 'GET /status') {
      if (!this.options.adminKey) return false;
      // The admin cookie, or the admin key as a bearer token for monitors and curl.
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const allowed = (bearer && timingSafeEqual(sha256(bearer), sha256(this.options.adminKey))) || (await this.isAdmin(req));
      const json = /application\/json/.test(String(req.headers.accept ?? '')) || url.searchParams.get('format') === 'json';
      if (!allowed) {
        if (json || bearer) return res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'admin_key_required', message: 'Send the admin key as Authorization: Bearer, or sign in at /admin.' })), true;
        return sendHtml(res, 401, this.adminLogin()), true;
      }
      const status = await statusReport(this.registry, { version: 'dev', ...this.options.status, started: this.started });
      if (json) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(status)), true;
      return sendHtml(res, 200, statusPage(status)), true;
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
      const adminBearer = bearerOf(req);
      const byKey = Boolean(adminBearer) && timingSafeEqual(sha256(adminBearer), sha256(this.options.adminKey));
      if (!byKey && !(await this.isAdmin(req))) return sendHtml(res, route === 'GET /admin' ? 200 : 401, this.adminLogin()), true;
      if (route === 'GET /admin') {
        const list = ((await this.registry.storage.readLog('interest')) as Interest[]).reverse();
        return sendHtml(
          res,
          200,
          page(
            'Interest',
            html`<h1>Interest</h1><p class="lede">${list.length} from the front page's form, newest first. <a href="/admin/sites">All sites</a>.</p>
<div class="card"><table><thead><tr><th>When</th><th>Site</th><th>Email</th><th>Note</th><th>Sent by</th></tr></thead>
<tbody>${list.map((i) => html`<tr><td>${when(i.ts)}</td><td>${i.site}</td><td>${i.email}</td><td>${i.note}</td><td>${i.via === 'agent' ? 'an agent' : 'a person'}</td></tr>`)}</tbody></table></div>`,
          ),
        ), true;
      }
      // Every site, and its dashboard with its owner's powers (logged, and shown to the owner).
      if (route === 'GET /admin/sites') return sendHtml(res, 200, await this.adminSites()), true;
      if (route === 'POST /admin/sites/open') {
        const origin = ((await readForm(req)).get('origin') ?? '').trim();
        if (!(await this.registry.storage.getSite(origin))) return sendHtml(res, 404, page('Not found', html`<h1>No such site</h1><p><a href="/admin/sites">All sites</a></p>`)), true;
        (await this.board()).adminSignIn(res, origin);
        await recordAdminAction(this.registry.storage, origin, 'opened the dashboard');
        return redirect(res, '/dashboard'), true;
      }
      const trainer = this.options.training?.trainer;
      if (trainer && route === 'GET /admin/training') return res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(await trainer.status(), null, 2)), true;
      if (trainer && route === 'POST /admin/training/check') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ what: await trainer.tick() })), true;
      // The base set: npm run training:upload-base sends the export's examples (structure only).
      if (trainer && route === 'POST /admin/training/base') {
        const body = (await readJsonBody(req, 50_000_000)) as { examples?: TrainingExample[] } | null;
        if (!Array.isArray(body?.examples)) return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'examples_required' })), true;
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ stored: await trainer.setBase(body.examples) })), true;
      }
      // Owners' corrections, for npm run finetune:export -- --corrections <file>: structure only.
      if (route === 'GET /admin/corrections.jsonl') {
        const rows = await this.registry.storage.readLog('corrections');
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(rows.map((r) => `${JSON.stringify(r)}\n`).join('')), true;
      }
      const walk = this.options.walkthroughs;
      const demoOrigin = this.registry.publicDemo?.origin;
      // The operator may walk the public demo site, and only it: every other site is its owner's.
      if (walk && demoOrigin && route === 'POST /admin/walkthrough') {
        const form = await readForm(req);
        const started = await walk.start({ origin: demoOrigin, start: `${demoOrigin}${(form.get('path') ?? '/').startsWith('/') ? (form.get('path') ?? '/') : '/'}`, generated: true, pressFinal: form.get('final') === '1', by: 'operator' });
        if ('refused' in started) return sendHtml(res, 422, page('Walkthrough', html`<h1>Walkthrough</h1><div class="card error">${started.refused}</div>`)), true;
        return redirect(res, '/demo/walkthrough'), true;
      }
      if (walk && demoOrigin && route === 'POST /admin/walkthrough/publish') {
        const n = await walk.publish(demoOrigin);
        return sendHtml(res, 200, page('Walkthrough', html`<h1>Published</h1><p>${String(n)} map${n === 1 ? '' : 's'} for ${demoOrigin}.</p>`)), true;
      }
      return sendHtml(res, 404, page('Not found', html`<h1>Page not found</h1>`)), true;
    }
    return false;
  }

  /**
   * The retraining job's calls back (its run's token) and the student deployment's adapter fetch
   * (the training secret). JSON only; 404 for anything not authorised, so nothing is given away.
   */
  private async training(req: IncomingMessage, res: ServerResponse, url: URL, route: string, training: NonNullable<WebOptions['training']>): Promise<boolean> {
    const json = (status: number, body: unknown) => (res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body)), true);
    const notFound = () => json(404, { error: 'not_found' });
    const token = bearerOf(req);
    if (route === 'GET /training/student') {
      if (!training.secret || !token || !timingSafeEqual(sha256(token), sha256(training.secret))) return notFound();
      return json(200, await training.trainer.promotedAdapter());
    }
    const m = /^\/training\/runs\/([0-9A-Za-z]+)\/(files\/([a-z.]+)|previous|result)$/.exec(url.pathname);
    if (!m) return notFound();
    const [, id, what, name] = m as unknown as [string, string, string, string | undefined];
    if (req.method === 'GET' && name) {
      const body = await training.trainer.file(id, token, name);
      if (body === null) return notFound();
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(body), true;
    }
    if (req.method === 'GET' && what === 'previous') {
      const files = await training.trainer.previousAdapter(id, token);
      return files === null ? notFound() : json(200, files);
    }
    if (req.method === 'POST' && what === 'result') {
      const body = await readJsonBody(req, 100_000).catch(() => null);
      return (await training.trainer.report(id, token, body)) ? json(200, { ok: true }) : notFound();
    }
    return notFound();
  }

  /** /admin/sites: every registered site, with what the operator needs to pick one. */
  private async adminSites(): Promise<string> {
    const storage = this.registry.storage;
    const corrections = (await storage.readLog('corrections')) as { origin?: string }[];
    const rows = await Promise.all(
      (await storage.listSites()).map(async (site) => {
        const [maps, sessions] = await Promise.all([storage.mapsForOrigin(site.origin), storage.listSessions(site.origin)]);
        const last = sessions.reduce<string | null>((m, x) => (m === null || x.created_at > m ? x.created_at : m), null);
        return { site, maps: maps.length, sessions: sessions.length, last, corrections: corrections.filter((c) => c.origin === site.origin).length };
      }),
    );
    rows.sort((a, b) => (b.last ?? b.site.created_at).localeCompare(a.last ?? a.site.created_at));
    return page(
      'All sites',
      html`<h1>All sites</h1><p class="lede">${String(rows.length)} registered, most recently active first. Open one to see and change it as its owner would; every change is logged and shown to the owner. <a href="/admin">Interest</a>.</p>
<div class="card"><table><thead><tr><th>Site</th><th>Claim</th><th>Maps</th><th>Sessions</th><th>Corrections</th><th>Last agent</th><th>Registered</th><th></th></tr></thead>
<tbody>${rows.map(
        (r) => html`<tr><td class="mono">${r.site.origin}</td><td>${r.site.claim ? html`<span class="badge">${r.site.claim.method}</span>` : html`<span class="muted">not proved</span>`}</td><td>${String(r.maps)}</td><td>${String(r.sessions)}</td><td>${String(r.corrections)}</td><td>${r.last ? when(r.last) : html`<span class="muted">none</span>`}</td><td>${when(r.site.created_at)}</td>
<td><form method="post" action="/admin/sites/open"><input type="hidden" name="origin" value="${r.site.origin}"><button class="secondary">Open as owner</button></form></td></tr>`,
      )}</tbody></table></div>`,
    );
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

  // The rules sandbox calls the model: a few previews per visitor an hour, and a ceiling for everyone.
  private readonly previewPerClient = new RateLimiter(5, 3_600_000);
  private readonly previewOverall = new RateLimiter(60, 3_600_000);

  /** The demo site's dashboard for anyone, read-only: /demo/dashboard (dashboard.ts, DemoView). */
  private async demoBoard(req: IncomingMessage, res: ServerResponse, url: URL, route: string): Promise<boolean> {
    const demo = this.registry.publicDemo;
    if (!demo) return sendHtml(res, 404, page('Not found', html`<h1>Page not found</h1>`)), true;
    const board = await this.board();
    const live = { siteScript: true };
    if (route === 'GET /demo/dashboard') return sendHtml(res, 200, await board.overview(demo.origin, undefined, {}), live), true;
    if (route === 'POST /demo/dashboard/rules') {
      const text = ((await readForm(req)).get('text') ?? '').trim();
      const client = clientAddress(req, this.options.proxyHops);
      const allowed = this.previewPerClient.allow(client) && this.previewOverall.allow('all');
      const reply = allowed ? await this.registry.previewRules(demo.origin, text) : { status: 429, body: { message: 'Too many previews for now; try again in an hour.' } };
      const maps = (await this.registry.mapsFor(demo.origin)).map((r) => r.map);
      return sendHtml(res, reply.status === 200 ? 200 : reply.status, await board.overview(demo.origin, undefined, { preview: board.previewCard(text, reply, maps) }), live), true;
    }
    const session = /^\/demo\/dashboard\/sessions\/(s_[A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (session && req.method === 'GET') {
      const body = await board.sessionPage(demo.origin, session[1]!, {});
      return sendHtml(res, body ? 200 : 404, body ?? page('Not found', html`<h1>No such session on the demo site</h1><p><a href="/demo/dashboard">Back to the demo dashboard</a></p>`), live), true;
    }
    return sendHtml(res, req.method === 'GET' ? 404 : 405, page('Not found', html`<h1>Page not found</h1><p class="lede">The demo dashboard is read-only.</p>`)), true;
  }

  private adminLogin(error?: string): string {
    return page('Admin', html`<h1>Admin</h1>${error ? html`<div class="card error">${error}</div>` : ''}<form class="card" method="post" action="/admin/login"><p><label>Admin key<br><input type="password" name="key" required autocomplete="off"></label></p><button type="submit">Sign in</button></form>`);
  }

  /** The origin this browser is signed in to, once that site has proved it controls it. */
  private async claimedOrigin(req: IncomingMessage): Promise<string | undefined> {
    const origin = (await this.board()).originOf(req);
    return origin && (await this.registry.storage.getSite(origin))?.claim ? origin : undefined;
  }

  private async board(): Promise<Dashboard> {
    this.dashboard ??= new Dashboard(this.registry, await this.registry.derivedSecret('dashboard'), this.hooks);
    return this.dashboard;
  }

  /** Handles a page request; false if the path is not a page. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const route = `${req.method} ${url.pathname}`;
    if (await this.site(req, res, url, route)) return true;
    if (route === 'GET /viewer' || route === 'POST /viewer') {
      const open = this.options.viewer === 'open';
      const owner = await this.claimedOrigin(req);
      const forms = this.viewer.forms;
      if (route === 'GET /viewer') return sendHtml(res, 200, viewerPage({ forms, open, ...(owner && { owner }) })), true;
      const form = await readForm(req);
      const id = form.get('form');
      const target = form.get('url') ?? '';
      // The client address limits how often one visitor can compile; it is never stored.
      const client = clientAddress(req, this.options.proxyHops);
      // A picked form by id; an address only from a signed-in owner (their own origin) or a local demo.
      const result: ViewerResult = id
        ? await this.viewer.pick(id, client)
        : target && (owner || open)
          ? await this.viewer.compile(target, client, open ? {} : { owner: owner! })
          : { ok: false, reason: 'unknown_form', message: 'Pick one of the forms listed.' };
      const status = result.ok ? 200 : result.reason === 'rate_limited' ? 429 : 422;
      // From the front page's box, a failure is explained there.
      if (!result.ok && form.get('from') === 'home') return sendHtml(res, status, await this.landing({ viewer: { url: target, error: result.message } }), { siteScript: true }), true;
      if (!result.ok) return sendHtml(res, status, viewerPage({ forms, open, url: target, error: result, ...(owner && { owner }) })), true;
      const source = `${result.cached ? 'from cache' : `compiled by ${result.model}`} in ${(result.ms / 1000).toFixed(1)}s${result.cost_usd ? `, $${result.cost_usd.toFixed(4)}` : ''}`;
      return sendHtml(res, 200, mapPage(result.map, { source, ...(result.flags && { flags: result.flags }), ...(id && { annotated: `/viewer/annotated?form=${encodeURIComponent(id)}` }) })), true;
    }
    if (route === 'GET /viewer/annotated') {
      const id = url.searchParams.get('form') ?? '';
      const drawn = await this.viewer.annotate(id);
      if (!drawn) return sendHtml(res, 404, page('Map viewer', html`<h1>Not drawn yet</h1><p>Pick the form in the <a href="/viewer">map viewer</a> first; its map is drawn from there.</p>`)), true;
      const body = html`<p class="muted small"><a href="/viewer">Map viewer</a> · ${drawn.url}</p>
<h1>How Usher reads this form</h1>
<p class="lede">${drawn.map.form.purpose}. Each box is one element Usher mapped: green is safe for an assistant to fill, amber is consequential (the person confirms), red is the person's own to answer. Anything that could show an answer is greyed out.</p>
${annotated(drawn, { anchor: 'v' })}`;
      return sendHtml(res, 200, page('How Usher reads this form', body, { scripts: ['/walkthrough.js'], style: ANNOTATE_STYLE }), { siteScript: true }), true;
    }
    if (route === 'GET /maps/view') {
      const origin = url.searchParams.get('origin') ?? '';
      const digest = url.searchParams.get('digest') ?? '';
      const found = await this.registry.storage.getMap(origin, digest);
      // An agent's unverified map is private to that agent (and its site's owner, on the dashboard).
      const record = found && visibleTo(found) ? found : undefined;
      if (!record) return sendHtml(res, 404, page('Not found', html`<h1>No such map</h1>`)), true;
      return sendHtml(res, 200, mapPage(record.map, { source: `held by this registry since ${record.added_at.slice(0, 10)}`, record })), true;
    }

    if (url.pathname === '/demo/dashboard' || url.pathname.startsWith('/demo/dashboard/')) return this.demoBoard(req, res, url, route);
    // The demo site's last walkthrough, live or finished, read-only, for anyone.
    if ((route === 'GET /demo/walkthrough' || route === 'GET /demo/walkthrough/events') && this.registry.publicDemo && this.options.walkthroughs) {
      const demo = this.registry.publicDemo.origin;
      const run = await this.options.walkthroughs.get(demo);
      if (route === 'GET /demo/walkthrough/events') return streamRun(req, res, this.options.walkthroughs, demo, url.searchParams.get('id') ?? ''), true;
      return sendHtml(res, 200, walkthroughPage(run, { editable: false, ...(run && { events: `/demo/walkthrough/events?id=${run.id}` }), title: 'Watch Usher map a site' }), { siteScript: true }), true;
    }
    if (url.pathname.startsWith('/sites/')) return this.signup(req, res, url, route);
    if (!url.pathname.startsWith('/dashboard')) return false;
    const board = await this.board();
    if (route === 'POST /dashboard/login') {
      const origin = await board.login(res, await readForm(req));
      return origin ? redirect(res, '/dashboard') : sendHtml(res, 401, board.loginPage('That origin and secret key do not match a registered site.')), true;
    }
    if (route === 'POST /dashboard/logout') return board.logout(res), redirect(res, '/dashboard'), true;

    const signedIn = board.sessionOf(req);
    if (!signedIn) return sendHtml(res, req.method === 'GET' && url.pathname === '/dashboard' ? 200 : 401, board.loginPage()), true;
    const { origin, admin } = signedIn;
    // Nothing is shown until the site has proved it controls its origin.
    const site = await this.registry.storage.getSite(origin);
    if (!site) return board.logout(res), redirect(res, '/dashboard'), true;
    // Usher's admin, from /admin/sites: every page says so, and every change is logged for the owner.
    const send: typeof sendHtmlPage = admin ? (r, status, body, options) => sendHtmlPage(r, status, body.replace('<main>', `<main>${ADMIN_BANNER(origin)}`), options) : sendHtmlPage;
    if (admin && req.method === 'POST') await recordAdminAction(this.registry.storage, origin, route.replace(/\/(s|r)_[A-Za-z0-9_-]+/, '/$1_…'));
    if (route === 'POST /dashboard/verify') {
      const reply = await this.registry.verifySiteFor(origin);
      if (reply.status === 200) return redirect(res, '/dashboard?welcome'), true;
      return send(res, 422, claimPage({ url: this.registry.url, site, fromDashboard: true, failure: explainClaim(origin, (reply.body as { tried?: { method: string; result: string }[] }).tried ?? []) })), true;
    }
    // Until the site has proved it holds its origin, the dashboard shows what's missing, and nothing else (except to the admin).
    if (!site.claim && !admin) return send(res, req.method === 'GET' && url.pathname === '/dashboard' ? 200 : 403, claimPage({ url: this.registry.url, site, fromDashboard: true })), true;
    const walk = this.options.walkthroughs;
    if (route === 'GET /dashboard') {
      const welcome = url.searchParams.has('welcome') ? html`<div class="card notice"><b>You're set up.</b> Agents that knock on your forms will show up here, with what they did, step by step.</div>` : '';
      const card = walk ? walkthroughCard({ origin, refusal: await walk.refusal(origin, `${origin}/`), last: await walk.get(origin) }) : '';
      return send(res, 200, await board.overview(origin, html`${welcome}${card}`)), true;
    }
    if (route === 'GET /dashboard/learning') return send(res, 200, teachingPage(await this.learning.counters(), await this.learning.correctionsFor(origin))), true;
    if (walk && url.pathname.startsWith('/dashboard/walkthrough')) {
      if (route === 'GET /dashboard/walkthrough/new') return send(res, 200, startForm(origin)), true;
      if (route === 'POST /dashboard/walkthrough') {
        const form = await readForm(req);
        const started = await walk.start({ origin, start: (form.get('start') ?? '').trim(), values: testValues(form.get('values') ?? ''), generated: form.get('generated') === '1', pressFinal: form.get('final') === '1', by: 'owner' });
        if ('refused' in started) return send(res, 422, startForm(origin, started.refused)), true;
        return redirect(res, '/dashboard/walkthrough'), true;
      }
      const resultPage = async (status: number, editError?: string) => {
        const run = await walk.get(origin);
        return send(res, status, walkthroughPage(run, { editable: true, ...(run && { events: `/dashboard/walkthrough/events?id=${run.id}` }), publishAction: '/dashboard/walkthrough/publish', edits: await walk.pendingEdits(origin), ...(editError && { editError }) }), { siteScript: true });
      };
      if (route === 'GET /dashboard/walkthrough') return await resultPage(200), true;
      // The chat editor: suggest from a sentence, then accept or discard.
      if (route === 'POST /dashboard/walkthrough/edit') {
        const proposed = await walk.proposeEdits(origin, (await readForm(req)).get('text') ?? '').catch((err: Error) => (err instanceof BudgetExceeded ? err.message : 'Muse Spark could not read that request just now; try again.'));
        if (typeof proposed === 'string') return await resultPage(422, proposed), true;
        return redirect(res, '/dashboard/walkthrough#edit'), true;
      }
      if (route === 'POST /dashboard/walkthrough/edit/apply') {
        const applied = await walk.applyEdits(origin, (await readForm(req)).get('id') ?? '');
        if (typeof applied === 'string') return await resultPage(409, applied), true;
        if (applied.failed.length) return await resultPage(422, `${applied.applied} change${applied.applied === 1 ? '' : 's'} made; not made: ${applied.failed.join('; ')}`), true;
        return redirect(res, '/dashboard/walkthrough'), true;
      }
      if (route === 'POST /dashboard/walkthrough/edit/discard') return await walk.discardEdits(origin), redirect(res, '/dashboard/walkthrough#edit'), true;
      if (route === 'GET /dashboard/walkthrough/events') return streamRun(req, res, walk, origin, url.searchParams.get('id') ?? ''), true;
      if (route === 'POST /dashboard/walkthrough/cancel') return walk.cancel(origin, (await readForm(req)).get('id') ?? ''), redirect(res, '/dashboard/walkthrough'), true;
      if (route === 'POST /dashboard/walkthrough/publish') return await walk.publish(origin), redirect(res, '/dashboard/walkthrough'), true;
      if (route === 'POST /dashboard/walkthrough/correct') {
        const form = await readForm(req);
        const failure = await walk.correct(origin, form.get('path') ?? '', form.get('id') ?? '', { ...(form.get('key') && { key: form.get('key')!.trim() }), ...(form.get('risk') && { risk: form.get('risk')! }), ...(form.get('label') && { label: form.get('label')!.trim() }) });
        if (failure) return send(res, 422, page('Map my site', html`<h1>That correction wasn't saved</h1><div class="card error">${failure}</div><p><a href="/dashboard/walkthrough">Back</a></p>`)), true;
        return redirect(res, `/dashboard/walkthrough#${encodeURIComponent(form.get('id') ?? '')}`), true;
      }
    }
    if (route === 'POST /dashboard/rules') {
      const text = (await readForm(req)).get('text') ?? '';
      const reply = await this.registry.proposeRulesFor(origin, text);
      const notice = reply.status === 201 ? html`<div class="card notice">Proposed. Check the policy below, then confirm it to apply.</div>` : html`<div class="card error">${(reply.body as { message?: string }).message ?? 'The rules could not be turned into a policy.'}</div>`;
      return send(res, reply.status === 201 ? 200 : 422, await board.overview(origin, notice)), true;
    }
    const confirm = /^\/dashboard\/rules\/(r_[A-Za-z0-9_-]+)\/confirm$/.exec(url.pathname);
    if (confirm && req.method === 'POST') {
      const reply = await this.registry.confirmRulesFor(origin, confirm[1]!);
      return send(res, reply.status, await board.overview(origin, reply.status === 200 ? html`<div class="card notice">Rules applied.</div>` : html`<div class="card error">That draft is no longer pending.</div>`)), true;
    }
    if (route === 'POST /dashboard/explain') {
      const failure = await this.hooks.explain?.(origin);
      return send(res, 200, await board.overview(origin, failure ? html`<div class="card error">${failure}</div>` : html`<div class="card notice">Explanations updated.</div>`)), true;
    }
    const session = /^\/dashboard\/sessions\/(s_[A-Za-z0-9_-]+)(\/explain)?$/.exec(url.pathname);
    if (session && (req.method === 'GET' || session[2])) {
      if (session[2] && req.method === 'POST') await this.registry.explainSession(origin, session[1]!, true).catch(() => null);
      const body = await board.sessionPage(origin, session[1]!);
      return send(res, body ? 200 : 404, body ?? page('Not found', html`<h1>No such session for ${origin}</h1>`)), true;
    }
    const map = /^\/dashboard\/maps\/(sha256(?::|%3A)[0-9a-f]{64})$/.exec(url.pathname);
    if (map && req.method === 'GET') {
      const record = await this.registry.storage.getMap(origin, decodeURIComponent(map[1]!));
      if (!record) return send(res, 404, page('Not found', html`<h1>No such map for ${origin}</h1>`)), true;
      return send(res, 200, mapPage(record.map, { source: record.submitted_by ? 'shared by an agent' : `built by ${record.map.provenance.compiler ?? 'Usher'}`, record, owner: true })), true;
    }
    return send(res, 404, page('Not found', html`<h1>Page not found</h1>`)), true;
  }
}
