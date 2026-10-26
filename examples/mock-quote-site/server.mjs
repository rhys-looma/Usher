// Brightwater Motor: a fictional car insurance quote site for developing and demonstrating Usher.
// Not a real insurer. No dependencies; needs Node 20+.
//
//   node server.mjs            start on http://localhost:4100
//   PORT=5000 node server.mjs  another port
//   VARIANT=b node server.mjs  start with the alternative form layout
//   USHER_REGISTRY_URL=http://localhost:4200 node server.mjs
//                              use Usher: discovery file and the server-side token check
//                              (run `npm run build` at the repository root first;
//                              USHER_SITE_KEY adds the site key the registry issued)
//
// Open /__admin to switch the form layout while the site is running (the live drift demo).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4100);
const occupations = JSON.parse(await readFile(join(here, 'data/occupations.json'), 'utf8'));

let variant = process.env.VARIANT === 'b' ? 'b' : 'a';

// Usher, when a registry is configured. The check only applies to requests that identify as
// agents, and to the API; people using the form are never checked.
const REGISTRY = process.env.USHER_REGISTRY_URL?.replace(/\/$/, '');
const SITE_KEY = process.env.USHER_SITE_KEY;
const usher = REGISTRY
  ? (await import('../../packages/site-middleware/dist/index.js')).createUsherCheck({
      registry: REGISTRY,
      intent: 'quote.car_insurance',
      origin: (req) => `http://${req.headers.host}`,
    })
  : null;
const sessions = new Map(); // session id -> { driver, vehicle, cover, result }

// ---------------------------------------------------------------------------
// Form definitions. One definition drives both layouts: variant "b" renames
// every id and name, rewords some labels and reorders fields, the way a real
// redesign would. That is what Usher's fingerprinting and healing must survive.
// ---------------------------------------------------------------------------

const yesNo = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
const list = (...labels) => labels.map((label) => ({ value: slug(label), label }));

const steps = {
  driver: {
    title: 'About you',
    titleB: 'Your details',
    next: 'vehicle',
    fields: [
      { name: 'title', label: 'Title', type: 'select', required: true, options: list('Mr', 'Mrs', 'Miss', 'Ms', 'Mx', 'Dr') },
      { name: 'first_name', label: 'First name', type: 'text', required: true, autocomplete: 'given-name' },
      { name: 'last_name', label: 'Last name', labelB: 'Surname', type: 'text', required: true, autocomplete: 'family-name' },
      { name: 'dob', label: 'Date of birth', labelB: 'Your date of birth', type: 'date', required: true },
      { name: 'email', label: 'Email address', labelB: 'Email', type: 'email', required: true, autocomplete: 'email', orderB: 0 },
      { name: 'phone', label: 'Phone number (optional)', type: 'tel', required: false, autocomplete: 'tel', orderB: 1 },
      { name: 'postcode', label: 'Postcode', type: 'text', required: true, pattern: '[A-Za-z]{1,2}[0-9][A-Za-z0-9]? ?[0-9][A-Za-z]{2}', autocomplete: 'postal-code' },
      { name: 'address_line1', label: 'First line of address', labelB: 'House number and street', type: 'text', required: true, autocomplete: 'address-line1' },
      { name: 'occupation', label: 'Occupation', labelB: 'Main occupation', type: 'select', required: true, options: occupations.map((o) => ({ value: slug(o), label: o })) },
      { name: 'employment_status', label: 'Employment status', type: 'radio', required: true, options: list('Employed', 'Self-employed', 'Retired', 'Student', 'Unemployed') },
      { name: 'has_claims', label: 'Have you made any claims in the last 5 years?', type: 'radio', required: true, options: yesNo },
      { name: 'claim_date', label: 'Date of the claim', type: 'date', required: true, showIf: ['has_claims', 'yes'] },
      { name: 'claim_type', label: 'Type of claim', type: 'select', required: true, showIf: ['has_claims', 'yes'], options: list('Accident', 'Theft', 'Windscreen', 'Fire', 'Vandalism') },
    ],
  },
  vehicle: {
    title: 'Your car',
    titleB: 'The car',
    back: 'driver',
    next: 'cover',
    lookup: true,
    fields: [
      { name: 'registration', label: 'Registration number', labelB: 'Car registration', type: 'text', required: true, pattern: '[A-Za-z0-9 ]{2,8}' },
      { name: 'make', label: 'Make', type: 'text', required: true },
      { name: 'model', label: 'Model', type: 'text', required: true },
      { name: 'year', label: 'Year of manufacture', type: 'number', required: true, min: 1960, max: 2027 },
      { name: 'annual_mileage', label: 'Estimated annual mileage', labelB: 'Miles per year', type: 'number', required: true, min: 0, max: 100000 },
      { name: 'use', label: 'What do you use the car for?', type: 'radio', required: true, options: list('Social only', 'Social and commuting', 'Business') },
      { name: 'overnight', label: 'Where is the car kept overnight?', type: 'select', required: true, options: list('Garage', 'Driveway', 'On the street', 'Car park') },
      { name: 'modified', label: 'Has the car been modified?', type: 'radio', required: true, options: yesNo },
    ],
  },
  cover: {
    title: 'Your cover',
    titleB: 'Cover options',
    back: 'vehicle',
    final: true,
    fields: [
      { name: 'start_date', label: 'Cover start date', labelB: 'When should cover start?', type: 'date', required: true },
      { name: 'cover_level', label: 'Level of cover', type: 'radio', required: true, options: list('Comprehensive', 'Third party, fire and theft', 'Third party only') },
      { name: 'excess', label: 'Voluntary excess', type: 'select', required: true, options: [0, 100, 250, 500].map((n) => ({ value: String(n), label: `£${n}` })) },
      { name: 'ncd_years', label: 'Years of no-claims discount', type: 'select', required: true, options: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9+'].map((n) => ({ value: n, label: n })) },
      { name: 'payment', label: 'How would you like to pay?', type: 'radio', required: true, options: list('Annually', 'Monthly') },
      { name: 'declaration', label: 'I confirm the information I have given is true and complete', type: 'checkbox', required: true },
      { name: 'marketing', label: 'Send me offers by email (optional)', type: 'checkbox', required: false },
    ],
  },
};

// Variant "b" renames every id and name with a prefix and a short hash.
const nameFor = (field) => (variant === 'b' ? `bw_${field}_${hash(field).slice(0, 4)}` : field);
const idFor = (field) => (variant === 'b' ? `fld-${hash(`id:${field}`).slice(0, 6)}` : field.replaceAll('_', '-'));
const labelFor = (f) => (variant === 'b' && f.labelB ? f.labelB : f.label);
const orderedFields = (step) =>
  variant === 'b'
    ? [...step.fields].sort((x, y) => (x.orderB ?? 100) - (y.orderB ?? 100) || step.fields.indexOf(x) - step.fields.indexOf(y))
    : step.fields;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | Brightwater Motor</title>
<link rel="stylesheet" href="/static/styles.css">
${REGISTRY ? `<script src="${REGISTRY}/usher.js" data-usher-registry="${REGISTRY}"${SITE_KEY ? ` data-usher-site-key="${SITE_KEY}"` : ''} defer></script>\n` : ''}</head>
<body>
<div class="demo-banner">Demo site for the Usher project. Brightwater Motor is fictional; this is not a real insurer.</div>
<header class="site-header"><a href="/" class="brand">Brightwater Motor</a><span class="tag">Car insurance</span></header>
<main>${body}</main>
<script src="/static/quote.js" defer></script>
</body>
</html>`;
}

function renderStep(key, values = {}, errors = []) {
  const step = steps[key];
  const order = Object.keys(steps);
  const index = order.indexOf(key) + 1;
  const continueLabel = step.final ? 'Get my quote' : variant === 'b' ? 'Next' : 'Continue';

  const errorSummary = errors.length
    ? `<div class="error-summary" role="alert"><h2>Please check the following</h2><ul>${errors
        .map((f) => `<li><a href="#${idFor(f.name)}">${esc(labelFor(f))}</a></li>`)
        .join('')}</ul></div>`
    : '';

  const lookup = step.lookup
    ? `<div class="lookup"><button type="button" class="secondary" id="${variant === 'b' ? 'btn-reg' : 'find-vehicle'}" data-lookup="vehicle" data-fields="${['registration', 'make', 'model', 'year'].map(nameFor).join(' ')}">Find car</button><span class="lookup-status" aria-live="polite"></span></div>`
    : '';

  const fieldsHtml = orderedFields(step)
    .map((f) => {
      const html = renderField(f, values[f.name], errors.includes(f));
      // The vehicle lookup button sits straight after the registration field.
      return f.name === 'registration' ? html + lookup : html;
    })
    .join('\n');

  const back = step.back
    ? `<a class="back" href="/quote/${step.back}">Back</a>`
    : '';

  const body = `
<p class="progress">Step ${index} of ${order.length}</p>
<h1>${esc(variant === 'b' ? step.titleB : step.title)}</h1>
${errorSummary}
<form method="post" action="/quote/${key}" novalidate>
${fieldsHtml}
<div class="actions">${back}<button type="submit" class="primary">${continueLabel}</button></div>
</form>`;
  return page(step.title, body);
}

function renderField(f, value, hasError) {
  const id = idFor(f.name);
  const name = nameFor(f.name);
  const label = esc(labelFor(f));
  const req = f.required ? ' required' : '';
  const showIf = f.showIf ? ` data-show-if="${nameFor(f.showIf[0])}=${f.showIf[1]}" hidden` : '';
  const cls = `row${hasError ? ' has-error' : ''}`;
  const err = hasError ? `<p class="error-message">${f.type === 'checkbox' ? 'Please confirm to continue' : 'Please complete this field'}</p>` : '';
  const v = value ?? '';

  switch (f.type) {
    case 'select':
      return `<div class="${cls}"${showIf}><label for="${id}">${label}</label>${err}<select id="${id}" name="${name}"${req}><option value="">Please select</option>${f.options
        .map((o) => `<option value="${esc(o.value)}"${o.value === v ? ' selected' : ''}>${esc(o.label)}</option>`)
        .join('')}</select></div>`;
    case 'radio':
      return `<fieldset class="${cls}" id="${id}"${showIf}><legend>${label}</legend>${err}<div class="choices">${f.options
        .map(
          (o, i) =>
            `<label class="choice"><input type="radio" name="${name}" value="${esc(o.value)}" id="${id}-${i}"${o.value === v ? ' checked' : ''}${i === 0 ? req : ''}> ${esc(o.label)}</label>`,
        )
        .join('')}</div></fieldset>`;
    case 'checkbox':
      return `<div class="${cls} check"${showIf}>${err}<label class="choice"><input type="checkbox" id="${id}" name="${name}" value="yes"${v === 'yes' ? ' checked' : ''}${req}> ${label}</label></div>`;
    default: {
      const attrs = [
        f.pattern && `pattern="${esc(f.pattern)}"`,
        f.min !== undefined && `min="${f.min}"`,
        f.max !== undefined && `max="${f.max}"`,
        f.autocomplete && `autocomplete="${f.autocomplete}"`,
      ]
        .filter(Boolean)
        .join(' ');
      return `<div class="${cls}"${showIf}><label for="${id}">${label}</label>${err}<input type="${f.type}" id="${id}" name="${name}" value="${esc(v)}" ${attrs}${req}></div>`;
    }
  }
}

function renderResult(session) {
  const r = session.result;
  return page(
    'Your quote',
    `
<h1>Your quote</h1>
<div class="quote">
  <p class="price">£${r.annual.toFixed(2)} <span>a year</span></p>
  <p>or ${r.instalments} monthly payments of £${r.monthly.toFixed(2)}</p>
  <p class="ref">Quote reference <strong>${esc(r.reference)}</strong></p>
</div>
<p class="note">This is a made-up price from a demo site. Nothing has been bought.</p>
<p><a href="/quote/driver?restart=1">Start a new quote</a></p>`,
  );
}

function renderAdmin() {
  return page(
    'Demo controls',
    `
<h1>Demo controls</h1>
<p>Current form layout: <strong>${variant.toUpperCase()}</strong></p>
<p>Layout B renames every field id and name, rewords some labels and moves fields, like a site redesign.</p>
<form method="post" action="/__admin/variant" class="admin">
  <button name="variant" value="a" class="${variant === 'a' ? 'primary' : 'secondary'}">Use layout A</button>
  <button name="variant" value="b" class="${variant === 'b' ? 'primary' : 'secondary'}">Use layout B</button>
</form>`,
  );
}

// ---------------------------------------------------------------------------
// Validation and pricing
// ---------------------------------------------------------------------------

// Reads a submitted form into canonical field names, whichever layout posted it.
function readStep(key, params) {
  const values = {};
  for (const f of steps[key].fields) {
    const raw = params.get(nameFor(f.name)) ?? params.get(f.name);
    if (raw !== null && raw !== '') values[f.name] = raw.trim();
  }
  return values;
}

function validate(key, values) {
  return steps[key].fields.filter((f) => {
    if (!f.required) return false;
    if (f.showIf && values[f.showIf[0]] !== f.showIf[1]) return false;
    const v = values[f.name];
    if (v === undefined || v === '') return true;
    if (f.options && !f.options.some((o) => o.value === v)) return true;
    if (f.pattern && !new RegExp(`^(?:${f.pattern})$`).test(v)) return true;
    if (f.type === 'number' && (Number.isNaN(Number(v)) || (f.min !== undefined && Number(v) < f.min) || (f.max !== undefined && Number(v) > f.max))) return true;
    if (f.type === 'date' && Number.isNaN(Date.parse(v))) return true;
    return false;
  });
}

function price({ driver, vehicle, cover }) {
  const age = (Date.now() - Date.parse(driver.dob)) / (365.25 * 864e5);
  let annual = 420;
  if (age < 25) annual += 600;
  else if (age < 30) annual += 220;
  else if (age > 70) annual += 150;
  if (driver.has_claims === 'yes') annual *= 1.35;
  annual += Math.min(Number(vehicle.annual_mileage) || 0, 30000) * 0.012;
  if (vehicle.use === 'business') annual *= 1.2;
  if (vehicle.overnight === 'on-the-street') annual *= 1.1;
  if (vehicle.modified === 'yes') annual *= 1.25;
  if (cover.cover_level === 'third-party-only') annual *= 0.85;
  annual -= Number(cover.excess) * 0.3;
  const ncd = cover.ncd_years === '9+' ? 9 : Number(cover.ncd_years) || 0;
  annual *= 1 - Math.min(ncd, 9) * 0.06;
  annual = Math.round(Math.max(annual, 180) * 100) / 100;
  return {
    reference: `BW-${randomUUID().slice(0, 8).toUpperCase()}`,
    annual,
    instalments: 10,
    monthly: Math.round(((annual * 1.08) / 10) * 100) / 100,
  };
}

const makes = [
  ['Ford', 'Fiesta'], ['Vauxhall', 'Corsa'], ['Volkswagen', 'Golf'], ['Toyota', 'Yaris'],
  ['Nissan', 'Qashqai'], ['Kia', 'Sportage'], ['BMW', '3 Series'], ['Audi', 'A3'],
];

function vehicleLookup(registration) {
  const reg = registration.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(reg)) return null;
  const h = parseInt(hash(reg).slice(0, 8), 16);
  const [make, model] = makes[h % makes.length];
  return { registration: reg, make, model, year: 2008 + (h % 17) };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const session = getSession(req, res);
    const [, section, key] = url.pathname.split('/');

    if (req.method === 'GET' && url.pathname === '/') return redirect(res, '/quote/driver');

    if (section === 'static' && req.method === 'GET') return serveStatic(res, key);

    if (section === 'quote' && key === 'result' && req.method === 'GET') {
      return session.result ? html(res, renderResult(session)) : redirect(res, '/quote/driver');
    }

    if (section === 'quote' && steps[key]) {
      if (url.searchParams.has('restart')) Object.assign(session, { driver: undefined, vehicle: undefined, cover: undefined, result: undefined });
      // Each step needs the previous ones done first.
      const order = Object.keys(steps);
      const missing = order.slice(0, order.indexOf(key)).find((k) => !session[k]);
      if (missing) return redirect(res, `/quote/${missing}`);

      if (req.method === 'GET') return html(res, renderStep(key, session[key] ?? {}));

      if (req.method === 'POST') {
        const params = new URLSearchParams(await body(req));
        // Requesting the quote is consequential: an agent needs a token from a knock.
        if (steps[key].final && usher) {
          const check = await usher.check(req, { form: params, action: 'form.submit' });
          if (check.status === 'knock_required') return usher.reject(req, res, check);
        }
        const values = readStep(key, params);
        const errors = validate(key, values);
        if (errors.length) return html(res, renderStep(key, values, errors), 422);
        session[key] = values;
        if (!steps[key].final) return redirect(res, `/quote/${steps[key].next}`);
        // Consequential action: requesting a quote. Usher's server-side token check attaches here.
        session.result = price(session);
        return redirect(res, '/quote/result');
      }
    }

    if (section === 'api' && key === 'vehicle' && req.method === 'GET') {
      const found = vehicleLookup(url.searchParams.get('registration') ?? '');
      return json(res, found ?? { error: 'not_found' }, found ? 200 : 404);
    }

    // The same consequential action as an API, so the demo can show an agent
    // skipping the page and calling the endpoint directly.
    if (section === 'api' && key === 'quote' && req.method === 'POST') {
      // The API is for software, so every call needs a token when Usher is on.
      if (usher) {
        const check = await usher.check(req, { always: true, action: 'form.submit' });
        if (check.status === 'knock_required') return usher.reject(req, res, check);
      }
      let input;
      try {
        input = JSON.parse(await body(req));
      } catch {
        return json(res, { error: 'invalid_json' }, 400);
      }
      const all = {};
      const errors = [];
      for (const k of Object.keys(steps)) {
        all[k] = readStep(k, new URLSearchParams(Object.entries(input?.[k] ?? {}).map(([a, b]) => [a, String(b)])));
        errors.push(...validate(k, all[k]).map((f) => `${k}.${f.name}`));
      }
      if (errors.length) return json(res, { error: 'invalid', fields: errors }, 422);
      return json(res, price(all));
    }

    if (REGISTRY && req.method === 'GET' && url.pathname === '/.well-known/usher.json') {
      return json(res, { usher: '0.1', registry: REGISTRY, knock_url: `${REGISTRY}/knock`, keys_url: `${REGISTRY}/.well-known/usher-keys.json` });
    }

    if (section === '__admin') {
      if (req.method === 'GET' && !key) return html(res, renderAdmin());
      if (req.method === 'POST' && key === 'variant') {
        const v = new URLSearchParams(await body(req)).get('variant');
        if (v === 'a' || v === 'b') variant = v;
        console.log(`form layout switched to ${variant.toUpperCase()}`);
        return redirect(res, '/__admin');
      }
    }

    html(res, page('Not found', '<h1>Page not found</h1><p><a href="/">Start a quote</a></p>'), 404);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) html(res, page('Error', '<h1>Something went wrong</h1>'), 500);
  }
});

server.listen(PORT, () => {
  console.log(`Brightwater Motor (demo) on http://localhost:${PORT}  layout ${variant.toUpperCase()}  controls at /__admin`);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSession(req, res) {
  const sid = /(?:^|;\s*)bw_sid=([0-9a-f-]{36})/.exec(req.headers.cookie ?? '')?.[1];
  if (sid && sessions.has(sid)) return sessions.get(sid);
  const id = randomUUID();
  const session = {};
  sessions.set(id, session);
  res.setHeader('Set-Cookie', `bw_sid=${id}; Path=/; HttpOnly; SameSite=Lax`);
  return session;
}

async function serveStatic(res, file) {
  const types = { '.css': 'text/css', '.js': 'text/javascript' };
  if (!file || !/^[\w.-]+$/.test(file) || !types[extname(file)]) return html(res, page('Not found', '<h1>Not found</h1>'), 404);
  try {
    const content = await readFile(join(here, 'public', file));
    res.writeHead(200, { 'Content-Type': `${types[extname(file)]}; charset=utf-8` });
    res.end(content);
  } catch {
    html(res, page('Not found', '<h1>Not found</h1>'), 404);
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

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function hash(s) {
  return createHash('sha256').update(s).digest('hex');
}

function esc(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
