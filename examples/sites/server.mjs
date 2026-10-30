// A gaggle of fictional businesses that would want their own assistant app: a mortgage lender, an
// energy supplier, a council, a vet, a removals firm and a restaurant (sites.mjs). Each one runs on
// its own port, so each is its own origin: it can join Usher, be mapped and publish an app like a
// real site. None of them is a real business. No dependencies; needs Node 20+.
//
//   node server.mjs                     every site, on ports 4301 to 4306
//   SITES=larchmont node server.mjs     only the sites named (comma-separated)
//   PORT_BASE=5300 node server.mjs      another range of ports
//
// Each site's owner turns Usher on at /__settings (from this machine only): the registry's address
// and the site key it issued. That adds the script tag, the claim file at
// /.well-known/usher-site.json, /.well-known/usher.json and the server-side token check on each
// journey's final step. Settings are kept in .settings.json (gitignored). Or set them up front:
//
//   USHER_REGISTRY_URL=<registry URL>   the registry, for every site
//   USHER_SITE_KEY_LARCHMONT=usp_…      one site's key; one variable per site
//
// The token check needs the middleware built: `npm run build` at the repository root.

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { sites } from './sites.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT_BASE = Number(process.env.PORT_BASE ?? 4301);
const MAX_SESSIONS = 2000;
const SETTINGS_FILE = join(here, '.settings.json');
const MIDDLEWARE = join(here, '../../packages/site-middleware/dist/index.js');
// site id -> { registry, siteKey }
const saved = existsSync(SETTINGS_FILE) ? JSON.parse(await readFile(SETTINGS_FILE, 'utf8')) : {};
const middleware = existsSync(MIDDLEWARE) ? await import(MIDDLEWARE) : null;

const wanted = process.env.SITES ? process.env.SITES.split(',').map((s) => s.trim()) : Object.keys(sites);
for (const id of wanted) if (!sites[id]) throw new Error(`No site called ${id}. The sites are: ${Object.keys(sites).join(', ')}`);

Object.keys(sites).forEach((id, i) => {
  if (wanted.includes(id)) serve(id, sites[id], PORT_BASE + i);
});

function serve(id, site, port) {
  const usher = {
    registry: saved[id]?.registry ?? process.env.USHER_REGISTRY_URL?.replace(/\/$/, '') ?? '',
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
            intent: j.intent,
            origin: (req) => `http://${req.headers.host}`,
            ...(usher.siteKey && { siteKey: usher.siteKey }),
            allowHttpDirectories: true,
          })) ||
          null,
      ]),
    );
  };
  arm();
  // session id -> { [journey]: { [step]: values, result } }; the oldest go past MAX_SESSIONS
  const sessions = new Map();
  const view = render(site, usher);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const [, section, key, extra] = url.pathname.split('/');
      const { registry, siteKey } = usher;
      if (url.pathname === '/healthz') return json(res, { ok: true, site: id, usher: Boolean(registry) });
      if (section === 'static' && req.method === 'GET') return serveStatic(res, key);
      if (url.pathname === '/.well-known/usher-site.json' && siteKey) return json(res, { usher_site: '0.1', site_key: siteKey });
      if (url.pathname === '/.well-known/usher.json' && registry) return json(res, { usher: '0.1', registry, knock_url: `${registry}/knock`, keys_url: `${registry}/.well-known/usher-keys.json` });

      // The owner's settings: only from this machine, as if behind the site's own admin login.
      if (section === '__settings') {
        if (!/^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress ?? '')) return html(res, view.page('Not allowed', '<h1>Settings are only open from this machine</h1>'), 403);
        if (req.method === 'POST') {
          const form = new URLSearchParams(await body(req));
          const reg = (form.get('registry') ?? '').trim().replace(/\/$/, '');
          const key = (form.get('site_key') ?? '').trim();
          if ((reg && !/^https?:\/\/[^\s"<>]+$/.test(reg)) || (key && !/^usp_[\w-]{1,64}$/.test(key))) return html(res, view.settings(middleware, 'That address or key does not look right.'), 422);
          Object.assign(usher, { registry: reg, siteKey: key });
          arm();
          saved[id] = { registry: reg, siteKey: key };
          await writeFile(SETTINGS_FILE, `${JSON.stringify(saved, null, 2)}\n`);
          return redirect(res, '/__settings?saved');
        }
        return html(res, view.settings(middleware, '', url.searchParams.has('saved')));
      }

      const session = getSession(sessions, req, res);
      if (req.method === 'GET' && url.pathname === '/') return html(res, view.home());

      const journey = site.journeys[section];
      if (!journey) return html(res, view.page('Not found', '<h1>Page not found</h1><p><a href="/">Home</a></p>'), 404);
      const state = (session[section] ??= {});
      const order = Object.keys(journey.steps);

      if (key === 'result' && req.method === 'GET') return state.result ? html(res, view.result(section, journey, state.result)) : redirect(res, `/${section}/${order[0]}`);
      if (key === 'result' && extra === 'next' && state.result?.next) {
        if (req.method === 'GET') return html(res, view.next(section, state.result));
        if (req.method === 'POST') return html(res, view.wall(state.result));
      }
      if (!key) return redirect(res, `/${section}/${order[0]}`);

      const step = journey.steps[key];
      if (!step) return html(res, view.page('Not found', '<h1>Page not found</h1><p><a href="/">Home</a></p>'), 404);
      if (url.searchParams.has('restart')) for (const k of Object.keys(state)) delete state[k];
      // Each step needs the ones before it done first.
      const missing = order.slice(0, order.indexOf(key)).find((k) => !state[k]);
      if (missing) return redirect(res, `/${section}/${missing}`);
      const final = order.indexOf(key) === order.length - 1;

      if (req.method === 'GET') return html(res, view.step(section, journey, key, state[key] ?? {}));
      if (req.method === 'POST') {
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
        if (errors.length) return html(res, view.step(section, journey, key, values, errors), 422);
        state[key] = values;
        if (!final) return redirect(res, `/${section}/${order[order.indexOf(key) + 1]}`);
        const labels = Object.fromEntries(order.map((k) => [k, Object.fromEntries(journey.steps[k].fields.map((f) => [f.name, f.options?.find((o) => o.value === state[k][f.name])?.label ?? state[k][f.name]]))]));
        state.result = journey.result(state, labels);
        return redirect(res, `/${section}/result`);
      }
      html(res, view.page('Not found', '<h1>Page not found</h1>'), 404);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) html(res, '<h1>Something went wrong</h1>', 500);
    }
  });
  server.listen(port, process.env.HOST ?? '::', () => console.log(`${site.name} (demo) on port ${port}`));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(site, usher) {
  const page = (title, main) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | ${esc(site.name)}</title>
<meta property="og:site_name" content="${esc(site.name)}">
<link rel="stylesheet" href="/static/site.css">
<style>:root { --brand: ${site.colour}; }</style>
${usher.registry ? `<script src="${esc(usher.registry)}/usher.js" data-usher-registry="${esc(usher.registry)}"${usher.siteKey ? ` data-usher-site-key="${esc(usher.siteKey)}"` : ''} defer></script>\n` : ''}</head>
<body>
<div class="demo-banner">Demo site for the Usher project. ${esc(site.name)} is not a real business.</div>
<header class="site-header"><a href="/" class="brand"><span class="logo" aria-hidden="true">${esc(site.short[0])}</span>${esc(site.name)}</a><span class="tag">${esc(site.tagline)}</span></header>
<main>${main}</main>
<script src="/static/site.js" defer></script>
</body>
</html>`;

  const home = () =>
    page(
      site.tagline,
      `<h1>${esc(site.name)}</h1>
<p class="lede">${esc(site.blurb)}</p>
<ul class="journeys">${Object.entries(site.journeys)
        .map(([key, j]) => `<li><a href="/${key}/${Object.keys(j.steps)[0]}?restart"><strong>${esc(j.title)}</strong><span>${esc(j.summary)}</span></a></li>`)
        .join('')}</ul>`,
    );

  const step = (base, journey, key, values, errors = []) => {
    const order = Object.keys(journey.steps);
    const index = order.indexOf(key);
    const s = journey.steps[key];
    const final = index === order.length - 1;
    const summary = errors.length
      ? `<div class="error-summary" role="alert"><h2>Please check the following</h2><ul>${errors.map((f) => `<li><a href="#f-${f.name}">${esc(f.label)}</a></li>`).join('')}</ul></div>`
      : '';
    return page(
      s.title,
      `${order.length > 1 ? `<p class="progress">${esc(journey.title)}: step ${index + 1} of ${order.length}</p>` : `<p class="progress">${esc(journey.title)}</p>`}
<h1>${esc(s.title)}</h1>
${summary}
<form method="post" action="/${base}/${key}" novalidate>
${s.fields.map((f) => field(f, values[f.name], errors.some((e) => e.name === f.name))).join('\n')}
${final && journey.disclosure ? `<p class="disclosure">${esc(journey.disclosure)}</p>` : ''}
<div class="actions">${index > 0 ? `<a class="back" href="/${base}/${order[index - 1]}">Back</a>` : ''}<button type="submit" class="primary">${esc(final ? journey.action : 'Continue')}</button></div>
</form>`,
    );
  };

  const result = (base, journey, r) =>
    page(
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
    );

  const next = (base, r) =>
    page(
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
<div class="row"><label for="registry">Registry address</label><input type="url" id="registry" name="registry" value="${esc(usher.registry)}" placeholder="https://registry.example"></div>
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

function getSession(sessions, req, res) {
  const sid = /(?:^|;\s*)demo_sid=([0-9a-f-]{36})/.exec(req.headers.cookie ?? '')?.[1];
  if (sid && sessions.has(sid)) return sessions.get(sid);
  const id = randomUUID();
  const session = {};
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  sessions.set(id, session);
  res.setHeader('Set-Cookie', `demo_sid=${id}; Path=/; HttpOnly; SameSite=Lax`);
  return session;
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
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
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
