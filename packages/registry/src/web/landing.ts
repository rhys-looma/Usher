// The front page (LU-53): what Usher is, what happens between a person's message and their quote (and
// what Usher keeps), the map viewer inline (when it is on), the two quickstarts, the numbers from the
// committed reports, and an interest form that carries Usher's own script tag.

import { readFile, readdir } from 'node:fs/promises';
import { FAVICON, LOOMA_FOOTER, THEME, esc, html, siteClaims, type Raw } from './html.ts';
import type { PickerForm } from './picker.ts';
import { PICKER_STYLE, pickerButtons } from './viewer.ts';
import { CARD_CSS, CARD_DARK } from './cards.ts';
import { KEEPS, KEEPS_HEADING } from './keeps.ts';

const ROOT = new URL('../../../../', import.meta.url);

export const SENTENCE = 'Usher is the front door for AI agents on web forms. Agents knock, get in fast, and follow the house rules.';
export const SUBLINE = 'More of the web, open to agents.';
/** The meta and OpenGraph description. */
export const DESCRIPTION = 'Usher is the front door for AI agents on web forms: the control layer for sites, one call for agents, no integration required.';
export const REPOSITORY = 'https://github.com/rhys-looma/Usher';
/** The one-sentence positioning, under the headline. */
export const POSITIONING = 'The control layer for AI agents on your forms. No integration required.';
/** The example the page follows: a health insurance quote on the demo site, asked in plain words. */
export const EXAMPLE = "Get me a health insurance quote from Brightwater. I'm Sam Taylor, born 2 April 1988, WR14 1AA, just me, non-smoker, comprehensive cover with a £250 excess.";
const HEALTH_JOURNEY = 'Brightwater Health, 3 steps, submitted';
const CAR_JOURNEY = 'Mock quote site, 3 steps, submitted';

interface BenchmarkRow {
  journey: string;
  reading: { time: number; cost: string };
  maps: { time: number; cost: string };
}

export interface Numbers {
  benchmark: { rows: BenchmarkRow[]; generated?: string };
  /** Human-checked accuracy once anyone has marked the public forms; until then, what code can check. */
  accuracy:
    | { kind: 'reviewed'; keys: string; risk: string; keysOf: string; riskOf: string; reviewed: number; run?: string }
    | { kind: 'automatic'; resolved: number; elements: number; forms: number; agreement: { set: string; pct: string; of: number }[] }
    | null;
}

const read = (path: string) => readFile(new URL(path, ROOT), 'utf8').catch(() => '');
const pct = (a: number, b: number) => `${Math.round((a / b) * 1000) / 10}%`;

function csvRow(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted && c === '"' && line[i + 1] === '"') (cell += '"'), i++;
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) out.push(cell), (cell = '');
    else cell += c;
  }
  return [...out, cell];
}

/** Reads reports/: the benchmark's medians (Agent A, reading pages against maps) and accuracy. */
export async function loadNumbers(): Promise<Numbers> {
  const bench = await read('reports/benchmark.md');
  const rows = new Map<string, BenchmarkRow>();
  // The replayed runs only: the live section below them is one run each.
  for (const line of bench.split('\n## Live')[0]!.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 9 || !cells[3]?.startsWith('Agent A')) continue;
    const [, journey, config, , , wall, , , cost] = cells as string[];
    const time = Number(/^([\d.]+) s/.exec(wall!)?.[1]);
    if (!journey || Number.isNaN(time)) continue;
    const row = rows.get(journey) ?? { journey, reading: { time: 0, cost: '' }, maps: { time: 0, cost: '' } };
    if (config!.startsWith('(a)')) row.reading = { time, cost: cost! };
    if (config!.startsWith('(b)')) row.maps = { time, cost: cost! };
    rows.set(journey, row);
  }
  const generated = /Generated (\d{4}-\d{2}-\d{2})/.exec(bench)?.[1];

  let accuracy: Numbers['accuracy'] = null;
  // The latest human-checked run whose public-form rows are all marked: the current review once it
  // is complete, else the most recent complete dated one. A half-marked run is never shown.
  const reviews = ['accuracy-review.csv', ...(await readdir(new URL('reports/', ROOT)).catch(() => [] as string[])).filter((f) => /^accuracy-review-\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort().reverse()];
  for (const file of reviews) {
    const [header, ...lines] = (await read(`reports/${file}`)).trim().split('\n');
    const cols = header ? csvRow(header) : [];
    const rows = lines.map((l) => Object.fromEntries(csvRow(l).map((v, i) => [cols[i], v.trim().toLowerCase()])) as Record<string, string>).filter((r) => r.category !== 'mock site');
    const marked = rows.filter((r) => ['y', 'n'].includes(r.key_correct ?? '') && ['y', 'n'].includes(r.risk_correct ?? ''));
    if (!rows.length || marked.length < rows.length) continue;
    const keys = marked.filter((r) => r.key_correct === 'y').length;
    const risk = marked.filter((r) => r.risk_correct === 'y').length;
    const run = /(\d{4}-\d{2}-\d{2})/.exec(file)?.[1];
    accuracy = { kind: 'reviewed', keys: pct(keys, marked.length), risk: pct(risk, marked.length), keysOf: `${keys} of ${marked.length}`, riskOf: `${risk} of ${marked.length}`, reviewed: marked.length, ...(run && { run }) };
    break;
  }
  if (!accuracy) {
    const report = JSON.parse((await read('reports/accuracy.json')) || '{"results":[]}') as { results: { status: string; elements?: number; locators_resolved?: number }[] };
    const ok = report.results.filter((r) => r.status === 'ok');
    const elements = ok.reduce((s, r) => s + (r.elements ?? 0), 0);
    const agreement = [...(await read('reports/classifier-agreement.md')).matchAll(/^- (Mock site|Public forms)[^:]*: ([\d.]+%) of (\d+) elements agree/gm)].map((m) => ({ set: m[1] === 'Mock site' ? 'the demo quote form' : 'public forms', pct: m[2]!, of: Number(m[3]) }));
    if (elements) accuracy = { kind: 'automatic', resolved: ok.reduce((s, r) => s + (r.locators_resolved ?? 0), 0), elements, forms: ok.length, agreement };
  }
  // The health journey first, the car journey beside it, then the rest as the report lists them.
  const order = (r: BenchmarkRow) => [HEALTH_JOURNEY, CAR_JOURNEY].indexOf(r.journey) + 1 || 3;
  const listed = [...rows.values()].filter((r) => r.reading.time && r.maps.time).sort((a, b) => order(a) - order(b));
  return { benchmark: { rows: listed, ...(generated && { generated }) }, accuracy };
}

const JOURNEY_NAMES: Record<string, string> = {
  [HEALTH_JOURNEY]: 'A three-step health insurance quote (demo site)',
  [CAR_JOURNEY]: 'A three-step car insurance quote (demo site)',
  'httpbin.org/forms/post, 1 page, filled not submitted': 'A one-page order form (httpbin.org)',
};

function numbersSection(numbers: Numbers): Raw {
  const { rows, generated } = numbers.benchmark;
  const a = numbers.accuracy;
  return html`<section id="numbers" data-reveal><h2>Numbers</h2>
${
  rows.length
    ? html`<div class="card"><table>
<thead><tr><th>Journey</th><th>Agent reads each page</th><th>Agent uses the map</th><th></th></tr></thead>
<tbody>${rows.map(
        (r) => html`<tr><td><b>${JOURNEY_NAMES[r.journey] ?? r.journey}</b></td><td data-label="Agent reads each page">${r.reading.time.toFixed(1)} s · ${r.reading.cost}</td><td data-label="Agent uses the map">${r.maps.time.toFixed(1)} s · ${r.maps.cost}</td><td><b>${(r.reading.time / r.maps.time).toFixed(1)}× faster</b></td></tr>`,
      )}</tbody></table>
<p class="small muted">The same agent filling the same form, five runs each, medians. Reading a page means the agent's model (Muse Spark) reads its structure and a screenshot first; with a map it reads nothing. Model time is replayed from recorded calls${generated ? `, ${generated}` : ''}. <a href="${REPOSITORY}/blob/main/reports/benchmark.md">Method and ranges</a>.</p></div>`
    : ''
}
${
  a?.kind === 'reviewed'
    ? html`<div class="grid"><div class="card stat"><b>${a.keys}</b><span>of fields and buttons on public forms given the right meaning (${a.keysOf}), human-checked</span></div><div class="card stat"><b>${a.risk}</b><span>given the right risk (${a.riskOf})</span></div></div>
<p class="small muted">${a.run ? `The run of ${a.run}, every element marked by hand. ` : 'Every element marked by hand. '}<a href="${REPOSITORY}/blob/main/reports/accuracy-scored.md">Both runs, scored</a>.</p>`
    : a?.kind === 'automatic'
      ? html`<div class="grid"><div class="card stat"><b>${pct(a.resolved, a.elements)}</b><span>of ${a.elements} fields and buttons on ${a.forms} forms found again on the live page by their map</span></div>${a.agreement.map(
          (g) => html`<div class="card stat"><b>${g.pct}</b><span>agreement on risk between two models (Muse Spark and Muse Spark Open), ${g.of} elements on ${g.set}</span></div>`,
        )}</div>
<p class="small muted">Whether each meaning is right hasn't been human-checked yet; these are the parts code can check. <a href="${REPOSITORY}/blob/main/reports/accuracy.md">The accuracy report</a>.</p>`
      : ''
}
</section>`;
}

export interface LandingOptions {
  /** The registry's public URL (REGISTRY_PUBLIC_URL). */
  url: string;
  /** Usher's own site key, for the tag on the interest form. */
  siteKey?: string;
  numbers: Numbers;
  /** The forms anyone can map from the "Try it" box. */
  forms?: PickerForm[];
  /** The viewer box: what was pasted, and a reason if it failed. */
  viewer?: { url: string; error: string };
  interest?: { error?: string };
  /** Link the demo site's public dashboard (/demo/dashboard). */
  demo?: boolean;
  /** Offer hosted MCP (/mcp) to assistants, beside the local server for frameworks. */
  hosted?: boolean;
}

/** The six steps under the hood, told to the site that runs the form, and what Usher sees at each. */
const STEPS: { title: string; what: string; sees: string; note?: string }[] = [
  { title: 'Knock', what: 'Your customer\'s agent says who it is before it touches your form, and your site opens for that one session.', sees: 'the agent, your site, what it came to do, when its pass expires.' },
  { title: 'The plan and your rules', what: 'Usher hands the agent your form\'s plan: every field by meaning, in order, with where to find it, and your rules, so it fills by meaning, not by guessing.', sees: 'field names and types. Never what anyone types.' },
  { title: 'The agent fills the safe fields from the plan', what: 'Name, date of birth, postcode, cover level: the fields you let agents fill, typed in the agent\'s own browser from the plan, in seconds.', sees: 'which fields were filled. Not the values.' },
  { title: 'The questions you keep for people', what: 'You choose which questions only a person may answer: smoking, the declaration, medical history, any you like. Usher puts them to your customer in your exact words, unticked, never answered by their agent.', note: 'Or let an agent fill one from what your customer said: Usher still shows it back to them to confirm.', sees: 'that each was shown, and your customer\'s yes or no.' },
  { title: 'The agent submits with the token', what: 'Your server checks the agent\'s token before it quotes. No token, no quote.', sees: 'that a quote was asked for, with a valid token.' },
  { title: 'On your record', what: 'Your dashboard shows every session: which agent, which fields, what your customer was shown and what they confirmed.', sees: 'the session. Never the answers.' },
];

/**
 * What your customer sees, and the rails underneath: one section, two panes playing in step. On the
 * left, a native Brightwater experience in the customer's assistant, with no Usher in sight (a plain window of our own, no product's interface, with
 * the MCP Apps cards' own markup from cards.ts, drawn rather than live): their message, a line saying
 * it's working,
 * the decision card they tick (in Brightwater's name), the quote. On the right, what happens underneath: Brightwater's app
 * runs on Usher's rails, and the six steps stream in, each with what Usher sees. As Usher knocks the
 * assistant says it's working; at the questions that are the person's the card arrives and they tick it; the quote lands
 * with the last step. What Usher keeps sits under both. Everything is in the page in reading order;
 * site.js only plays it (reached steps as r1…r6 on the container), and without it, or with reduced
 * motion, the last frame shows.
 */
function howSection(url: string, hosted: boolean): Raw {
  // Brightwater's own site, by name: the demo is hosted beside Usher, but a real site isn't.
  const host = "Brightwater's site · ";
  const tick = html`<span class="box" aria-hidden="true"></span>`;
  const you = html`<span class="by-you">you</span>`;
  return html`<section class="between" id="how" data-reveal>
<h2>What your customer sees, and the rails underneath</h2>
<p class="lede">In their assistant, your customer gets Brightwater Insurance: your app, your words, your quote, with no Usher in sight. Underneath, it runs on Usher's rails, the infrastructure between assistants and your forms. Both sides, at the same moment.</p>
<div class="views seq" data-steps>
<div class="view" id="assistant"><h3 class="view-label">What your customer sees <span>A native Brightwater Insurance experience</span></h3>
<figure class="assistant uc" aria-label="Illustration: a customer gets a health insurance quote from Brightwater Insurance's app in their assistant" inert>
<div class="assistant-window" aria-hidden="true"></div>
<div class="assistant-bar"><span class="assistant-name">Your assistant</span><span class="assistant-tag">Brightwater Insurance app connected</span></div>
<div class="step person"><p class="bubble">${EXAMPLE}</p></div>
<div class="step said s-working"><p class="working"><span class="spinner" aria-hidden="true"></span>Getting your quote from Brightwater Insurance…</p></div>
<div class="step said s-decision">
<p class="callout"><b>Only with Usher</b> Your customer decides, in your words. Their assistant can't answer for them.</p>
<div class="card decision"><p class="label">Brightwater Insurance</p><p class="title">Before we get your quote</p><p class="where">${host}/health/declaration</p><p class="asking">Brightwater is asking you, not your assistant</p>
<div class="row"><span class="verbatim">Have you smoked or used nicotine products in the last 12 months?<span class="tag req">confirm</span></span><p class="said">You said: <b>No</b></p><div class="t1"><div class="yesno"><span class="radio on"></span> That's right <span class="radio"></span> Not right${you}</div></div></div>
<div class="row"><span class="check t2">${tick}<span class="verbatim">I confirm the information I have given is true and complete, and I understand that my medical history will be asked about after the quote<span class="tag req">required</span></span>${you}</span></div>
<div class="row"><span class="check t3">${tick}<span>Yes, press <b>“Get my quote”</b> for me</span>${you}</span><p class="disclosure">By selecting Get my quote you agree that Brightwater may use these answers to work out your price. Medical history is not asked here: Brightwater asks you about it after the quote. This is a demo site: nothing is bought.</p></div>
<span class="button confirm">Confirm</span>
</div>
</div>
<div class="step said s-result">
<div class="card"><p class="label">Brightwater Insurance</p><p class="title">Your quote</p><p class="where">${host}/health/result</p><p class="outcome ok">Completed</p>
<ul class="facts"><li class="verbatim">£66.91 a month</li><li class="verbatim">Quote reference BWH-3F9A2C71</li><li class="verbatim">This quote is valid for 30 days.</li></ul>
<p class="note"><span class="link">Open the page</span> · as the site shows it, word for word</p></div>
</div>
</figure>
</div>
<div class="view"><h3 class="view-label">Under the hood <span>The Usher rails, for you</span></h3>
<div class="hood">
<p class="tool-head"><span class="tool-icon" aria-hidden="true"></span>Using Brightwater Insurance<span class="runs-on">runs on Usher</span></p>
<ol class="route" aria-label="The route your request takes"><li>Your assistant</li><li>Brightwater's app</li><li class="usher"><span>Usher</span></li><li>Brightwater's site</li></ol>
<ol class="seq-steps">${STEPS.map(
    (st, i) => html`<li data-step="${String(i + 1)}"><h3><span class="n">${String(i + 1)}</span> ${st.title}</h3><p>${st.what}</p>${st.note ? html`<p class="note">${st.note}</p>` : ''}<p class="sees"><b>Usher sees:</b> ${st.sees}</p></li>`,
  )}</ol>
<p class="seq-controls"><button type="button" class="seq-replay" hidden>Replay</button></p>
</div>
</div>
</div>
<div class="keeps" id="keeps"><h3>${KEEPS_HEADING}</h3><ul>${KEEPS.map((line) => html`<li>${line}</li>`)}</ul></div>
${hosted ? html`<p class="small muted assistant-note">Add ${url}/mcp to any assistant that speaks MCP. Shown on Muse Spark through the Meta Model API. Works in Claude, ChatGPT, Cursor and any MCP client; cards where the client supports MCP Apps, plain text everywhere else.</p>` : ''}
</section>`;
}

/** The hero ticket's stub: the health journey's benchmark, or the car journey's, or nothing measured yet. */
function heroTimes(numbers: Numbers): Raw {
  const row = numbers.benchmark.rows.find((r) => r.journey === HEALTH_JOURNEY) ?? numbers.benchmark.rows.find((r) => r.journey === CAR_JOURNEY);
  return row ? html`Filled in ${row.maps.time.toFixed(1)} s<br>instead of ${String(Math.round(row.reading.time))} s` : html`Filled in seconds`;
}

export function landingPage(o: LandingOptions): string {
  const tag = `<script src="${o.url}/usher.js"\n        data-usher-registry="${o.url}"\n        data-usher-site-key="usp_your_site_key" defer></script>`;
  const mcp = JSON.stringify({ mcpServers: { usher: { command: 'npx', args: ['-y', '@usher-run/mcp'], env: { USHER_REGISTRY_URL: o.url } } } }, null, 2);
  const description = DESCRIPTION;
  const [first, ...rest] = SENTENCE.split('. ');
  const body = html`<section class="hero">
<div class="hero-copy">
<p class="label">An open protocol for web forms</p>
<h1>${first}. <em>${rest.join('. ')}</em></h1>
<p class="lede">${POSITIONING}</p>
<p class="actions"><a class="button" href="/sites/new">Get your keys</a><a class="button ghost" href="#agents">Connect an agent</a></p>
</div>
<aside class="ticket" aria-label="An example of what an agent receives when it knocks">
<div class="ticket-main">
<p class="label">Admit one agent</p>
<p class="ticket-title">Health insurance quote</p>
<dl>
<div><dt>Agent</dt><dd>key 7f3a…c21, signed</dd></div>
<div><dt>Map</dt><dd>3 pages, every field by meaning</dd></div>
<div><dt>House rules</dt><dd>Ask the person before submitting. Five quotes an hour.</dd></div>
<div><dt>Valid</dt><dd>10 minutes, this site only</dd></div>
</dl>
</div>
<div class="ticket-stub"><span class="label">No.</span><b>0042</b><span>${heroTimes(o.numbers)}</span></div>
</aside>
</section>

${howSection(o.url, Boolean(o.hosted))}


${o.forms?.length ? html`<section id="try" data-reveal><h2>Try it</h2>
<p class="lede">Pick a form and see its map: what each field means and how risky it is to act on. Usher reads structure, never anything typed, and nothing is submitted.</p>
${o.viewer ? html`<div class="card error">${o.viewer.error}</div>` : ''}
${pickerButtons(o.forms, 'home')}
<p class="small muted">Maps are cached and refreshed by Usher's keeper; nothing is submitted to any of these sites.</p>
<p class="small muted">Run a site? <a href="/dashboard">Sign in</a> and map any page on it.</p>
</section>` : ''}

<section class="grid two" id="start" data-reveal>
<div class="card"><p class="label">For sites</p><h2>Your forms in every assistant, under your rules.</h2>
<p class="lede">One tag, no integration.</p>
<p>Looma, the team behind Usher, sets it up with you: <a href="#interest">tell us about your site</a>.</p>
<pre class="wrap">${tag}</pre>
${siteClaims()}
<p><a class="button" href="/sites/new">Get your keys</a></p>
<p class="small muted">Then lock the actions that matter (getting a quote, sending a message) on your server, with <a href="${REPOSITORY}/tree/main/packages/site-middleware">one check</a>.</p></div>
<div class="card" id="agents"><p class="label">For agents</p><h2>Usher gives you the plan and the rules; you drive.</h2>
<p class="lede">No signup. Your agent's key is its identity.</p>
${o.hosted
  ? html`<pre class="wrap">${o.url}/mcp</pre>
<p>Ask for the plan, ask your user once, then fill in your own browser and stop where the rules say.</p>
<p class="small muted">For example, Brightwater Insurance's health quote:</p>
<pre class="wrap">get_plan({ url: "https://brightwater.usher.run/health/about" })
prepare_run({ url, values: { "person.first_name": "Sam", … }, confirmed: ["consent.declaration", "form.submit"] })
// open entry_url, fill by key, stop at each stop</pre>
<p class="small muted">No browser? <code>usher_fill</code> fills the form for you instead.</p>
<details class="local"><summary>Running your own agent or framework?</summary>
<pre>${mcp}</pre>
<p class="small muted">The local server acts on any site, with your own key. <a href="${REPOSITORY}/blob/main/docs/hosted-mcp.md">Setup for each assistant</a>.</p>
</details>
<p><a href="#assistant">See it inside an assistant</a>.</p>`
  : html`<pre>${mcp}</pre>
<p><code>get_plan</code> gives you the journey and the rules; <code>prepare_run</code> puts your user's answers in the site's own form; you fill and stop where the rules say.</p>`}
${o.demo ? html`<p><a class="button ghost" href="/demo/dashboard">See the site's view</a></p><p class="small muted">The demo quote site's live dashboard: run the plan on it and your agent's session appears there, step by step.</p>` : ''}</div>
</section>

${numbersSection(o.numbers)}

<section id="interest" data-reveal><h2>I run a site with forms</h2>
${o.interest?.error ? html`<div class="card error">${o.interest.error}</div>` : ''}
<form class="card stack" method="post" action="/interest">
<label>Your site<input type="url" name="site" required placeholder="https://www.example.com"></label>
<label>Email<input type="email" name="email" required autocomplete="email"></label>
<label>Anything else? <span class="muted small">(optional)</span><input type="text" name="note" maxlength="200"></label>
<button type="submit">Tell me more</button>
<p class="small muted">This form is agent-ready too: it carries the Usher tag, and an agent filling it for you knocks first.</p>
</form>
<p class="small muted">We use your details only to reply to you. <a href="/privacy">Privacy</a>.</p>
</section>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Usher: the front door for AI agents on web forms</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(o.url)}/">
<meta property="og:title" content="Usher: the front door for AI agents on web forms">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(o.url)}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${FAVICON}">
<style>${LANDING_STYLE}</style>
<script src="/site.js" defer></script>
${o.siteKey ? `<script src="${esc(o.url)}/usher.js" data-usher-registry="${esc(o.url)}" data-usher-site-key="${esc(o.siteKey)}" defer></script>\n` : ''}</head>
<body>
<header class="top"><div class="inner"><a class="brand" href="/">Usher</a><nav><a class="wide" href="#how">How it works</a>${o.forms?.length ? '<a href="#try">Try it</a>' : ''}<a class="wide" href="#start">Get started</a><a href="/dashboard">Sign in</a></nav></div></header>
<main>${body}</main>
<footer><div class="inner">
<div class="foot-brand"><a class="brand" href="/">Usher</a><p>The front door for AI agents on web forms. Maps hold structure, never values.</p></div>
<nav>
<a href="/dashboard">Site dashboard</a>
<a href="${REPOSITORY}">GitHub</a>
<a href="/spec/">Specifications</a>
<a href="${REPOSITORY}/blob/main/docs/security.md">Security</a>
<a href="/privacy">Privacy</a>
</nav>
${LOOMA_FOOTER}
</div></footer>
</body>
</html>`;
}

const LANDING_STYLE = `
${THEME}
section { margin:0 0 56px; }
${PICKER_STYLE}
/* Sections settle into place as they come near (site.js). Content is always present and fully
   visible: only position moves, so pages without JavaScript and screenshots see everything. */
${CARD_CSS}
[data-reveal] { transition:transform 240ms ease-out; }
html.reveal [data-reveal]:not(.shown) { transform:translateY(16px); }
@media (prefers-reduced-motion: reduce) { [data-reveal] { transition:none; } html.reveal [data-reveal]:not(.shown) { transform:none; } }
main { padding-top:0; }
.hero { display:grid; grid-template-columns:minmax(0,1.3fr) minmax(0,1fr); gap:56px; align-items:center; padding:56px 0 44px; border-bottom:1px solid var(--rule); margin-bottom:44px; }
@media (max-width:880px) { .hero { grid-template-columns:1fr; gap:40px; padding-top:36px; padding-bottom:48px; } }
.hero h1 { font-size:clamp(36px, 5.6vw, 64px); margin:14px 0 20px; max-width:17ch; }
.hero h1 em { font-style:italic; font-weight:600; color:var(--accent); }
.hero .lede { font-size:20px; margin:0 0 28px; }
.actions { display:flex; gap:12px; flex-wrap:wrap; margin:0; }
.ticket { display:grid; grid-template-columns:minmax(0,1fr) 112px; background:var(--card); border:1.5px solid var(--rule); transform:rotate(-1.5deg); max-width:470px; justify-self:center; position:relative; }
.ticket::before, .ticket::after { content:""; position:absolute; right:104px; width:18px; height:18px; border-radius:50%; background:var(--bg); border:1.5px solid var(--rule); }
.ticket::before { top:-10px; clip-path:inset(50% 0 0 0); } .ticket::after { bottom:-10px; clip-path:inset(0 0 50% 0); }
.ticket-main { padding:22px 22px 20px; }
.ticket-title { font-family:var(--serif); font-size:26px; font-weight:700; line-height:1.15; margin:4px 0 14px; }
.ticket dl { margin:0; display:grid; gap:8px; }
.ticket dl div { display:grid; grid-template-columns:96px 1fr; gap:10px; border-top:1px dotted var(--line); padding-top:8px; }
.ticket dt { font-size:11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); padding-top:3px; }
.ticket dd { margin:0; font-size:14.5px; line-height:1.45; }
.ticket-stub { border-left:1.5px dashed var(--rule); padding:22px 12px; display:flex; flex-direction:column; align-items:center; justify-content:space-between; text-align:center; gap:8px; }
.ticket-stub b { font-family:var(--serif); font-size:30px; writing-mode:vertical-rl; transform:rotate(180deg); letter-spacing:.06em; }
.ticket-stub span:last-child { font-size:12px; color:var(--muted); line-height:1.35; }
@media (max-width:480px) { .ticket { grid-template-columns:1fr; transform:none; } .ticket::before, .ticket::after { display:none; } .ticket-stub { border-left:0; border-top:1.5px dashed var(--rule); flex-direction:row; padding:12px 22px; } .ticket-stub b { writing-mode:horizontal-tb; transform:none; } .ticket dl div { grid-template-columns:1fr; gap:2px; } }
/* What your customer sees, and the rails underneath: two panes side by side, always dark like an
   assistant, playing in step (site.js marks the steps reached as r1…r6 on .views). */
.between .lede { max-width:64ch; }
.views { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:28px; align-items:start; margin-top:22px; }
.view-label { font-family:var(--serif); font-size:20px; margin:0 0 10px; }
.view-label span { display:block; font-family:Inter,system-ui,sans-serif; font-size:12px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--accent); margin-top:2px; }
/* The customer's side: a plain assistant window of our own (no product's interface). */
.assistant { ${CARD_DARK} margin:0; background:var(--bg); color:var(--ink); border:1.5px solid var(--line); border-radius:16px; overflow:hidden; font-size:15px; line-height:1.5; box-shadow:0 24px 60px -30px rgba(18,19,44,.55); }
.assistant-window { display:none; }
.assistant-bar { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px 18px; border-bottom:1px solid var(--line); background:var(--card); }
.assistant-name { font-weight:600; font-size:14px; }
.assistant-tag { font-size:12px; font-weight:600; color:var(--safe); background:var(--safe-bg); padding:3px 10px; border-radius:999px; }
.assistant > .step { padding:9px 18px; min-width:0; }
.assistant > .person { display:flex; justify-content:flex-end; padding-top:18px; }
.assistant .bubble { margin:0; max-width:88%; padding:10px 14px; background:var(--accent); color:#12132c; border:0; border-radius:18px 18px 4px 18px; font-weight:500; }
.assistant .working { margin:0; font-size:14px; color:var(--muted); display:flex; align-items:center; gap:9px; }
.spinner, .tool-icon { width:14px; height:14px; border-radius:50%; border:2px solid var(--accent); border-right-color:transparent; display:inline-block; flex:none; }
.s-result { padding-bottom:20px !important; }
.assistant .card { border-radius:12px; }
/* Drawn boxes: the illustration is a picture. */
.assistant .check { display:flex; gap:10px; align-items:flex-start; }
.assistant .box { flex:none; width:18px; height:18px; margin-top:3px; border:1.5px solid var(--muted); border-radius:3px; display:inline-grid; place-items:center; }
.assistant .box::after { content:"✓"; font-size:13px; font-weight:800; line-height:1; color:var(--card); }
.assistant .check .box { background:var(--accent); border-color:var(--accent); }
.assistant .by-you { margin-left:auto; padding-left:8px; font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--accent); white-space:nowrap; }
.assistant .radio { display:inline-block; width:14px; height:14px; border:1.5px solid var(--muted); border-radius:50%; vertical-align:-2px; }
.assistant .radio.on { border:4px solid var(--accent); }
.assistant .yesno { align-items:center; gap:6px; }
.assistant .yesno .by-you { margin-left:auto; }
.assistant .confirm { display:inline-block; margin-top:12px; background:var(--rule); color:var(--card); font-weight:600; padding:10px 18px; border:0; border-radius:8px; }
.assistant .link { text-decoration:underline; text-decoration-color:var(--accent); text-underline-offset:3px; }
.assistant-note { max-width:760px; margin:14px 0 0; }
details.local { margin:4px 0 14px; } details.local summary { cursor:pointer; font-weight:600; } details.local pre { margin-top:10px; }
/* The rails: Brightwater's app on Usher, the route, the six steps. */
.hood { ${CARD_DARK} background:var(--bg); color:var(--ink); border:1.5px solid var(--line); border-radius:16px; padding:16px 18px 10px; box-shadow:0 24px 60px -30px rgba(18,19,44,.55); }
.tool-head { margin:0 0 10px; font-size:13px; font-weight:600; color:var(--muted); display:flex; align-items:center; gap:8px; }
.seq.ended .tool-icon, .seq:not(.seq-on) .tool-icon { border-color:var(--safe); }
.runs-on { margin-left:6px; font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--accent); border:1px solid var(--accent); border-radius:999px; padding:1px 8px; }
ol.route { list-style:none; margin:0 0 12px; padding:0; display:flex; flex-wrap:wrap; align-items:center; gap:6px 0; font-size:12.5px; }
.route li { display:flex; align-items:center; color:var(--muted); }
.route li + li::before { content:""; width:26px; height:2px; margin:0 6px; background:linear-gradient(90deg, var(--line) 0 40%, var(--accent) 40% 60%, var(--line) 60% 100%) 0 0 / 300% 100%; }
.seq.seq-on:not(.ended) .route li + li::before { animation:flow 1.2s linear infinite; }
.route li.usher span { color:#12132c; background:var(--accent); font-weight:700; padding:2px 10px; border-radius:999px; box-shadow:0 0 0 3px rgba(197,163,255,.18); }
ol.seq-steps { list-style:none; margin:0; padding:4px 14px; background:var(--card); border:1px solid var(--line); border-radius:12px; }
.seq-steps li { position:relative; padding:12px 0 12px 40px; border-top:1px dotted var(--line); transition:opacity 450ms ease-out, transform 450ms ease-out; }
.seq-steps li:first-child { border-top:0; }
.seq-steps li::before { content:""; position:absolute; left:12px; top:38px; bottom:-14px; width:2px; background:var(--line); }
.seq-steps li::after { content:""; position:absolute; left:12px; top:38px; width:2px; height:0; background:var(--accent); transition:height 700ms ease-out; }
.seq-steps li:last-child::before, .seq-steps li:last-child::after { display:none; }
.seq-steps li.done::after, .seq:not(.seq-on) .seq-steps li::after { height:calc(100% - 24px); }
.seq-steps h3 { font-family:var(--serif); font-size:17.5px; line-height:1.25; margin:0 0 4px; color:var(--ink); }
.seq-steps .n { position:absolute; left:0; top:11px; width:26px; height:26px; border-radius:50%; display:grid; place-items:center; font:700 12.5px Inter,system-ui,sans-serif; color:var(--accent); background:var(--bg); border:1.5px solid var(--accent); padding:0; margin:0; transition:background-color 300ms, color 300ms; }
button.n { cursor:pointer; }
button.n:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.seq-steps p { margin:0 0 6px; font-size:14px; color:var(--ink); }
.seq-steps .note { font-weight:600; color:var(--user); }
.seq-steps .sees { display:inline-block; margin:2px 0 0; font-size:12.5px; color:var(--muted); background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:3px 11px 3px 10px; }
.seq-steps .sees b { color:var(--safe); font-weight:700; }
.seq-steps li.done .n, .seq:not(.seq-on) .seq-steps .n { background:var(--accent); color:#12132c; }
.seq-controls { margin:10px 0 4px; }
.seq-replay[hidden] { display:none; }
.seq-replay { font:inherit; font-size:13px; font-weight:600; background:none; color:var(--ink); border:1px solid var(--line); border-radius:999px; padding:5px 14px; cursor:pointer; }
/* Playing: on the rails, steps not reached wait faded and lowered, the one in play pulses and
   shimmers. On the customer's side, in step: working while Usher knocks and fills; the card at the
   questions that are theirs, ticked one by one; Confirm at the submit; the quote with the record. */
.seq.seq-on .seq-steps li { opacity:.22; transform:translateY(6px); }
.seq.seq-on .seq-steps li.on, .seq.seq-on .seq-steps li.done { opacity:1; transform:none; }
.seq.seq-on .seq-steps li.on .n { animation:pulse 1.2s ease-out infinite; }
.seq.seq-on .seq-steps li.on h3 { background:linear-gradient(90deg, var(--ink) 0%, var(--accent) 50%, var(--ink) 100%) 0 0 / 200% 100%; -webkit-background-clip:text; background-clip:text; color:transparent; animation:shimmer 1.6s linear infinite; }
.seq.seq-on .tool-icon, .seq.seq-on:not(.r4) .spinner { animation:spin .9s linear infinite; }
.seq.seq-on.ended .tool-icon { animation:none; }
.assistant .step, .assistant .box, .assistant .by-you, .assistant .confirm, .assistant .radio { transition:opacity 450ms ease-out, transform 450ms ease-out, background-color 250ms ease-out, border-color 250ms ease-out, border-width 250ms ease-out; }
.seq.seq-on:not(.r1) .s-working, .seq.seq-on:not(.r4) .s-decision, .seq.seq-on:not(.ended) .s-result { opacity:.15; transform:translateY(8px); }
.seq.seq-on:not(.r4) .check .box { background:transparent; border-color:var(--muted); }
.seq.seq-on:not(.r4) .box::after, .seq.seq-on:not(.r4) .by-you { opacity:0; }
.seq.seq-on:not(.r4) .radio.on { border-width:1.5px; }
.seq.r4 .t1 .radio, .seq.r4 .t1 .by-you { transition-delay:500ms; }
.seq.r4 .t2 .box, .seq.r4 .t2 .box::after, .seq.r4 .t2 .by-you { transition-delay:1000ms; }
.seq.r4 .t3 .box, .seq.r4 .t3 .box::after, .seq.r4 .t3 .by-you { transition-delay:1500ms; }
.seq.seq-on:not(.r5) .confirm { opacity:.45; }
/* The decision card, the one thing no other way of filling forms gives: picked out with an
   annotation for the reader (outside the app's own card) and a glow that lights up when the rails
   reach the questions that are the customer's. */
.assistant .callout { margin:8px 0 10px; font-size:13px; color:var(--ink); display:flex; flex-wrap:wrap; gap:4px 8px; align-items:baseline; }
.assistant .callout b { font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:#12132c; background:var(--accent); padding:2px 9px; border-radius:999px; }
.assistant .card.decision { border:2px solid var(--accent); box-shadow:0 0 0 5px rgba(197,163,255,.14), 0 18px 40px -18px rgba(197,163,255,.45); }
.seq.seq-on.r4:not(.r5) .card.decision { animation:glow 1.6s ease-in-out infinite; }
.seq-steps li[data-step="4"] { background:linear-gradient(90deg, rgba(197,163,255,.10), transparent 70%); margin:0 -14px; padding-left:54px; padding-right:14px; }
.seq-steps li[data-step="4"] .n { left:14px; }
.seq-steps li[data-step="4"]::before, .seq-steps li[data-step="4"]::after { left:26px; }
@keyframes glow { 50% { box-shadow:0 0 0 9px rgba(197,163,255,.24), 0 18px 48px -14px rgba(197,163,255,.6); } }
@keyframes pulse { 0% { box-shadow:0 0 0 0 rgba(197,163,255,.6); } 100% { box-shadow:0 0 0 12px rgba(197,163,255,0); } }
@keyframes shimmer { to { background-position:-200% 0; } }
@keyframes spin { to { transform:rotate(360deg); } }
@keyframes flow { from { background-position:100% 0; } to { background-position:-50% 0; } }
.keeps { margin:28px 0 0; padding:20px 22px; border:1.5px solid var(--rule); background:var(--card); max-width:760px; }
.keeps h3 { font-family:var(--serif); font-size:22px; margin:0 0 10px; }
.keeps ul { margin:0; padding-left:20px; }
.keeps li { margin:8px 0; }
@media (prefers-reduced-motion: reduce) { .seq *, .seq *::before, .seq *::after { transition:none !important; animation:none !important; } }
@media (max-width:900px) { .views { grid-template-columns:minmax(0,1fr); } }
@media (max-width:480px) { .assistant > .step { padding:8px 12px; } .hood { padding:14px 12px 8px; } ol.seq-steps { padding:4px 10px; } }
.grid.three { grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); }
.grid.two { grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); align-items:start; }
.grid:not(.two):not(.three) { grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); }
.stat { border-top:3px solid var(--ink); }
.stat b { display:block; font-family:var(--serif); font-size:44px; font-weight:700; line-height:1.1; color:var(--ink); }
.stat span { color:var(--muted); font-size:15px; }
@media (max-width:640px) { table, tbody, tr, td { display:block; } thead { display:none; } tr { padding:8px 0; border-bottom:1px solid var(--line); } td { border:0; padding:2px 0; } td[data-label]::before { content:attr(data-label) ": "; color:var(--muted); } }
form.stack { display:flex; flex-direction:column; gap:18px; max-width:560px; }
form.stack label { display:flex; flex-direction:column; gap:2px; font-weight:600; font-size:14px; }
form.stack input { min-width:0; }
form.inline input[type=url] { flex:1 1 240px; }
pre.wrap { white-space:pre-wrap; word-break:break-word; }
`;
