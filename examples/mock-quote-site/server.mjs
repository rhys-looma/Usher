// Brightwater Insurance: a fictional insurer with two quote journeys, for developing and demonstrating Usher:
// private medical (health) insurance at /health/* and car insurance at /quote/*. Not a real insurer.
// No dependencies; needs Node 20+.
//
//   node server.mjs            start on port 4100
//   PORT=5000 node server.mjs  another port
//   VARIANT=b node server.mjs  start with the alternative form layout (VARIANT=c: real-world controls)
//   USHER_REGISTRY_URL=<registry URL> node server.mjs
//                              use Usher: discovery file and the server-side token check
//                              (run `npm run build` at the repository root first;
//                              USHER_SITE_KEY adds the site key the registry issued)
//   USHER_SITE_ORIGIN=https://quote.example
//                              the origin browsers use, when it isn't http://<Host header>
//                              (behind a load balancer that ends TLS)
//
// Open /__admin to switch the form layout while the site is running (the live drift demo).
// With USHER_ADMIN_KEY set, switching needs that key (a public deployment).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4100);
const occupations = JSON.parse(await readFile(join(here, 'data/occupations.json'), 'utf8'));

let variant = ['b', 'c'].includes(process.env.VARIANT) ? process.env.VARIANT : 'a';
const sameKey = (given, expected) => timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());

// Usher, when a registry is configured. The check only applies to requests that identify as
// agents, and to the API; people using the form are never checked.
const REGISTRY = process.env.USHER_REGISTRY_URL?.replace(/\/$/, '');
const SITE_KEY = process.env.USHER_SITE_KEY;
const SITE_ORIGIN = process.env.USHER_SITE_ORIGIN?.replace(/\/$/, '');
const ADMIN_KEY = process.env.USHER_ADMIN_KEY;
const middleware = REGISTRY ? await import('../../packages/site-middleware/dist/index.js') : null;
/** The server-side token check for one journey's intent, when Usher is on. */
const usherCheck = (intent) =>
  middleware?.createUsherCheck({
    registry: REGISTRY,
    ...(process.env.USHER_REGISTRY_INTERNAL_URL && { internalUrl: process.env.USHER_REGISTRY_INTERNAL_URL }),
    intent,
    origin: SITE_ORIGIN ?? ((req) => `http://${req.headers.host}`),
    ...(process.env.USHER_SITE_KEY && { siteKey: process.env.USHER_SITE_KEY }),
    // A local demo: agents' key directories may be served over http. Never on a public https site.
    allowHttpDirectories: !SITE_ORIGIN?.startsWith('https://'),
    requireSignature: process.env.USHER_REQUIRE_SIGNATURE === '1',
  }) ?? null;
// session id -> { driver, vehicle, cover, result, health: { about, cover, declaration, result } }; the oldest go past MAX_SESSIONS
const sessions = new Map();
const MAX_SESSIONS = 5000;
// quote reference -> { product, dob, result }: what "Find your quote" looks up, in memory only (a
// demo; the oldest go past MAX_QUOTES, and all of them on restart).
const quotes = new Map();
const MAX_QUOTES = 5000;
function keepQuote(product, dob, result) {
  if (quotes.size >= MAX_QUOTES) quotes.delete(quotes.keys().next().value);
  quotes.set(result.reference, { product, dob, result });
  return result;
}
const originOf = (req) => SITE_ORIGIN ?? `http://${req.headers.host}`;
const retrieveUrl = (req, reference) => `${originOf(req)}/retrieve?reference=${encodeURIComponent(reference)}`;

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

// Brightwater Health: a private medical insurance quick quote. Layout A already uses the controls
// real quote forms use (a split date of birth, an address lookup, card radios, a text date), so
// layout C shows it as A does; layout B renames and rewords it, as for car. No medical questions:
// the insurer asks those after the quote, when it underwrites.
const healthSteps = {
  about: {
    title: 'About you',
    titleB: 'Your details',
    next: 'cover',
    fields: [
      { name: 'title', label: 'Title', type: 'select', required: true, options: list('Mr', 'Mrs', 'Miss', 'Ms', 'Mx', 'Dr') },
      { name: 'first_name', label: 'First name', type: 'text', required: true, autocomplete: 'given-name' },
      { name: 'last_name', label: 'Last name', labelB: 'Surname', type: 'text', required: true, autocomplete: 'family-name' },
      { name: 'dob', label: 'Date of birth', labelB: 'Your date of birth', type: 'splitdate', required: true },
      { name: 'postcode', label: 'Postcode', labelB: 'Your postcode', type: 'text', required: true, pattern: '[A-Za-z]{1,2}[0-9][A-Za-z0-9]? ?[0-9][A-Za-z]{2}', autocomplete: 'postal-code' },
      { name: 'address_line1', label: 'Please select an address', labelB: 'Choose your address', type: 'addresslookup', required: true },
      { name: 'email', label: 'Email address', labelB: 'Email', type: 'email', required: true, autocomplete: 'email', orderB: 0 },
      { name: 'phone', label: 'Phone number (optional)', type: 'tel', required: false, autocomplete: 'tel', orderB: 1 },
      { name: 'covered', label: 'Who would you like to cover?', labelB: 'Who is the cover for?', type: 'radio', required: true, card: true, options: [{ value: 'just-me', label: 'Just me' }, { value: 'me-and-partner', label: 'Me and my partner' }, { value: 'family', label: 'My family' }] },
      { name: 'smoker', label: 'Have you smoked or used nicotine products in the last 12 months?', labelB: 'Any smoking or nicotine in the last 12 months?', type: 'radio', required: true, card: true, options: yesNo },
    ],
  },
  cover: {
    title: 'Your cover',
    titleB: 'Choose your cover',
    back: 'about',
    next: 'declaration',
    fields: [
      { name: 'cover_level', label: 'Level of cover', labelB: 'Cover level', type: 'select', required: true, options: list('Core', 'Standard', 'Comprehensive') },
      { name: 'excess', label: 'Excess', labelB: 'Your excess', type: 'select', required: true, options: [0, 100, 250, 500, 1000].map((n) => ({ value: String(n), label: `£${n.toLocaleString('en-GB')}` })) },
      { name: 'hospital_list', label: 'Hospital list', labelB: 'Which hospitals?', type: 'radio', required: true, card: true, options: [{ value: 'local', label: 'Local hospitals' }, { value: 'standard', label: 'Standard list' }, { value: 'extended', label: 'Extended list, including central London' }] },
      { name: 'outpatient_limit', label: 'Outpatient limit', labelB: 'Outpatient cover', type: 'select', required: true, options: [{ value: 'none', label: 'No outpatient cover' }, ...[500, 1000, 1500].map((n) => ({ value: String(n), label: `Up to £${n.toLocaleString('en-GB')} a year` })), { value: 'unlimited', label: 'Unlimited' }] },
      { name: 'start_date', label: 'When would you like cover to start? (DD/MM/YYYY)', labelB: 'Cover start date (DD/MM/YYYY)', type: 'text', required: true, pattern: '\\d{2}\\/\\d{2}\\/\\d{4}', textDate: true },
      { name: 'payment', label: 'How would you like to pay?', labelB: 'Payment', type: 'radio', required: true, card: true, options: list('Monthly', 'Annually') },
    ],
  },
  declaration: {
    title: 'Declaration',
    titleB: 'Check and confirm',
    back: 'cover',
    final: true,
    intro: '<p class="declaration-text">This is a quick quote. We don\'t ask about your medical history on this form. If you go ahead, we ask you about it directly before your cover starts, when we underwrite your policy, and the price may change.</p>',
    fields: [
      { name: 'declaration', label: 'I confirm the information I have given is true and complete, and I understand that my medical history will be asked about after the quote', labelB: 'I confirm my answers are true and complete, and that Brightwater will ask about my medical history after the quote', type: 'checkbox', required: true },
    ],
  },
};

// Variant "c" keeps layout A's names but uses the controls real quote forms use (seen on a real
// insurer's journey): a date of birth split into day, month and year boxes; the address from a
// postcode lookup that shows a list of addresses; mileage as bands; the year as a select; the cover
// start as text in DD/MM/YYYY; radios styled as cards, the input hidden behind its label.
const MILEAGE_BANDS = [4000, 8000, 12000, 15000, 20000].map((n) => ({ value: `UpTo${n}`, label: `Up to ${n.toLocaleString('en-GB')} a year` })).concat([{ value: 'Over20000', label: 'Over 20,000 a year' }]);
const YEARS = Array.from({ length: 27 }, (_, i) => String(2000 + i)).map((y) => ({ value: y, label: y }));
const CARDS = new Set(['employment_status', 'has_claims', 'use', 'modified', 'cover_level', 'payment', 'excess']);
function layoutC(step, f) {
  if (f.name === 'dob') return { ...f, type: 'splitdate' };
  if (f.name === 'address_line1') return { ...f, type: 'addresslookup', label: 'Please select an address' };
  if (f.name === 'annual_mileage') return { ...f, type: 'select', label: "What's this vehicle's annual mileage?", options: MILEAGE_BANDS, min: undefined, max: undefined };
  if (f.name === 'year') return { ...f, type: 'select', options: YEARS, min: undefined, max: undefined };
  if (f.name === 'start_date') return { ...f, type: 'text', label: 'When would you like your cover to start? (DD/MM/YYYY)', pattern: '\\d{2}\\/\\d{2}\\/\\d{4}', textDate: true };
  if (f.name === 'excess') return { ...f, type: 'radio', card: true };
  if (CARDS.has(f.name)) return { ...f, card: true };
  return f;
}
const fieldsOf = (journey, step) => (variant === 'c' && journey.realControls ? step.fields.map((f) => layoutC(step, f)) : step.fields);

/** The addresses on a postcode: a few houses in one street, numbered so "1" and "11" both appear. */
function addressLookup(postcode) {
  const pc = postcode.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/.test(pc)) return null;
  const shown = `${pc.slice(0, -3)} ${pc.slice(-3)}`;
  return ['1 High Street', '2 High Street', '11 High Street', 'Flat 1, 1 High Street', 'The Old Forge, High Street'].map((line1, i) => ({ id: `addr-${i + 1}`, line1, label: `${line1}, Malvern, ${shown}` }));
}

// Variant "b" renames every id and name with a prefix and a short hash.
const nameFor = (field) => (variant === 'b' ? `bw_${field}_${hash(field).slice(0, 4)}` : field);
const idFor = (field) => (variant === 'b' ? `fld-${hash(`id:${field}`).slice(0, 6)}` : field.replaceAll('_', '-'));
const labelFor = (f) => (variant === 'b' && f.labelB ? f.labelB : f.label);
const orderedFields = (journey, step) =>
  variant === 'b'
    ? [...step.fields].sort((x, y) => (x.orderB ?? 100) - (y.orderB ?? 100) || step.fields.indexOf(x) - step.fields.indexOf(y))
    : fieldsOf(journey, step);

// The two journeys: where each lives, its intent (the token the final step needs) and its steps.
const journeys = {
  health: {
    base: 'health',
    product: 'Health insurance',
    intent: 'quote.health_insurance',
    steps: healthSteps,
    realControls: false,
    disclosure: 'By selecting Get my quote you agree that Brightwater may use these answers to work out your price. Medical history is not asked here: Brightwater asks you about it after the quote. This is a demo site: nothing is bought.',
    check: usherCheck('quote.health_insurance'),
    state: (session) => (session.health ??= {}),
  },
  quote: {
    base: 'quote',
    product: 'Car insurance',
    intent: 'quote.car_insurance',
    steps,
    realControls: true,
    lookup: true,
    disclosure: 'By selecting Get my quote you agree that Brightwater may use these answers to work out your price. This is a demo site: nothing is bought.',
    check: usherCheck('quote.car_insurance'),
    state: (session) => session,
  },
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function page(title, body, product = 'Health and car insurance') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | Brightwater</title>
<meta property="og:site_name" content="Brightwater Insurance">
<link rel="stylesheet" href="/static/styles.css">
${REGISTRY ? `<script src="${REGISTRY}/usher.js" data-usher-registry="${REGISTRY}"${SITE_KEY ? ` data-usher-site-key="${SITE_KEY}"` : ''} defer></script>\n` : ''}</head>
<body>
<div class="demo-banner">Demo site for the Usher project. Brightwater Insurance is not a real insurer.</div>
<header class="site-header"><a href="/" class="brand"><svg class="logo" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="15" fill="#ffffff"/><path d="M5 17c3.3-4 6.7-4 10 0s6.7 4 10 0" fill="none" stroke="#0b6e6e" stroke-width="3" stroke-linecap="round"/><path d="M5 11.5c3.3-4 6.7-4 10 0s6.7 4 10 0" fill="none" stroke="#0b6e6e" stroke-width="2" stroke-linecap="round" opacity=".5"/></svg>Brightwater Insurance</a><span class="tag">${esc(product)}</span></header>
<main>${body}</main>
<script src="/static/quote.js" defer></script>
</body>
</html>`;
}

function renderHelp() {
  return page(
    'Help and contact',
    `<h1>Help and contact</h1>
<search><form action="/search" method="get" class="site-search"><label for="q">Search help</label><input id="q" name="q" type="search"><button>Search</button></form></search>
<section><h2>Request a callback</h2>
<form action="/help/callback" method="post" id="callback">
<div class="field"><label for="cb-name">Your name</label><input id="cb-name" name="name" required autocomplete="name"></div>
<div class="field"><label for="cb-phone">Phone number</label><input id="cb-phone" name="phone" type="tel" required autocomplete="tel"></div>
<div class="field"><label for="cb-time">Best time to call</label><select id="cb-time" name="time"><option value="morning">Morning</option><option value="afternoon">Afternoon</option><option value="evening">Evening</option></select></div>
<button type="submit">Request a callback</button></form></section>
<section><h2>Send us a message</h2>
<form action="/help/message" method="post" id="message">
<div class="field"><label for="m-name">Your name</label><input id="m-name" name="name" required autocomplete="name"></div>
<div class="field"><label for="m-email">Email address</label><input id="m-email" name="email" type="email" required autocomplete="email"></div>
<div class="field"><label for="m-policy">Policy number (if you have one)</label><input id="m-policy" name="policy"></div>
<div class="field"><label for="m-body">Your message</label><textarea id="m-body" name="message" required></textarea></div>
<button type="submit">Send message</button></form></section>
<aside><h2>Newsletter</h2><form action="/help/newsletter" method="post" id="newsletter"><label for="n-email">Email address</label><input id="n-email" name="email" type="email"><button>Subscribe</button></form></aside>`,
  );
}

function renderHome() {
  return page(
    'Health and car insurance',
    `<h1>Get a quote</h1>
<p>Brightwater Insurance offers two products. Pick one to start a quote.</p>
<ul class="products">
<li><a href="/health/about"><strong>Health insurance</strong><span>Private medical insurance: a quick quote in three steps</span></a></li>
<li><a href="/quote/driver"><strong>Car insurance</strong><span>A car insurance quote in three steps</span></a></li>
</ul>
<p>Already have a quote? <a href="/retrieve">Find your quote</a>.</p>`,
  );
}

function renderStep(journey, key, values = {}, errors = []) {
  const steps = journey.steps;
  const step = steps[key];
  const order = Object.keys(steps);
  const index = order.indexOf(key) + 1;
  const continueLabel = step.final ? 'Get my quote' : variant === 'b' ? 'Next' : 'Continue';

  const errorSummary = errors.length
    ? `<div class="error-summary" role="alert"><h2>Please check the following</h2><ul>${errors
        .map((f) => `<li><a href="#${idFor(f.name)}">${esc(labelFor(f))}</a></li>`)
        .join('')}</ul></div>`
    : '';

  const lookup = journey.lookup && step.lookup
    ? `<div class="lookup"><button type="button" class="secondary" id="${variant === 'b' ? 'btn-reg' : 'find-vehicle'}" data-lookup="vehicle" data-fields="${['registration', 'make', 'model', 'year'].map(nameFor).join(' ')}">Find car</button><span class="lookup-status" aria-live="polite"></span></div>`
    : '';

  const fieldsHtml = orderedFields(journey, step)
    .map((f) => {
      const html = renderField(f, values[f.name], errors.some((e) => e.name === f.name));
      // The vehicle lookup button sits straight after the registration field.
      return f.name === 'registration' ? html + lookup : html;
    })
    .join('\n');

  const back = step.back
    ? `<a class="back" href="/${journey.base}/${step.back}">Back</a>`
    : '';

  const body = `
<p class="progress">Step ${index} of ${order.length}</p>
<h1>${esc(variant === 'b' ? step.titleB : step.title)}</h1>
${errorSummary}
<form method="post" action="/${journey.base}/${key}" novalidate>
${step.intro ?? ''}
${fieldsHtml}
${step.final ? `<p class="disclosure">${esc(journey.disclosure)}</p>` : ''}
<div class="actions">${back}<button type="submit" class="primary">${continueLabel}</button></div>
</form>`;
  return page(step.title, body, journey.product);
}

function renderField(f, value, hasError) {
  const id = idFor(f.name);
  const name = nameFor(f.name);
  const label = esc(labelFor(f));
  const req = f.required ? ' required' : '';
  const showIf = f.showIf ? ` data-show-if="${nameFor(f.showIf[0])}=${f.showIf[1]}" hidden` : '';
  const cls = `row${hasError ? ' has-error' : ''}`;
  const err = hasError ? `<p class="error-message">${f.type === 'checkbox' ? 'Please confirm to continue' : 'Please complete this field'}</p>` : '';
  const v = f.textDate && /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? value.split('-').reverse().join('/') : (value ?? '');

  switch (f.type) {
    case 'splitdate': {
      // Day, month and year boxes under one legend; the value is the whole date.
      const [y, m, d] = (v || '').split('-');
      const box = (part, max, ph, val) => `<input type="text" id="${id}-${part}" name="${name}_${part}" aria-label="${part[0].toUpperCase()}${part.slice(1)} of birth" autocomplete="bday-${part}" placeholder="${ph}" inputmode="numeric" pattern="[0-9]*" maxlength="${max}" value="${esc(val ?? '')}"${req}>`;
      return `<fieldset class="${cls} split" id="${id}"><legend>${label}</legend>${err}<p class="hint">For example, 24 10 1996</p><div class="parts">${box('day', 2, 'DD', d)}${box('month', 2, 'MM', m)}${box('year', 4, 'YYYY', y)}</div></fieldset>`;
    }
    case 'addresslookup':
      // The list of addresses appears only after "Find address" (quote.js); it isn't in the page before.
      return `<div class="${cls}" id="${id}">${err}<div class="lookup"><button type="button" class="secondary" data-lookup="address" data-postcode="${nameFor('postcode')}" data-select="${nameFor('address')}" data-label="${label}">Find address</button><span class="lookup-status" aria-live="polite"></span></div><div class="lookup-results"></div></div>`;
    case 'select':
      return `<div class="${cls}"${showIf}><label for="${id}">${label}</label>${err}<select id="${id}" name="${name}"${req}><option value="">Please select</option>${f.options
        .map((o) => `<option value="${esc(o.value)}"${o.value === v ? ' selected' : ''}>${esc(o.label)}</option>`)
        .join('')}</select></div>`;
    case 'radio':
      return `<fieldset class="${cls}" id="${id}"${showIf}><legend>${label}</legend>${err}<div class="choices">${f.options
        .map(
          (o, i) =>
            f.card
              ? `<input type="radio" class="card-input" name="${name}" value="${esc(o.value)}" id="${id}-${i}"${o.value === v ? ' checked' : ''}${i === 0 ? req : ''}><label class="choice card" for="${id}-${i}">${esc(o.label)}</label>`
              : `<label class="choice"><input type="radio" name="${name}" value="${esc(o.value)}" id="${id}-${i}"${o.value === v ? ' checked' : ''}${i === 0 ? req : ''}> ${esc(o.label)}</label>`,
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

function renderHealthResult(state) {
  const r = state.result;
  return page(
    'Your quote',
    `
<h1>Your quote</h1>
<div class="quote">
  <p class="price">£${r.monthly.toFixed(2)} <span>a month</span></p>
  <p>or £${r.annual.toFixed(2)} a year</p>
  <p class="ref">Quote reference <strong>${esc(r.reference)}</strong></p>
  <p class="valid">This quote is valid for 30 days, until ${esc(r.validUntil)}.</p>
</div>
<p class="note">This is a made-up price from a demo site. Nothing has been bought. Before cover starts, Brightwater would ask you about your medical history directly.</p>
<p class="note">Come back to it any time: <a href="/retrieve?reference=${encodeURIComponent(r.reference)}">find your quote</a> with your date of birth.</p>
<p><a href="/health/about?restart=1">Start a new quote</a></p>`,
    'Health insurance',
  );
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
  <p class="valid">This quote is valid for 30 days, until ${esc(r.validUntil)}.</p>
</div>
<p class="note">This is a made-up price from a demo site. Nothing has been bought.</p>
<p><a class="button primary" href="/quote/proceed">Continue to buy</a></p>
<p class="note">Come back to it any time: <a href="/retrieve?reference=${encodeURIComponent(r.reference)}">find your quote</a> with your date of birth.</p>
<p><a href="/quote/driver?restart=1">Start a new quote</a></p>`,
    'Car insurance',
  );
}

// Find your quote: the reference and the date of birth it was given for, on the person's own screen.
function renderRetrieve(reference = '', error = '') {
  return page(
    'Find your quote',
    `
<h1>Find your quote</h1>
<p>Enter the quote reference from your quote and your date of birth.</p>
${error ? `<p class="error-message" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/retrieve" class="step">
  <div class="field"><label for="reference">Quote reference</label><input id="reference" name="reference" value="${esc(reference)}" required autocomplete="off" pattern="BWH?-[A-Za-z0-9]{8}"></div>
  <div class="field"><label for="dob">Date of birth</label><input id="dob" name="dob" type="date" required></div>
  <div class="actions"><button type="submit" class="primary">Find my quote</button></div>
</form>`,
  );
}

// The car journey's next step after a quote: where a real insurer would take payment. A demo wall.
function renderProceed(session) {
  const r = session.result;
  return page(
    'Buy this policy',
    `
<h1>Buy this policy</h1>
<div class="quote">
  <p>Car insurance, £${r.annual.toFixed(2)} a year</p>
  <p class="ref">Quote reference <strong>${esc(r.reference)}</strong></p>
</div>
<div class="demo-wall" role="note"><strong>This is where Brightwater would ask for payment.</strong> It is a demo site: nothing can be bought here, and nothing has been.</div>
<p><a href="/quote/result">Back to your quote</a></p>`,
    'Car insurance',
  );
}

function renderAdmin() {
  return page(
    'Demo controls',
    `
<h1>Demo controls</h1>
<p>Current form layout: <strong>${variant.toUpperCase()}</strong></p>
<p>Layout B renames every field id and name, rewords some labels and moves fields, like a site redesign, on both journeys. Layout C (car) uses the controls real quote forms use: a split date of birth, an address lookup with a list of results, mileage bands, a year select, a text date and radios styled as cards.</p>
<form method="post" action="/__admin/variant" class="admin">
  ${ADMIN_KEY ? '<label>Admin key <input type="password" name="key" required></label>' : ''}
  <button name="variant" value="a" class="${variant === 'a' ? 'primary' : 'secondary'}">Use layout A</button>
  <button name="variant" value="b" class="${variant === 'b' ? 'primary' : 'secondary'}">Use layout B</button>
  <button name="variant" value="c" class="${variant === 'c' ? 'primary' : 'secondary'}">Use layout C</button>
</form>`,
  );
}

// ---------------------------------------------------------------------------
// Validation and pricing
// ---------------------------------------------------------------------------

// Reads a submitted form into canonical field names, whichever layout posted it.
function readStep(journey, key, params) {
  const values = {};
  const posted = (name) => params.get(nameFor(name)) ?? params.get(name);
  for (const f of fieldsOf(journey, journey.steps[key])) {
    let raw = posted(f.name);
    // Split dates and the address list; the plain names (as layout A's tests post them) are accepted too.
    const part = (p) => params.get(`${nameFor(f.name)}_${p}`) ?? params.get(`${f.name}_${p}`);
    if (f.type === 'splitdate' && part('day') !== null) {
      const [d, m, y] = ['day', 'month', 'year'].map((p) => (part(p) ?? '').trim());
      raw = d && m && y ? `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` : '';
    }
    if (f.type === 'addresslookup' && posted('address') !== null) {
      const found = (addressLookup(posted('postcode') ?? '') ?? []).find((a) => a.id === posted('address'));
      raw = found ? found.line1 : '';
    }
    if (f.textDate && raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
      raw = m ? `${m[3]}-${m[2]}-${m[1]}` : 'invalid';
    }
    if (f.name === 'annual_mileage' && /^UpTo|^Over/.test(raw ?? '')) raw = String(Number(raw.replace(/\D/g, '')) || 25000);
    if (raw !== null && raw !== '') values[f.name] = raw.trim();
  }
  return values;
}

function validate(journey, key, values) {
  // Values read back (readStep) are layout A's, so layout A's rules check them.
  return journey.steps[key].fields.filter((f) => {
    if (!f.required) return false;
    if (f.showIf && values[f.showIf[0]] !== f.showIf[1]) return false;
    const v = values[f.name];
    if (v === undefined || v === '') return true;
    if (f.options && !f.options.some((o) => o.value === v)) return true;
    // Dates shown as text or split are read back as YYYY-MM-DD.
    if (f.textDate || f.type === 'splitdate') return !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v));
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
    validUntil: new Date(Date.now() + 30 * 86_400_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
    annual,
    instalments: 10,
    monthly: Math.round(((annual * 1.08) / 10) * 100) / 100,
  };
}

function healthPrice({ about, cover }) {
  const age = (Date.now() - Date.parse(about.dob)) / (365.25 * 864e5);
  let monthly = 18 + Math.max(age - 18, 0) * 1.1;
  if (about.smoker === 'yes') monthly *= 1.5;
  monthly *= { 'just-me': 1, 'me-and-partner': 1.9, family: 2.6 }[about.covered] ?? 1;
  monthly *= { core: 0.7, standard: 1, comprehensive: 1.45 }[cover.cover_level] ?? 1;
  monthly *= { local: 0.9, standard: 1, extended: 1.2 }[cover.hospital_list] ?? 1;
  monthly += { none: 0, 500: 6, 1000: 11, 1500: 15, unlimited: 24 }[cover.outpatient_limit] ?? 0;
  monthly -= Number(cover.excess) * 0.012;
  monthly = Math.round(Math.max(monthly, 14) * 100) / 100;
  return {
    reference: `BWH-${randomUUID().slice(0, 8).toUpperCase()}`,
    validUntil: new Date(Date.now() + 30 * 86_400_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
    monthly,
    annual: Math.round(monthly * 12 * 0.95 * 100) / 100,
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
    if (req.url === '/healthz') return json(res, { ok: true, layout: variant, usher: Boolean(REGISTRY) });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const session = getSession(req, res);
    const [, section, key] = url.pathname.split('/');

    if (req.method === 'GET' && url.pathname === '/') return html(res, renderHome());

    if (section === 'static' && req.method === 'GET') return serveStatic(res, key);

    if (url.pathname === '/retrieve' && req.method === 'GET') return html(res, renderRetrieve(url.searchParams.get('reference') ?? ''));
    if (url.pathname === '/retrieve' && req.method === 'POST') {
      const form = new URLSearchParams(await body(req));
      const reference = (form.get('reference') ?? '').trim().toUpperCase();
      const found = quotes.get(reference);
      // The same answer whether the reference or the date is wrong: neither is confirmed alone.
      if (!found || found.dob !== (form.get('dob') ?? '').trim()) return html(res, renderRetrieve(reference, 'We could not find a quote with that reference and date of birth.'), 404);
      const journey = found.product === 'health' ? journeys.health : journeys.quote;
      journey.state(session).result = found.result;
      return redirect(res, `/${journey.base}/result`);
    }
    if (url.pathname === '/quote/proceed' && req.method === 'GET') return session.result ? html(res, renderProceed(session)) : redirect(res, '/retrieve');

    const journey = journeys[section];
    if (journey && key === 'result' && req.method === 'GET') {
      const state = journey.state(session);
      const first = `/${journey.base}/${Object.keys(journey.steps)[0]}`;
      if (!state.result) return redirect(res, first);
      return html(res, journey.base === 'health' ? renderHealthResult(state) : renderResult(session));
    }

    if (journey && journey.steps[key]) {
      const { steps } = journey;
      const state = journey.state(session);
      if (url.searchParams.has('restart')) for (const k of [...Object.keys(steps), 'result']) state[k] = undefined;
      // Each step needs the previous ones done first.
      const order = Object.keys(steps);
      const missing = order.slice(0, order.indexOf(key)).find((k) => !state[k]);
      if (missing) return redirect(res, `/${journey.base}/${missing}`);

      if (req.method === 'GET') return html(res, renderStep(journey, key, state[key] ?? {}));

      if (req.method === 'POST') {
        const raw = await body(req);
        const params = new URLSearchParams(raw);
        // Requesting the quote is consequential: an agent needs a token from a knock (and, if it
        // signs its requests, a signature from the key the token was issued to).
        if (steps[key].final && journey.check) {
          const check = await journey.check.check(req, { form: params, action: 'form.submit', body: new TextEncoder().encode(raw) });
          if (check.status === 'knock_required') return journey.check.reject(req, res, check, 'form.submit');
        }
        const values = readStep(journey, key, params);
        const errors = validate(journey, key, values);
        if (errors.length) return html(res, renderStep(journey, key, values, errors), 422);
        state[key] = values;
        if (!steps[key].final) return redirect(res, `/${journey.base}/${steps[key].next}`);
        // Consequential action: requesting a quote. Usher's server-side token check attaches here.
        state.result = journey.base === 'health' ? keepQuote('health', state.about.dob, healthPrice(state)) : keepQuote('car', session.driver.dob, price(session));
        return redirect(res, `/${journey.base}/result`);
      }
    }

    if (section === 'api' && key === 'address' && req.method === 'GET') {
      const found = addressLookup(url.searchParams.get('postcode') ?? '');
      return json(res, found ? { addresses: found.map(({ id, label }) => ({ id, label })) } : { error: 'not_found' }, found ? 200 : 404);
    }
    if (section === 'api' && key === 'vehicle' && req.method === 'GET') {
      const found = vehicleLookup(url.searchParams.get('registration') ?? '');
      return json(res, found ?? { error: 'not_found' }, found ? 200 : 404);
    }

    // The same consequential action as an API, so the demo can show an agent
    // skipping the page and calling the endpoint directly.
    const api = { quote: journeys.quote, 'health-quote': journeys.health }[key];
    if (section === 'api' && api && req.method === 'POST') {
      // The API is for software, so every call needs a token when Usher is on.
      const raw = await body(req);
      if (api.check) {
        const check = await api.check.check(req, { always: true, action: 'form.submit', body: new TextEncoder().encode(raw) });
        if (check.status === 'knock_required') return api.check.reject(req, res, check, 'form.submit');
      }
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        return json(res, { error: 'invalid_json' }, 400);
      }
      const all = {};
      const errors = [];
      for (const k of Object.keys(api.steps)) {
        all[k] = readStep(api, k, new URLSearchParams(Object.entries(input?.[k] ?? {}).map(([a, b]) => [a, String(b)])));
        errors.push(...validate(api, k, all[k]).map((f) => `${k}.${f.name}`));
      }
      if (errors.length) return json(res, { error: 'invalid', fields: errors }, 422);
      const result = api.base === 'health' ? keepQuote('health', all.about.dob, healthPrice(all)) : keepQuote('car', all.driver.dob, price(all));
      return json(res, { ...result, retrieve_url: retrieveUrl(req, result.reference) });
    }

    // The site's claim to its origin: the registry checks this file holds the site key.
    if (process.env.USHER_SITE_KEY && req.method === 'GET' && url.pathname === '/.well-known/usher-site.json') {
      return json(res, { usher_site: '0.1', site_key: process.env.USHER_SITE_KEY });
    }

    if (REGISTRY && req.method === 'GET' && url.pathname === '/.well-known/usher.json') {
      return json(res, { usher: '0.1', registry: REGISTRY, knock_url: `${REGISTRY}/knock`, keys_url: `${REGISTRY}/.well-known/usher-keys.json`, journeys: Object.values(journeys).map((j) => ({ start: `/${j.base}/${Object.keys(j.steps)[0]}`, intent: j.intent })) });
    }

    // A help page with several forms, for choosing the form by intent: a site search, a newsletter
    // box, a callback request and a message. Nothing on it is processed.
    if (req.method === 'GET' && url.pathname === '/help') return html(res, renderHelp());
    if (req.method === 'POST' && section === 'help') return html(res, page('Thank you', '<h1>Thank you</h1><p>This is a demo; nothing was sent.</p>'));

    if (section === '__admin') {
      if (req.method === 'GET' && !key) return html(res, renderAdmin());
      if (req.method === 'POST' && key === 'variant') {
        const form = new URLSearchParams(await body(req));
        if (ADMIN_KEY && !sameKey(form.get('key') ?? '', ADMIN_KEY)) return html(res, page('Not allowed', '<h1>That key is not right</h1><p><a href="/__admin">Back</a></p>'), 401);
        const v = form.get('variant');
        if (v === 'a' || v === 'b' || v === 'c') variant = v;
        console.log(`form layout switched to ${variant.toUpperCase()}`);
        return redirect(res, '/__admin');
      }
    }

    html(res, page('Not found', '<h1>Page not found</h1><p><a href="/">Get a quote</a></p>'), 404);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) html(res, page('Error', '<h1>Something went wrong</h1>'), 500);
  }
});

server.listen(PORT, process.env.HOST ?? '::', () => {
  console.log(`Brightwater Insurance (demo) on port ${PORT}  layout ${variant.toUpperCase()}  controls at /__admin`);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSession(req, res) {
  const sid = /(?:^|;\s*)bw_sid=([0-9a-f-]{36})/.exec(req.headers.cookie ?? '')?.[1];
  if (sid && sessions.has(sid)) return sessions.get(sid);
  const id = randomUUID();
  const session = {};
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  sessions.set(id, session);
  res.setHeader('Set-Cookie', `bw_sid=${id}; Path=/; HttpOnly; SameSite=Lax${SITE_ORIGIN?.startsWith('https://') ? '; Secure' : ''}`);
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
