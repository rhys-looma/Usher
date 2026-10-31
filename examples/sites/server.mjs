// A gaggle of fictional businesses that would want their own assistant app: a mortgage lender, an
// energy supplier, a council, a vet, a removals firm and a restaurant (sites.mjs). Each one is its
// own origin, so it can join Usher, be mapped and publish an app like a real site. None of them is
// a real business. Needs Node 20+. Each looks and is built differently: four are server pages, and
// Kestrel (React) and Hollyhock (Vue) are apps drawn in the browser from apps/, which `npm run build`
// bundles into public/.
//
// Locally, each site gets its own port:
//
//   node server.mjs                     every site, on ports 4301 to 4306
//   SITES=larchmont node server.mjs     only the sites named (comma-separated)
//   PORT_BASE=5300 node server.mjs      another range of ports
//
// In public, one port serves every site by host name, <site>.<SITE_DOMAIN>:
//
//   SITE_DOMAIN=registry.example PORT=4300 USHER_REGISTRY_URL=https://… USHER_ADMIN_KEY=… node server.mjs
//
// Each site's owner turns Usher on at /__settings with the site key the registry issued. That adds
// the script tag, the claim file at /.well-known/usher-site.json, /.well-known/usher.json and the
// server-side token check on each journey's final step. Locally, settings open from this machine
// only, can name any registry, and are kept in .settings.json (gitignored). In public, they need
// USHER_ADMIN_KEY, the registry is USHER_REGISTRY_URL and nothing else, and they last until the
// next deploy. USHER_SITE_KEY_LARCHMONT=usp_… (one per site) sets a key up front.
//
// The token check needs the middleware built: `npm run build` at the repository root.
//
// Open to anyone, so: nothing to upload and no passwords; a site's host names only; small request
// bodies; rate limits per client; sessions that expire; strict security headers; no stack traces.

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { sites } from './sites.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DOMAIN = process.env.SITE_DOMAIN?.toLowerCase();
const PUBLIC = Boolean(DOMAIN);
const PORT_BASE = Number(process.env.PORT_BASE ?? 4301);
const REGISTRY = process.env.USHER_REGISTRY_URL?.replace(/\/$/, '') ?? '';
const ADMIN_KEY = process.env.USHER_ADMIN_KEY ?? '';
// In public: CloudFront, then the load balancer (packages/registry/src/forwarded.ts).
const HOPS = Number(process.env.TRUSTED_PROXY_HOPS ?? (PUBLIC ? 2 : 0));
const MAX_SESSIONS = 2000;
const SESSION_MS = 60 * 60_000;
const MAX_BODY = 16 * 1024;
// SITES_SETTINGS names another settings file (tests keep theirs apart from the owner's).
const SETTINGS_FILE = process.env.SITES_SETTINGS ?? join(here, '.settings.json');
const MIDDLEWARE = join(here, '../../packages/site-middleware/dist/index.js');
// site id -> { registry, siteKey }; a file locally, memory only in public
const saved = !PUBLIC && existsSync(SETTINGS_FILE) ? JSON.parse(await readFile(SETTINGS_FILE, 'utf8')) : {};
const middleware = existsSync(MIDDLEWARE) ? await import(MIDDLEWARE) : null;
if (PUBLIC && (!REGISTRY.startsWith('https://') || ADMIN_KEY.length < 16)) throw new Error('In public (SITE_DOMAIN) the sites need USHER_REGISTRY_URL on https and USHER_ADMIN_KEY.');

const wanted = process.env.SITES ? process.env.SITES.split(',').map((s) => s.trim()) : Object.keys(sites);
for (const id of wanted) if (!sites[id]) throw new Error(`No site called ${id}. The sites are: ${Object.keys(sites).join(', ')}`);

const limits = new Limits();
if (PUBLIC) {
  // host name -> handler
  const byHost = new Map(wanted.map((id) => [`${id}.${DOMAIN}`, handler(id, sites[id])]));
  const port = Number(process.env.PORT ?? 4300);
  createServer((req, res) => {
    const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (req.url === '/healthz') return json(res, { ok: true, sites: wanted.length });
    const handle = byHost.get(host);
    if (!handle) return plain(res, 421, 'Unknown site.');
    handle(req, res);
  }).listen(port, process.env.HOST ?? '::', () => console.log(`${wanted.length} demo sites on port ${port}, at <site>.${DOMAIN}`));
} else {
  Object.keys(sites).forEach((id, i) => {
    if (!wanted.includes(id)) return;
    const port = PORT_BASE + i;
    createServer(handler(id, sites[id])).listen(port, process.env.HOST ?? '::', () => console.log(`${sites[id].name} (demo) on port ${port}`));
  });
}

/** One site's request handler. */
function handler(id, site) {
  const originOf = (req) => (PUBLIC ? `https://${id}.${DOMAIN}` : `http://${req.headers.host}`);
  const usher = {
    registry: saved[id]?.registry ?? REGISTRY,
    siteKey: saved[id]?.siteKey ?? process.env[`USHER_SITE_KEY_${id.toUpperCase()}`] ?? '',
    checks: {},
  };
  // The token check for each journey's intent, rebuilt when the settings change.
  const arm = () => {
    usher.checks = Object.fromEntries(
      Object.entries(site.journeys).map(([key, j]) => [
        key,
        (usher.registry &&
          middleware?.createUsherCheck({
            registry: usher.registry,
            ...(process.env.USHER_REGISTRY_INTERNAL_URL && { internalUrl: process.env.USHER_REGISTRY_INTERNAL_URL }),
            intent: j.intent,
            origin: originOf,
            ...(usher.siteKey && { siteKey: usher.siteKey }),
            // A local demo: agents' key directories may be served over http. Never in public.
            allowHttpDirectories: !PUBLIC,
          })) ||
          null,
      ]),
    );
  };
  arm();
  // session id -> { seen, [journey]: { [step]: values, result } }; the oldest go past MAX_SESSIONS
  const sessions = new Map();
  const view = render(id, site, usher);

  return async (req, res) => {
    try {
      headers(res, usher.registry);
      const client = clientAddress(req);
      if (!limits.allow(`all:${client}`, 240) || (req.method === 'POST' && !limits.allow(`post:${client}`, 40))) return plain(res, 429, 'Too many requests. Try again in a minute.');
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') return plain(res, 405, 'Method not allowed.');
      const url = new URL(req.url, 'http://site');
      const [, section, key, extra] = url.pathname.split('/');
      const { registry, siteKey } = usher;
      if (url.pathname === '/healthz') return json(res, { ok: true, site: id, usher: Boolean(registry) });
      if (section === 'static' && req.method === 'GET') return serveStatic(res, key);
      if (url.pathname === '/.well-known/usher-site.json' && siteKey) return json(res, { usher_site: '0.1', site_key: siteKey });
      if (url.pathname === '/.well-known/usher.json' && registry) {
        // Each journey's intent, the one its token check below wants, so mappers use it too.
        const declared = Object.entries(site.journeys).map(([key, j]) => ({ start: `/${key}/${Object.keys(j.steps)[0]}`, intent: j.intent }));
        return json(res, { usher: '0.1', registry, knock_url: `${registry}/knock`, keys_url: `${registry}/.well-known/usher-keys.json`, journeys: declared });
      }

      // The owner's settings, as if behind the site's own admin login: locally from this machine
      // only; in public with the admin key, a few tries an hour.
      if (section === '__settings') {
        res.setHeader('Cache-Control', 'no-store');
        if (!PUBLIC && !/^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress ?? '')) return html(res, view.page('Not allowed', '<h1>Settings are only open from this machine</h1>'), 403);
        if (req.method === 'POST') {
          if (PUBLIC && (!limits.allow(`settings:${client}`, 10, 3_600_000) || !limits.allow('settings', 60, 3_600_000))) return plain(res, 429, 'Too many tries. Try again later.');
          const form = new URLSearchParams(await body(req));
          if (PUBLIC && !sameKey(form.get('admin_key') ?? '', ADMIN_KEY)) return html(res, view.settings(middleware, 'That admin key is not right.'), 401);
          const reg = PUBLIC ? REGISTRY : (form.get('registry') ?? '').trim().replace(/\/$/, '');
          const key = (form.get('site_key') ?? '').trim();
          if ((reg && !/^https?:\/\/[^\s"'<>]+$/.test(reg)) || (key && !/^usp_[\w-]{1,64}$/.test(key))) return html(res, view.settings(middleware, 'That address or key does not look right.'), 422);
          Object.assign(usher, { registry: reg, siteKey: key });
          arm();
          saved[id] = { registry: reg, siteKey: key };
          if (!PUBLIC) await writeFile(SETTINGS_FILE, `${JSON.stringify(saved, null, 2)}\n`);
          console.log(`${id}: settings saved (site key ${key ? 'set' : 'cleared'})`);
          return redirect(res, '/__settings?saved');
        }
        return html(res, view.settings(middleware, '', url.searchParams.has('saved')));
      }

      const session = getSession(sessions, req, res);
      if (req.method === 'GET' && url.pathname === '/') return html(res, view.home());

      const journey = Object.hasOwn(site.journeys, section) ? site.journeys[section] : undefined;
      if (!journey) return html(res, view.page('Not found', '<h1>Page not found</h1><p><a href="/">Home</a></p>'), 404);
      const state = (session[section] ??= {});
      const order = Object.keys(journey.steps);
      // The React and Vue sites post each step with fetch and draw the answer themselves.
      const app = Boolean(site.app) && String(req.headers.accept ?? '').includes('application/json');
      const go = (to) => (app ? json(res, { go: to }) : redirect(res, to));

      if (key === 'result' && req.method === 'GET') return state.result ? html(res, view.result(section, journey, state.result)) : redirect(res, `/${section}/${order[0]}`);
      if (key === 'result' && extra === 'next' && state.result?.next) {
        if (req.method === 'GET') return html(res, view.next(section, state.result));
        if (req.method === 'POST') return app ? json(res, { wall: state.result.next.wall }) : html(res, view.wall(state.result));
      }
      if (!key) return redirect(res, `/${section}/${order[0]}`);

      const step = Object.hasOwn(journey.steps, key) ? journey.steps[key] : undefined;
      if (!step) return html(res, view.page('Not found', '<h1>Page not found</h1><p><a href="/">Home</a></p>'), 404);
      if (url.searchParams.has('restart')) for (const k of Object.keys(state)) delete state[k];
      // Each step needs the ones before it done first.
      const missing = order.slice(0, order.indexOf(key)).find((k) => !state[k]);
      if (missing) return redirect(res, `/${section}/${missing}`);
      const final = order.indexOf(key) === order.length - 1;

      if (req.method !== 'POST') return html(res, view.step(section, journey, key, state[key] ?? {}));
      const raw = await body(req);
      const params = new URLSearchParams(raw);
      // The final step is consequential: an agent needs a token from a knock.
      const usherCheck = final && usher.checks[section];
      if (usherCheck) {
        const check = await usherCheck.check(req, { form: params, action: 'form.submit', body: new TextEncoder().encode(raw) });
        if (check.status === 'knock_required') return usherCheck.reject(req, res, check, 'form.submit');
      }
      const values = read(step, params);
      const errors = validate(step, values);
      if (errors.length) return app ? json(res, { errors: errors.map((f) => f.name) }, 422) : html(res, view.step(section, journey, key, values, errors), 422);
      state[key] = values;
      if (!final) return go(`/${section}/${order[order.indexOf(key) + 1]}`);
      const labels = Object.fromEntries(order.map((k) => [k, Object.fromEntries(journey.steps[k].fields.map((f) => [f.name, f.options?.find((o) => o.value === state[k][f.name])?.label ?? state[k][f.name]]))]));
      state.result = journey.result(state, labels);
      // The answers aren't needed once there's a result; only the result is kept, for the result page.
      for (const k of order) state[k] = {};
      return app ? json(res, { go: `/${section}/result`, result: state.result }) : redirect(res, `/${section}/result`);
    } catch (err) {
      if (err instanceof TooLarge) return plain(res, 413, 'That request is too large.');
      console.error(`${id}: ${err?.message ?? 'error'}`);
      if (!res.headersSent) plain(res, 500, 'Something went wrong.');
    }
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(id, site, usher) {
  const look = site.look;
  const journeys = Object.entries(site.journeys);
  const first = (j) => Object.keys(j.steps)[0];
  const start = ([key, j]) => `/${key}/${first(j)}?restart`;
  const phone = site.contact?.phone ? `<a href="tel:${site.contact.phone.replaceAll(' ', '')}">${esc(site.contact.phone)}</a>` : '';
  const bundle = site.app ? join(here, 'public', `${id}.app.js`) : '';

  const head = (title) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | ${esc(site.name)}</title>
<meta property="og:site_name" content="${esc(site.name)}">
<link rel="stylesheet" href="/static/site.css">
<link rel="stylesheet" href="/static/${look}.css">
<style>:root { --brand: ${site.colour}; }</style>
${site.app ? `<script src="/static/${id}.app.js" defer></script>\n` : ''}${usher.registry ? `<script src="${esc(usher.registry)}/usher.js" data-usher-registry="${esc(usher.registry)}"${usher.siteKey ? ` data-usher-site-key="${esc(usher.siteKey)}"` : ''} defer></script>\n` : ''}</head>`;
  const banner = `<div class="demo-banner">Demo site for the Usher project. ${esc(site.name)} is not a real business.</div>`;

  // Each look is its own site furniture around the same journeys.
  const shells = {
    bank: {
      header: () => `<div class="utility"><div class="wrap"><span class="segment current">Personal</span><span class="segment">For brokers</span><span class="call">Call us on ${phone}</span></div></div>
<header class="masthead"><div class="wrap"><a href="/" class="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3 3 12h26z" fill="currentColor"/><rect x="6" y="14" width="3" height="11" fill="currentColor"/><rect x="14.5" y="14" width="3" height="11" fill="currentColor"/><rect x="23" y="14" width="3" height="11" fill="currentColor"/><rect x="3" y="26" width="26" height="3" fill="currentColor"/></svg><span>${esc(site.short)}<small>${esc(site.tagline)}</small></span></a>
<nav aria-label="Main"><ul>${journeys.map((e) => `<li><a href="${start(e)}">${esc(e[1].title)}</a></li>`).join('')}</ul></nav></div></header>`,
      footer: () => `<footer class="site-footer"><div class="wrap cols">
<div><h2>Mortgages</h2><ul>${journeys.map((e) => `<li><a href="${start(e)}">${esc(e[1].title)}</a></li>`).join('')}</ul></div>
<div><h2>Talk to us</h2><p>${phone}<br>${esc(site.contact.hours)}</p></div>
<div><h2>About ${esc(site.short)}</h2><p>${esc(site.footer)}</p></div>
</div></footer>`,
    },
    civic: {
      header: (crumb) => `<header class="masthead"><div class="wrap"><a href="/" class="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2c6 5 9 10 9 15a9 9 0 0 1-18 0c0-5 3-10 9-15z" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M16 9v21" stroke="currentColor" stroke-width="2.5"/></svg>${esc(site.name.replace(/ Council$/, ''))}<span>Council</span></a></div></header>
<div class="service"><div class="wrap">${esc(crumb?.title ?? site.heading)}</div></div>
<div class="wrap"><nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li>${crumb ? `<li><a href="${start([crumb.key, crumb])}">${esc(crumb.title)}</a></li>` : ''}</ol></nav></div>`,
      footer: () => `<footer class="site-footer"><div class="wrap"><h2 class="visually-hidden">Support links</h2><ul class="links"><li>Contact us: ${phone}</li><li>${esc(site.contact.hours)}</li></ul><p>${esc(site.footer)}</p></div></footer>`,
    },
    bold: {
      header: () => `<header class="masthead"><div class="wrap"><a href="/" class="brand"><svg viewBox="0 0 40 28" aria-hidden="true"><path d="M2 4h22v16H2zM24 9h8l6 6v5H24z" fill="currentColor"/><circle cx="9" cy="22" r="4" fill="#111"/><circle cx="9" cy="22" r="2" fill="currentColor"/><circle cx="31" cy="22" r="4" fill="#111"/><circle cx="31" cy="22" r="2" fill="currentColor"/></svg>${esc(site.short.toUpperCase())}<small>${esc(site.tagline)}</small></a><a class="cta" href="tel:${site.contact.phone.replaceAll(' ', '')}">Call ${esc(site.contact.phone)}</a></div></header>`,
      footer: () => `<footer class="site-footer"><div class="wrap"><p><strong>${esc(site.name)}</strong> · ${esc(site.contact.hours)} · ${phone}</p><p>${esc(site.footer)}</p></div></footer>`,
    },
    boutique: {
      header: () => `<header class="masthead"><a href="/" class="brand">${esc(site.short)}</a><p class="tag">${esc(site.tagline)}</p>
<nav aria-label="Main"><ul><li><a href="/#menu">Menu</a></li>${journeys.map((e) => `<li><a href="${start(e)}">${esc(e[1].title)}</a></li>`).join('')}<li><a href="/#find-us">Find us</a></li></ul></nav></header>`,
      footer: () => `<footer class="site-footer"><p>${esc(site.contact.address)}</p><p>${phone}</p><p class="fine">${esc(site.footer)}</p></footer>`,
    },
  };

  const page = (title, main, { crumb, aside = '', wide = false } = {}) => {
    const shell = shells[look] ?? { header: () => '', footer: () => '' };
    return `${head(title)}
<body class="look-${look}">
${banner}
${shell.header(crumb)}
<div class="page${aside ? ' with-aside' : ''}${wide ? ' wide' : ''}"><main id="main">${main}</main>${aside}</div>
${shell.footer()}
<script src="/static/site.js" defer></script>
</body>
</html>`;
  };

  // The React and Vue sites: the page is an empty shell and the app draws it from this data.
  const app = (title, route) => {
    const data = {
      site: { name: site.name, short: site.short, tagline: site.tagline, heading: site.heading, blurb: site.blurb, footer: site.footer, contact: site.contact, rating: site.rating, practices: site.practices },
      journeys: Object.fromEntries(journeys.map(([key, j]) => [key, { title: j.title, summary: j.summary, action: j.action, disclosure: j.disclosure, steps: j.steps }])),
      route,
    };
    // Not executed (a data block), so the CSP allows it; < is escaped so it can't close the tag.
    return `${head(title)}
<body class="look-${look}">
${banner}
<script type="application/json" id="site-data">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script>
<div id="app">${existsSync(bundle) ? '' : '<p style="padding:24px">This site is an app: run <code>npm run build</code> at the repository root, then restart.</p>'}</div>
</body>
</html>`;
  };

  const progress = (journey, order, index) => {
    if (order.length === 1) return `<p class="caption">${esc(journey.title)}</p>`;
    if (look === 'bank' || look === 'bold')
      return `<ol class="stepper" aria-label="${esc(journey.title)}: step ${index + 1} of ${order.length}">${order
        .map((k, i) => `<li class="${i < index ? 'done' : i === index ? 'current' : ''}"${i === index ? ' aria-current="step"' : ''}><span>${i + 1}</span>${esc(journey.steps[k].title)}</li>`)
        .join('')}</ol>`;
    if (look === 'civic') return `<p class="caption">${esc(journey.title)} <span>Section ${index + 1} of ${order.length}</span></p>`;
    return `<p class="caption">${esc(journey.title)} · ${index + 1} of ${order.length}</p>`;
  };

  const sidePanel = () => {
    if (look === 'bank') return `<aside class="side"><div class="panel"><h2>${esc(site.aside.title)}</h2><ul class="ticks">${site.aside.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div><div class="panel"><h2>Prefer to talk?</h2><p>Call ${phone}<br>${esc(site.contact.hours)}</p></div></aside>`;
    if (look === 'bold') return `<aside class="side"><div class="panel"><h2>${esc(site.aside.title)}</h2><ul class="ticks">${site.aside.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div><blockquote class="review"><p>“${esc(site.review.quote)}”</p><footer>${esc(site.review.name)}</footer></blockquote></aside>`;
    return '';
  };

  const homes = {
    bank: () =>
      page(
        site.tagline,
        `<section class="hero"><div class="wrap"><h1>${esc(site.heading)}</h1><p class="lede">${esc(site.blurb)}</p><p class="ctas">${journeys.map((e, i) => `<a class="button${i ? ' secondary' : ''}" href="${start(e)}">${esc(e[1].title)}</a>`).join('')}</p></div></section>
<section class="wrap features">${site.aside.points.map((p) => `<div class="feature"><h2>${esc(p)}</h2></div>`).join('')}</section>
<section class="wrap ways"><h2>Ways we can help</h2><ul class="journeys">${journeys.map((e) => `<li><a href="${start(e)}"><strong>${esc(e[1].title)}</strong><span>${esc(e[1].summary)}</span></a></li>`).join('')}</ul></section>
<section class="wrap"><p class="notice">${esc(site.notice)}</p></section>`,
        { wide: true },
      ),
    civic: () =>
      page(
        site.heading,
        `<h1>${esc(site.heading)}</h1><p class="lede">${esc(site.blurb)}</p>
<h2>Most popular</h2><ul class="services">${journeys.map((e) => `<li><a href="${start(e)}">${esc(e[1].title)}</a><p>${esc(e[1].summary)}</p></li>`).join('')}</ul>`,
      ),
    bold: () =>
      page(
        site.tagline,
        `<section class="hero"><div class="wrap"><h1>${esc(site.heading)}</h1><p class="lede">${esc(site.blurb)}</p>${journeys.map((e) => `<a class="button" href="${start(e)}">${esc(e[1].title)}</a>`).join(' ')}</div></section>
<section class="wrap promise"><h2>${esc(site.aside.title)}</h2><ul class="ticks">${site.aside.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul><blockquote class="review"><p>“${esc(site.review.quote)}”</p><footer>${esc(site.review.name)}</footer></blockquote></section>`,
        { wide: true },
      ),
    boutique: () =>
      page(
        site.tagline,
        `<section class="hero"><h1>${esc(site.heading)}</h1><p class="lede">${esc(site.blurb)}</p>${journeys.map((e) => `<a class="button" href="${start(e)}">${esc(e[1].title)}</a>`).join(' ')}</section>
<section id="menu" class="menu"><h2>From tonight’s menu</h2><dl>${site.menu.map(([dish, price]) => `<div><dt>${esc(dish)}</dt><dd>${esc(price)}</dd></div>`).join('')}</dl></section>
<section id="find-us" class="find-us"><h2>Find us</h2><p>${esc(site.contact.address)}</p><ul>${site.contact.hours.map((h) => `<li>${esc(h)}</li>`).join('')}</ul></section>`,
      ),
  };

  const home = () => (site.app ? app(site.tagline, { view: 'home' }) : homes[look]());

  const step = (base, journey, key, values, errors = []) => {
    const order = Object.keys(journey.steps);
    const index = order.indexOf(key);
    if (site.app) return app(journey.steps[key].title, { view: 'step', journey: base, step: key, values });
    const s = journey.steps[key];
    const final = index === order.length - 1;
    const summary = errors.length
      ? `<div class="error-summary" role="alert"><h2>${look === 'civic' ? 'There is a problem' : 'Please check the following'}</h2><ul>${errors.map((f) => `<li><a href="#f-${f.name}">${esc(f.label)}</a></li>`).join('')}</ul></div>`
      : '';
    return page(
      s.title,
      `${progress(journey, order, index)}
<h1>${esc(s.title)}</h1>
${summary}
<form method="post" action="/${base}/${key}" novalidate>
${s.fields.map((f) => field(f, values[f.name], errors.some((e) => e.name === f.name))).join('\n')}
${final && journey.disclosure ? `<p class="disclosure">${esc(journey.disclosure)}</p>` : ''}
<div class="actions">${index > 0 ? `<a class="back" href="/${base}/${order[index - 1]}">Back</a>` : ''}<button type="submit" class="primary">${esc(final ? journey.action : look === 'boutique' ? 'Next' : 'Continue')}</button></div>
</form>`,
      { crumb: { key: base, ...journey }, aside: sidePanel() },
    );
  };

  const result = (base, journey, r) =>
    site.app
      ? app(journey.title, { view: 'result', journey: base, result: r })
      : page(
          journey.title,
          `<h1>${esc(journey.title)}</h1>
<div class="result">
  <p class="headline">${esc(r.headline)}${r.headlineNote ? ` <span>${esc(r.headlineNote)}</span>` : ''}</p>
  ${r.lines.map((l) => `<p>${esc(l)}</p>`).join('')}
  <p class="ref">Reference <strong>${esc(r.reference)}</strong></p>
</div>
${r.next ? `<p><a class="button" href="/${base}/result/next">${esc(r.next.label)}</a></p>` : ''}
<p class="note">A demo: nothing here is real, and nothing has been bought or booked.</p>
<p><a href="/">Back to ${esc(site.short)}</a></p>`,
          { crumb: { key: base, ...journey }, aside: sidePanel() },
        );

  const next = (base, r) =>
    site.app
      ? app(r.next.label, { view: 'next', journey: base, result: r })
      : page(
          r.next.label,
          `<h1>${esc(r.next.label)}</h1>
<p>Reference <strong>${esc(r.reference)}</strong>: ${esc(r.headline)}${r.headlineNote ? ` ${esc(r.headlineNote)}` : ''}.</p>
<form method="post" action="/${base}/result/next"><div class="actions"><a class="back" href="/${base}/result">Back</a><button type="submit" class="primary">${esc(r.next.action)}</button></div></form>`,
        );

  const wall = (r) => page('Demo', `<h1>${esc(r.next.label)}</h1><p>${esc(r.next.wall)}</p><p><a href="/">Back to ${esc(site.short)}</a></p>`);

  const settings = (middleware, error = '', saved = false) =>
    page(
      'Settings',
      `<h1>Settings: Usher</h1>
<p class="lede">What ${esc(site.name)}'s owner would set in their site's admin. Get a site key at <code>/sites/new</code> on the registry, with this site's address.</p>
${saved ? '<p class="saved" role="status">Saved.</p>' : ''}${error ? `<div class="error-summary" role="alert"><h2>${esc(error)}</h2></div>` : ''}
<form method="post" action="/__settings">
${PUBLIC ? `<p>Registry: <code>${esc(REGISTRY)}</code></p>
<div class="row"><label for="admin_key">Admin key</label><input type="password" id="admin_key" name="admin_key" autocomplete="off" required></div>` : `<div class="row"><label for="registry">Registry address</label><input type="url" id="registry" name="registry" value="${esc(usher.registry)}" placeholder="https://registry.example"></div>`}
<div class="row"><label for="site_key">Site key</label><input type="text" id="site_key" name="site_key" value="${esc(usher.siteKey)}" placeholder="usp_…"></div>
<div class="actions"><button type="submit" class="primary">Save</button></div>
</form>
<ul class="status">
<li>Script tag: ${usher.registry ? 'on every page' : 'off'}</li>
<li>Claim file at <code>/.well-known/usher-site.json</code>: ${usher.siteKey ? 'served' : 'off'}</li>
<li>Token check on each journey's final step: ${usher.registry ? (middleware ? 'on' : 'off: run <code>npm run build</code> at the repository root, then restart') : 'off'}</li>
</ul>`,
    );

  return { page, home, step, result, next, wall, settings };
}

function field(f, value = '', hasError) {
  const id = `f-${f.name}`;
  const req = f.required ? ' required' : '';
  const showIf = f.showIf ? ` data-show-if="${f.showIf[0]}=${f.showIf[1]}" hidden` : '';
  const cls = `row${hasError ? ' has-error' : ''}`;
  const err = hasError ? `<p class="error-message">${f.type === 'checkbox' ? 'Please confirm to continue' : 'Please complete this field'}</p>` : '';
  const label = esc(f.label);
  switch (f.type) {
    case 'select':
      return `<div class="${cls}"${showIf}><label for="${id}">${label}</label>${err}<select id="${id}" name="${f.name}"${req}><option value="">Please select</option>${f.options
        .map((o) => `<option value="${esc(o.value)}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`)
        .join('')}</select></div>`;
    case 'radio':
      return `<fieldset class="${cls}" id="${id}"${showIf}><legend>${label}</legend>${err}<div class="choices${f.card ? ' cards' : ''}">${f.options
        .map(
          (o, i) =>
            `<label class="choice${f.card ? ' card' : ''}"><input type="radio" name="${f.name}" value="${esc(o.value)}" id="${id}-${i}"${o.value === value ? ' checked' : ''}${i === 0 ? req : ''}> ${esc(o.label)}</label>`,
        )
        .join('')}</div></fieldset>`;
    case 'checkbox':
      return `<div class="${cls} check"${showIf}>${err}<label class="choice"><input type="checkbox" id="${id}" name="${f.name}" value="yes"${value === 'yes' ? ' checked' : ''}${req}> ${label}</label></div>`;
    case 'textarea':
      return `<div class="${cls}"${showIf}><label for="${id}">${label}</label>${err}<textarea id="${id}" name="${f.name}" rows="4"${req}>${esc(value)}</textarea></div>`;
    default: {
      const attrs = [f.pattern && `pattern="${esc(f.pattern)}"`, f.min !== undefined && `min="${f.min}"`, f.max !== undefined && `max="${f.max}"`, f.autocomplete && `autocomplete="${f.autocomplete}"`]
        .filter(Boolean)
        .join(' ');
      return `<div class="${cls}"${showIf}><label for="${id}">${label}</label>${err}<input type="${f.type}" id="${id}" name="${f.name}" value="${esc(value)}" ${attrs}${req}></div>`;
    }
  }
}

// ---------------------------------------------------------------------------
// Reading and checking a step
// ---------------------------------------------------------------------------

/** Whether a field is shown, given the step's answers: a field shown only for another answer isn't asked. */
const shown = (f, values) => !f.showIf || values[f.showIf[0]] === f.showIf[1];

function read(step, params) {
  const values = {};
  for (const f of step.fields) if (params.has(f.name)) values[f.name] = (params.get(f.name) ?? '').trim();
  return values;
}

function validate(step, values) {
  return step.fields.filter((f) => {
    if (!shown(f, values)) return false;
    const v = values[f.name] ?? '';
    if (!v) return f.required;
    if (f.options && !f.options.some((o) => o.value === v)) return true;
    if (f.type === 'number' && (!Number.isFinite(Number(v)) || (f.min !== undefined && Number(v) < f.min) || (f.max !== undefined && Number(v) > f.max))) return true;
    if (f.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return true;
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return true;
    if (f.pattern && !new RegExp(`^(?:${f.pattern})$`).test(v)) return true;
    return false;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The visitor's session, in memory: gone after an hour without a visit, or when MAX_SESSIONS newer ones come. */
function getSession(sessions, req, res) {
  const now = Date.now();
  const sid = /(?:^|;\s*)demo_sid=([0-9a-f-]{36})/.exec(req.headers.cookie ?? '')?.[1];
  const found = sid && sessions.get(sid);
  if (found && now - found.seen < SESSION_MS) {
    found.seen = now;
    return found.data;
  }
  if (sid) sessions.delete(sid);
  for (const [k, v] of sessions) if (sessions.size >= MAX_SESSIONS || now - v.seen >= SESSION_MS) sessions.delete(k); else break;
  const id = randomUUID();
  const session = { seen: now, data: {} };
  sessions.set(id, session);
  res.setHeader('Set-Cookie', `demo_sid=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${PUBLIC ? '; Secure' : ''}`);
  return session.data;
}

/** Security headers on every response. The page loads only its own files and the registry's script. */
function headers(res, registry) {
  const usher = registry ? ` ${registry}` : '';
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'${usher}; connect-src 'self'${usher}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (PUBLIC) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

/** The client's address for rate limits, in memory only: the entry the outermost trusted proxy wrote. */
function clientAddress(req) {
  if (HOPS > 0) {
    const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((a) => a.trim()).filter(Boolean);
    if (chain.length) return chain[Math.max(0, chain.length - HOPS)];
  }
  return req.socket.remoteAddress || 'unknown';
}

/** Fixed-window counters: at most `max` per key per window. Old windows are dropped as they pass. */
function Limits() {
  const counts = new Map();
  this.allow = (key, max, windowMs = 60_000) => {
    const now = Date.now();
    if (counts.size > 50_000) for (const [k, v] of counts) if (v.until <= now) counts.delete(k);
    const entry = counts.get(key);
    if (!entry || entry.until <= now) {
      counts.set(key, { n: 1, until: now + windowMs });
      return true;
    }
    entry.n++;
    return entry.n <= max;
  };
}

class TooLarge extends Error {}

function sameKey(given, expected) {
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());
}

async function serveStatic(res, file) {
  const types = { '.css': 'text/css', '.js': 'text/javascript' };
  if (!file || !/^[\w.-]+$/.test(file) || !types[extname(file)]) return html(res, '<h1>Not found</h1>', 404);
  try {
    const content = await readFile(join(here, 'public', file));
    res.writeHead(200, { 'Content-Type': `${types[extname(file)]}; charset=utf-8` });
    res.end(content);
  } catch {
    html(res, '<h1>Not found</h1>', 404);
  }
}

function body(req) {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return Promise.reject(new TooLarge());
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) {
        reject(new TooLarge());
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function plain(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function html(res, content, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(content);
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function esc(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
