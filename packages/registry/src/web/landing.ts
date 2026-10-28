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
  /** The demo site's origin, for the assistant illustration's addresses. */
  demoOrigin?: string;
}

/**
 * "Inside the assistant": an illustrated conversation with an assistant built on Muse Spark, in a
 * plain window of our own (no product's interface), with three short steps beside the cards they
 * explain. The cards are the MCP Apps cards' own markup and styles (cards.ts). The illustration's
 * boxes are drawn, not inputs: it is a picture. Nothing consequential starts ticked; "you" tick the
 * declaration and Get my quote, Confirm lights up, and the result follows. site.js plays that in
 * order once the section is in view; without it (or with reduced motion) the last frame shows, with
 * the ticks marked as yours. One grid: the window spans the left column, each step sits in the row
 * of its card, and on a phone each step falls under its card.
 */
function assistantSection(url: string, demoOrigin = 'https://brightwater.example'): Raw {
  const host = new URL(demoOrigin).host;
  const tick = html`<span class="box" aria-hidden="true"></span>`;
  const you = html`<span class="by-you">you</span>`;
  return html`<section id="assistant" data-reveal><h2>Inside the assistant</h2>
<p class="lede">Add ${url}/mcp to any assistant that speaks MCP. Here, one built on Muse Spark asks for a quote. Usher does the rest, and the person decides.</p>
<figure class="assistant uc" aria-label="Illustration: an assistant built on Muse Spark gets a health insurance quote through Usher" inert data-sequence>
<div class="assistant-window" aria-hidden="true"></div>
<div class="assistant-bar"><span class="assistant-name">An assistant built on Muse Spark</span><span class="assistant-tag">Illustration</span></div>
<div class="step person"><p class="bubble">${EXAMPLE}</p></div>
<div class="step said s-ticket">
<div class="card ticket"><div class="ticket-main"><p class="label">Admit one agent</p><p class="title">Health insurance quote</p><p class="where">${host}/health/about</p><dl>
<div><dt>Agent</dt><dd>key 7f3a…c21, signed</dd></div>
<div><dt>Map</dt><dd>3 pages, every field by meaning</dd></div>
<div><dt>House rules</dt><dd>Ask the person before submitting. Five quotes an hour.</dd></div>
<div><dt>Valid</dt><dd>10 minutes, this site only</dd></div>
</dl></div><div class="stub"><span class="label">No.</span><b>0042</b><span>session</span></div></div>
</div>
<div class="explain e-ticket"><h3><span>1</span> The agent knocks</h3><p>Usher checks who it is, hands it the map and the house rules, and a pass that lasts ten minutes.</p></div>
<div class="step said s-decision">
<div class="card"><p class="label">Your decision</p><p class="title">Before Usher goes on</p><p class="where">${host}/health/declaration</p><p class="asking">Usher is asking you, not the agent</p>
<div class="row"><span class="verbatim">Have you smoked or used nicotine products in the last 12 months?<span class="tag req">confirm</span></span><p class="said">You said: <b>No</b></p><div class="t1"><div class="yesno"><span class="radio on"></span> That's right <span class="radio"></span> Not right${you}</div></div></div>
<div class="row"><span class="check t2">${tick}<span class="verbatim">I confirm the information I have given is true and complete, and I understand that my medical history will be asked about after the quote<span class="tag req">required</span></span>${you}</span></div>
<div class="row"><span class="check t3">${tick}<span>Yes, press <b>“Get my quote”</b> for me</span>${you}</span><p class="disclosure">By selecting Get my quote you agree that Brightwater may use these answers to work out your price. Medical history is not asked here: Brightwater asks you about it after the quote. This is a demo site: nothing is bought.</p></div>
<span class="button confirm">Confirm</span>
</div>
</div>
<div class="explain e-decision"><h3><span>2</span> You decide</h3><p>The site's own words, your tick. Usher never answers for you. Your medical history isn't asked: the insurer asks you after the quote.</p></div>
<div class="step said s-result">
<div class="card"><p class="label">Usher</p><p class="title">Your quote</p><p class="where">${host}/health/result</p><p class="outcome ok">Completed</p>
<ul class="facts"><li class="verbatim">£66.91 a month</li><li class="verbatim">Quote reference BWH-3F9A2C71</li><li class="verbatim">This quote is valid for 30 days.</li></ul>
<p class="note"><span class="link">Open the page</span> · as the site shows it, word for word</p></div>
</div>
<div class="explain e-result"><h3><span>3</span> Done, on the record</h3><p>The result as the site shows it. The site sees every action by meaning. Your details are never stored.</p></div>
</figure>
<p class="small muted assistant-note">Shown on Muse Spark through the Meta Model API. Works in Claude, ChatGPT, Cursor and any MCP client; cards where the client supports MCP Apps, plain text everywhere else.</p>
</section>`;
}

/** The six steps between the person's message and their quote, and what Usher sees at each. */
const STEPS: { title: string; what: string; sees: string; note?: string }[] = [
  { title: 'Knock', what: 'The agent identifies itself; the site opens for this one session.', sees: 'agent identity, site, intent, expiry.' },
  { title: 'Map, not values', what: 'Usher hands the agent the form\'s structure and the site\'s rules.', sees: 'field names and types. Never what anyone types.' },
  { title: 'The safe fields are filled', what: 'Name, date of birth, postcode, cover level: seconds.', sees: 'which fields were filled. Not the values.' },
  { title: 'The questions that are yours', what: 'Smoker, the declaration: shown to you in the insurer\'s exact words, unticked, with Usher asking you, not the agent.', sees: 'that each was shown to you, and your yes or no.', note: 'Medical history is never Usher\'s to fill: the insurer asks you that directly, after the quote.' },
  { title: 'Submit with the token', what: 'The site checks it on its own server. No token, no quote.', sees: 'that the quote was asked for, with a valid token.' },
  { title: 'On the record', what: 'The site\'s dashboard shows the session: which agent, which fields, what was shown and confirmed.', sees: 'the session. Never the answers.' },
];

/**
 * "What happens in between": the six steps between the person's message (an assistant window) and
 * the quote (the result card), each with what Usher sees, then what Usher keeps. All of it is in the
 * page in reading order; site.js plays the steps once in view (each in turn, a thin line between
 * them), rests on the last frame with all six shown, and lets a step be picked or the whole replayed.
 * With reduced motion, or without JavaScript, all six show at once.
 */
function betweenSection(): Raw {
  return html`<section class="between" id="how" data-reveal>
<h2>What happens in between</h2>
<p class="lede">From your message to your quote. What Usher sees at each step is underneath it.</p>
<figure class="seq" data-steps>
<div class="seq-ask"><p class="label">You, to your assistant</p><p class="bubble">${EXAMPLE}</p></div>
<div class="seq-track" aria-hidden="true"><svg viewBox="0 0 100 4" preserveAspectRatio="none" focusable="false"><line class="rail" x1="0" y1="2" x2="100" y2="2"></line><line class="fill" x1="0" y1="2" x2="100" y2="2" pathLength="100"></line></svg></div>
<ol class="seq-steps">${STEPS.map(
    (st, i) => html`<li data-step="${String(i + 1)}"><h3><span class="n">${String(i + 1)}</span> ${st.title}</h3><p>${st.what}</p>${st.note ? html`<p class="note">${st.note}</p>` : ''}<p class="sees"><b>Usher sees:</b> ${st.sees}</p></li>`,
  )}</ol>
<div class="seq-result uc"><div class="card"><p class="label">The site's own result</p><p class="title">Your quote</p><ul class="facts"><li>£66.91 a month</li><li>Quote reference BWH-3F9A2C71</li></ul></div></div>
<p class="seq-controls"><button type="button" class="seq-replay" hidden>Replay</button></p>
</figure>
<div class="keeps" id="keeps"><h3>${KEEPS_HEADING}</h3><ul>${KEEPS.map((line) => html`<li>${line}</li>`)}</ul></div>
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
<figure class="hero-ask"><figcaption class="label">Ask your assistant</figcaption><p class="bubble">${EXAMPLE}</p></figure>
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

${betweenSection()}

${o.hosted ? assistantSection(o.url, o.demoOrigin) : ''}

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
<div class="card" id="agents"><p class="label">For agents</p><h2>One call fills the form.</h2>
<p class="lede">No signup. Your agent's key is its identity.</p>
${o.hosted
  ? html`<pre class="wrap">${o.url}/mcp</pre>
<p>Hosted Usher acts on sites that have joined.</p>
<p class="small muted">For example, Brightwater's health quote:</p>
<pre class="wrap">usher_fill({ site: "Brightwater", task: "health insurance quote",
  details: "I'm Sam Taylor, born 2 April 1988, WR14 1AA, just me, non-smoker, comprehensive cover with a £250 excess." })</pre>
<details class="local"><summary>Running your own agent or framework?</summary>
<pre>${mcp}</pre>
<p class="small muted">The local server acts on any site, with your own key. <a href="${REPOSITORY}/blob/main/docs/hosted-mcp.md">Setup for each assistant</a>.</p>
</details>
<p><a href="#assistant">See it inside an assistant</a>.</p>`
  : html`<pre>${mcp}</pre>
<p><code>usher_fill</code> takes the form's values by meaning, fills every page in seconds, and stops to ask before anything is submitted.</p>
<pre class="wrap">usher_fill({ site: "Brightwater", task: "health insurance quote",
  details: "I'm Sam Taylor, born 2 April 1988, WR14 1AA, just me, non-smoker, comprehensive cover with a £250 excess." })</pre>`}
${o.demo ? html`<p><a class="button ghost" href="/demo/dashboard">See the site's view</a></p><p class="small muted">The demo quote site's live dashboard: run <code>usher_fill</code> on it and your agent's session appears there, step by step.</p>` : ''}</div>
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
/* Inside the assistant: a plain window of our own, always dark, holding the MCP Apps cards as a
   client shows them (CARD_CSS), with the steps beside them. One grid: the window (a frame behind
   the left column) spans every row; each step shares its card's row. */
${CARD_CSS}
#assistant { --ink-page:var(--ink); --muted-page:var(--muted); --accent-page:var(--accent); }
.assistant { ${CARD_DARK} display:grid; grid-template-columns:minmax(0,600px) minmax(0,1fr); column-gap:44px; margin:22px 0 0; position:relative; font-size:15px; line-height:1.5; }
.assistant-window { grid-column:1; grid-row:1 / 6; background:var(--bg); border:1.5px solid var(--line); }
.assistant > .assistant-bar, .assistant > .step { grid-column:1; position:relative; color:var(--ink); }
.assistant-bar { grid-row:1; display:flex; justify-content:space-between; align-items:baseline; gap:12px; padding:12px 18px; border-bottom:1.5px dashed var(--line); }
.assistant-name { font-family:var(--serif); font-size:17px; font-weight:700; }
.assistant-tag { font-size:11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
.assistant > .step { padding:9px 18px; min-width:0; }
.assistant > .person { grid-row:2; justify-self:end; max-width:82%; padding-top:18px; }
.s-ticket, .e-ticket { grid-row:3; } .s-decision, .e-decision { grid-row:4; } .s-result, .e-result { grid-row:5; }
.s-result { padding-bottom:20px !important; }
.assistant .bubble { margin:0; padding:10px 14px; background:var(--card); border:1px solid var(--line); border-radius:14px 14px 3px 14px; }
/* The ticket at about two-thirds size, so the conversation fits in less height. */
.assistant .ticket { zoom:.7; transform:rotate(-1deg); max-width:470px; }
.assistant .explain { grid-column:2; align-self:center; color:var(--ink-page); max-width:34ch; }
.assistant .explain h3 { font-family:var(--serif); font-size:21px; margin:0 0 4px; display:flex; gap:10px; align-items:baseline; color:var(--ink-page); }
.assistant .explain h3 span { font-size:13px; font-weight:700; color:var(--accent-page); border:1.5px solid currentColor; border-radius:999px; width:24px; height:24px; display:inline-grid; place-items:center; flex:none; font-family:Inter,system-ui,sans-serif; }
.assistant .explain p { margin:0; color:var(--muted-page); font-size:16px; }
/* Drawn boxes: the illustration is a picture. */
.assistant .check { display:flex; gap:10px; align-items:flex-start; }
.assistant .box { flex:none; width:18px; height:18px; margin-top:3px; border:1.5px solid var(--muted); border-radius:3px; display:inline-grid; place-items:center; }
.assistant .box::after { content:"✓"; font-size:13px; font-weight:800; line-height:1; color:var(--card); }
.assistant .check .box { background:var(--accent); border-color:var(--accent); }
.assistant .by-you { margin-left:auto; padding-left:8px; font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--accent); white-space:nowrap; }
.assistant .radio { display:inline-block; width:14px; height:14px; border:1.5px solid var(--muted); border-radius:50%; vertical-align:-2px; }
.assistant .radio.on { border:4px solid var(--accent); }
.assistant .yesno { align-items:center; gap:6px; }
.assistant .confirm { display:inline-block; margin-top:12px; background:var(--rule); color:var(--card); font-weight:600; padding:10px 18px; border:0; }
.assistant .link { text-decoration:underline; text-decoration-color:var(--accent); text-underline-offset:3px; }
.assistant-note { max-width:600px; margin:14px 0 0; }
details.local { margin:4px 0 14px; } details.local summary { cursor:pointer; font-weight:600; } details.local pre { margin-top:10px; }
/* The sequence (site.js): until it plays, the cards after the request wait dimmed (never hidden),
   both boxes are empty and Confirm is greyed; then the ticket, the decision card, your two ticks,
   Confirm and the result come in turn. Without it, the last frame. */
.assistant .step, .assistant .explain, .assistant .box, .assistant .by-you, .assistant .confirm { transition:opacity 450ms ease-out, background-color 250ms ease-out, border-color 250ms ease-out; }
.assistant.waiting .s-ticket, .assistant.waiting .s-decision, .assistant.waiting .s-result, .assistant.waiting .explain { opacity:.3; }
.assistant.waiting .check .box { background:transparent; border-color:var(--muted); }
.assistant.waiting .box::after, .assistant.waiting .by-you { opacity:0; }
.assistant.waiting .radio.on { border-width:1.5px; }
.assistant .radio { transition:border-width 250ms ease-out; }
.assistant .yesno .by-you { margin-left:auto; }
.assistant.waiting .confirm { opacity:.45; }
.assistant.play .s-ticket, .assistant.play .e-ticket { transition-delay:600ms; }
.assistant.play .s-decision, .assistant.play .e-decision { transition-delay:1500ms; }
.assistant.play .t1 .radio, .assistant.play .t1 .by-you { transition-delay:2700ms; }
.assistant.play .t2 .box, .assistant.play .t2 .box::after, .assistant.play .t2 .by-you { transition-delay:3300ms; }
.assistant.play .t3 .box, .assistant.play .t3 .box::after, .assistant.play .t3 .by-you { transition-delay:3900ms; }
.assistant.play .confirm { transition-delay:4400ms; }
.assistant.play .s-result, .assistant.play .e-result { transition-delay:5200ms; }
@media (prefers-reduced-motion: reduce) { .assistant * { transition:none !important; } }
@media (max-width:900px) {
  .assistant { grid-template-columns:minmax(0,1fr); }
  .assistant-window { grid-row:1 / 9; }
  .assistant > .explain { grid-column:1; position:relative; color:var(--ink); padding:0 18px 12px; max-width:none; }
  .assistant .explain h3, .assistant .explain p { color:var(--ink); } .assistant .explain p { color:var(--muted); font-size:14.5px; }
  .s-ticket { grid-row:3; } .e-ticket { grid-row:4; } .s-decision { grid-row:5; } .e-decision { grid-row:6; } .s-result { grid-row:7; } .e-result { grid-row:8; padding-bottom:20px; }
  .s-result { padding-bottom:9px !important; }
}
@media (max-width:480px) { .assistant > .step { padding:8px 12px; } .assistant > .explain { padding:0 12px 12px; } .assistant > .person { max-width:92%; } .assistant .ticket { zoom:.85; transform:none; } }
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
.hero-ask { margin:0 0 28px; max-width:46ch; }
.hero-ask .label { margin:0 0 6px; }
.bubble { margin:0; padding:12px 16px; background:var(--card); border:1px solid var(--line); border-radius:14px 14px 3px 14px; font-size:16px; line-height:1.5; }
/* What happens in between: the message, six steps with a thin line between them, the result. The
   steps are always in the page in reading order; site.js only changes which is emphasised. */
.between .lede { max-width:60ch; }
.seq { margin:22px 0 0; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:18px 28px; }
.seq-ask { grid-column:1; max-width:520px; }
.seq-ask .label, .seq-result .label { margin:0 0 6px; }
.seq-track { grid-column:1 / -1; height:4px; position:relative; }
.seq-track svg { display:block; width:100%; height:4px; overflow:visible; }
.seq-track line { stroke-width:2; }
.seq-track .rail { stroke:var(--line); }
.seq-track .fill { stroke:var(--accent); stroke-dasharray:100; stroke-dashoffset:0; transition:stroke-dashoffset 600ms ease-out; }
ol.seq-steps { grid-column:1 / -1; list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:0; border-top:1.5px solid var(--rule); }
.seq-steps li { padding:16px 16px 18px 0; border-bottom:1px solid var(--line); transition:opacity 400ms ease-out, background-color 400ms ease-out; }
.seq-steps li + li { border-left:1px solid var(--line); padding-left:16px; }
.seq-steps h3 { font-family:var(--serif); font-size:19px; line-height:1.2; margin:0 0 6px; display:flex; gap:10px; align-items:baseline; }
.seq-steps .n { flex:none; font-family:Inter,system-ui,sans-serif; font-size:13px; font-weight:700; color:var(--accent); border:1.5px solid currentColor; border-radius:999px; width:24px; height:24px; display:inline-grid; place-items:center; background:none; padding:0; margin:0; }
button.n { cursor:pointer; }
button.n:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.seq-steps p { margin:0 0 8px; font-size:15px; }
.seq-steps .note { color:var(--ink); font-weight:600; }
.seq-steps .sees { margin:0; font-size:13.5px; color:var(--muted); border-top:1px dotted var(--line); padding-top:8px; }
.seq-steps .sees b { color:var(--ink); font-weight:700; }
.seq-result { grid-column:2; justify-self:end; width:min(100%,360px); }
.seq-result .facts li:first-child { font-family:var(--serif); }
.seq-controls { grid-column:1 / -1; margin:0; }
.seq-replay { font:inherit; font-size:14px; font-weight:600; background:none; color:var(--ink); border:1.5px solid var(--rule); padding:6px 14px; cursor:pointer; }
/* While the steps play (site.js adds seq-on): steps not reached yet wait dimmed, never hidden; the
   one in play is marked; the line fills to it. */
.seq.seq-on li { opacity:.38; }
.seq.seq-on li.done { opacity:1; }
.seq.seq-on li.on { opacity:1; background:var(--card); box-shadow:inset 0 3px 0 var(--accent); }
.seq.seq-on .seq-result { opacity:.38; transition:opacity 400ms ease-out; }
.seq.seq-on.ended .seq-result { opacity:1; }
.keeps { margin:28px 0 0; padding:18px 22px; border:1.5px solid var(--rule); background:var(--card); max-width:760px; }
.keeps h3 { font-family:var(--serif); font-size:21px; margin:0 0 8px; }
.keeps ul { margin:0; padding-left:20px; }
.keeps li { margin:4px 0; }
@media (prefers-reduced-motion: reduce) { .seq * { transition:none !important; } }
@media (max-width:1000px) {
  .seq { grid-template-columns:minmax(0,1fr); }
  .seq-track { display:none; }
  ol.seq-steps { grid-template-columns:minmax(0,1fr); border-top:0; border-left:2px solid var(--line); margin-left:11px; }
  .seq-steps li, .seq-steps li + li { border-left:0; padding:12px 0 14px 20px; position:relative; }
  .seq-steps h3 .n { position:absolute; left:-13px; top:12px; background:var(--bg); }
  .seq-steps h3 { padding-left:12px; }
  .seq.seq-on li.on { box-shadow:inset 3px 0 0 var(--accent); }
  .seq-result { grid-column:1; justify-self:start; }
}
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
