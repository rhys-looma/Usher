// The front page (LU-53): what Usher is, the map viewer inline (when it is on), the two quickstarts, the numbers
// from the committed reports, and an interest form that carries Usher's own script tag.

import { readFile } from 'node:fs/promises';
import { FAVICON, LOOMA_FOOTER, THEME, esc, html, siteClaims, type Raw } from './html.ts';
import type { PickerForm } from './picker.ts';
import { PICKER_STYLE, pickerButtons } from './viewer.ts';
import { CARD_CSS, CARD_DARK } from './cards.ts';

const ROOT = new URL('../../../../', import.meta.url);

export const SENTENCE = 'Usher is the front door for AI agents on web forms. Agents knock, get in fast, and follow the house rules.';
export const SUBLINE = 'More of the web, open to agents.';
/** The meta and OpenGraph description. */
export const DESCRIPTION = 'Usher is the front door for AI agents on web forms: the control layer for sites, one call for agents, no integration required.';
export const REPOSITORY = 'https://github.com/rhys-looma/Usher';

interface BenchmarkRow {
  journey: string;
  reading: { time: number; cost: string };
  maps: { time: number; cost: string };
}

export interface Numbers {
  benchmark: { rows: BenchmarkRow[]; generated?: string };
  /** Human-checked accuracy once anyone has marked the public forms; until then, what code can check. */
  accuracy:
    | { kind: 'reviewed'; keys: string; risk: string; reviewed: number }
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
  const [header, ...lines] = (await read('reports/accuracy-review.csv')).trim().split('\n');
  const cols = header ? csvRow(header) : [];
  const marked = lines.map((l) => Object.fromEntries(csvRow(l).map((v, i) => [cols[i], v.trim().toLowerCase()])) as Record<string, string>).filter((r) => r.category !== 'mock site' && ['y', 'n'].includes(r.key_correct ?? ''));
  if (marked.length) {
    const keys = marked.filter((r) => r.key_correct === 'y').length;
    const risked = marked.filter((r) => ['y', 'n'].includes(r.risk_correct ?? ''));
    accuracy = { kind: 'reviewed', keys: pct(keys, marked.length), risk: risked.length ? pct(risked.filter((r) => r.risk_correct === 'y').length, risked.length) : '–', reviewed: marked.length };
  } else {
    const report = JSON.parse((await read('reports/accuracy.json')) || '{"results":[]}') as { results: { status: string; elements?: number; locators_resolved?: number }[] };
    const ok = report.results.filter((r) => r.status === 'ok');
    const elements = ok.reduce((s, r) => s + (r.elements ?? 0), 0);
    const agreement = [...(await read('reports/classifier-agreement.md')).matchAll(/^- (Mock site|Public forms)[^:]*: ([\d.]+%) of (\d+) elements agree/gm)].map((m) => ({ set: m[1] === 'Mock site' ? 'the demo quote form' : 'public forms', pct: m[2]!, of: Number(m[3]) }));
    if (elements) accuracy = { kind: 'automatic', resolved: ok.reduce((s, r) => s + (r.locators_resolved ?? 0), 0), elements, forms: ok.length, agreement };
  }
  return { benchmark: { rows: [...rows.values()].filter((r) => r.reading.time && r.maps.time), ...(generated && { generated }) }, accuracy };
}

const JOURNEY_NAMES: Record<string, string> = {
  'Mock quote site, 3 steps, submitted': 'A three-step car insurance quote (demo site)',
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
    ? html`<div class="grid"><div class="card stat"><b>${a.keys}</b><span>of fields and buttons given the right meaning, human-checked (${a.reviewed} on public forms)</span></div><div class="card stat"><b>${a.risk}</b><span>given the right risk</span></div></div>`
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
 * plain window of our own (no product's interface). The cards are the MCP Apps cards' own markup and
 * styles (cards.ts), so they look as they do in a client. Everything is on the page without
 * JavaScript; site.js only dims the later steps and brings them up in turn as the section comes
 * into view. The window is inert: it is a picture, not a form.
 */
function assistantSection(url: string, demoOrigin = 'https://brightwater.example'): Raw {
  const host = new URL(demoOrigin).host;
  return html`<section id="assistant" data-reveal><h2>Inside the assistant</h2>
<p class="lede">Add ${url}/mcp to any assistant that speaks MCP. Here, one built on Muse Spark asks for a quote. Usher does the rest, and the person decides.</p>
<figure class="assistant" aria-label="Illustration: an assistant built on Muse Spark gets a car insurance quote through Usher">
<div class="assistant-bar"><span class="assistant-name">An assistant built on Muse Spark</span><span class="assistant-tag">Illustration</span></div>
<div class="assistant-chat uc" inert data-sequence>
<div class="step person"><p class="bubble">Get me a car insurance quote on Brightwater for my details.</p></div>
<div class="step said">
<div class="card ticket"><div class="ticket-main"><p class="label">Admit one agent</p><p class="title">Car insurance quote</p><p class="where">${host}/quote/driver</p><dl>
<div><dt>Agent</dt><dd>key 7f3a…c21, signed</dd></div>
<div><dt>Map</dt><dd>3 pages, every field by meaning</dd></div>
<div><dt>House rules</dt><dd>Ask the person before submitting. Five quotes an hour.</dd></div>
<div><dt>Valid</dt><dd>10 minutes, this site only</dd></div>
</dl></div><div class="stub"><span class="label">No.</span><b>0042</b><span>session</span></div></div>
</div>
<div class="step said">
<div class="card"><p class="label">Your decision</p><p class="title">Before Usher goes on</p><p class="where">${host}/quote/cover</p><p class="asking">Usher is asking you, not the agent</p>
<div class="row"><label class="check"><input type="checkbox" checked tabindex="-1"><span class="verbatim">I confirm the information I have given is true and complete<span class="tag req">required</span></span></label></div>
<div class="row"><span class="verbatim">Send me offers by email (optional)<span class="tag opt">optional</span></span><div class="yesno"><label><input type="radio" name="illustration-marketing" tabindex="-1"> Yes</label><label><input type="radio" name="illustration-marketing" checked tabindex="-1"> No</label></div></div>
<div class="row"><label class="check"><input type="checkbox" checked tabindex="-1"><span>Yes, press <b>“Get my quote”</b> for me</span></label><p class="disclosure">By selecting Get my quote you agree that Brightwater may use these answers to work out your price. This is a demo site: nothing is bought.</p></div>
<button type="button" tabindex="-1">Confirm</button>
</div>
<p class="caption">Usher is asking you, not the agent.</p>
</div>
<div class="step said">
<div class="card"><p class="label">Usher</p><p class="title">Your quote</p><p class="where">${host}/quote/result</p><p class="outcome ok">Completed</p>
<ul class="facts"><li class="verbatim">£308.70 a year</li><li class="verbatim">Quote reference BW-3F9A2C71</li><li class="verbatim">This quote is valid for 30 days.</li></ul>
<p class="note"><a href="#assistant" tabindex="-1">Open the page</a> · as the site shows it, word for word</p></div>
<p class="caption">Every action by meaning, on the site's record. Your details never stored.</p>
</div>
</div>
</figure>
<ul class="assistant-notes small muted">
<li>Shown: an agent on Muse Spark through the Meta Model API. Also works in Claude, ChatGPT, Cursor and any MCP client.</li>
<li>Cards render where the client supports MCP Apps; plain text everywhere else.</li>
<li>Hosted Usher acts only on sites that have joined. The local server acts anywhere, with your own key.</li>
</ul>
</section>`;
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
<p class="lede">${SUBLINE}</p>
<p class="actions"><a class="button" href="/sites/new">Get your keys</a><a class="button ghost" href="#start">Connect an agent</a></p>
</div>
<aside class="ticket" aria-label="An example of what an agent receives when it knocks">
<div class="ticket-main">
<p class="label">Admit one agent</p>
<p class="ticket-title">Car insurance quote</p>
<dl>
<div><dt>Agent</dt><dd>key 7f3a…c21, signed</dd></div>
<div><dt>Map</dt><dd>3 pages, every field by meaning</dd></div>
<div><dt>House rules</dt><dd>Ask the person before submitting. Five quotes an hour.</dd></div>
<div><dt>Valid</dt><dd>10 minutes, this site only</dd></div>
</dl>
</div>
<div class="ticket-stub"><span class="label">No.</span><b>0042</b><span>Filled in 2.7 s<br>instead of 14 s</span></div>
</aside>
</section>

<section class="programme" id="how" data-reveal>
<h2>How it works</h2>
<ol class="acts">
<li><span class="act">I</span><div><h3>Map</h3><p>Each form is described once, by what its fields mean and which buttons matter, never what anyone typed.</p></div></li>
<li><span class="act">II</span><div><h3>Knock</h3><p>An agent says who it is before it fills a form, and gets the map, the site's rules and a short-lived pass.</p></div></li>
<li><span class="act">III</span><div><h3>Log</h3><p>The site sees what each agent did, step by step, by meaning, while people using the form are never tracked.</p></div></li>
</ol>
</section>

${o.hosted ? assistantSection(o.url, o.demoOrigin) : ''}

${o.forms?.length ? html`<section id="try" data-reveal><h2>Try it</h2>
<p class="lede">Pick a form and see its map: what each field means and how risky it is to act on. Usher reads structure, never anything typed, and nothing is submitted.</p>
${o.viewer ? html`<div class="card error">${o.viewer.error}</div>` : ''}
${pickerButtons(o.forms, 'home')}
<p class="small muted">Run a site? <a href="/dashboard">Sign in</a> and map any page on it.</p>
</section>` : ''}

<section class="grid two" id="start" data-reveal>
<div class="card"><p class="label">For sites</p><h2>The control layer for AI agents on your forms.</h2>
<p class="lede">No integration required.</p>
<pre class="wrap">${tag}</pre>
${siteClaims()}
<p><a class="button" href="/sites/new">Get your keys</a></p>
<p class="small muted">Then lock the actions that matter (getting a quote, sending a message) on your server, with <a href="${REPOSITORY}/tree/main/packages/site-middleware">one check</a>.</p></div>
<div class="card"><p class="label">For agents</p><h2>One call fills the form.</h2>
<p class="lede">No signup. Your agent's key is its identity.</p>
${o.hosted ? html`<p><b>Assistants</b> (claude.ai, Claude Desktop, ChatGPT, Cursor): add this as a remote MCP server. Nothing to install.</p>
<pre class="wrap">${o.url}/mcp</pre>
<p><b>Frameworks and your own agents:</b> run it locally.</p>` : ''}
<pre>${mcp}</pre>
${o.hosted ? html`<p class="small muted">Hosted acts on sites that have joined Usher; local acts on any site, with your own key. <a href="${REPOSITORY}/blob/main/docs/hosted-mcp.md">Setup for each assistant</a>.</p>` : ''}
<p><code>usher_fill</code> takes the form's values by meaning, fills every page in seconds, and stops to ask before anything is submitted.${o.hosted ? html` <a href="#assistant">See it inside an assistant</a>.` : ''}</p>
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
   client shows them (CARD_CSS). */
${CARD_CSS}
.assistant { ${CARD_DARK} margin:22px 0 0; max-width:640px; background:var(--bg); border:1.5px solid var(--line); color:var(--ink); }
.assistant-bar { display:flex; justify-content:space-between; align-items:baseline; gap:12px; padding:12px 18px; border-bottom:1.5px dashed var(--line); }
.assistant-name { font-family:var(--serif); font-size:17px; font-weight:700; }
.assistant-tag { font-size:11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
.assistant-chat { display:grid; gap:18px; padding:20px 18px 22px; font-size:15px; line-height:1.5; }
.assistant-chat .step { min-width:0; max-width:520px; }
.assistant-chat .person { justify-self:end; max-width:80%; }
.assistant-chat .bubble { margin:0; padding:10px 14px; background:var(--card); border:1px solid var(--line); border-radius:14px 14px 3px 14px; }
.assistant-chat .ticket { transform:rotate(-1deg); }
.assistant-chat .caption { margin:8px 2px 0; font-size:12.5px; color:var(--muted); font-style:italic; }
.assistant-chat input[type=checkbox], .assistant-chat input[type=radio] { width:auto; margin:3px 0 0; padding:0; accent-color:var(--accent); }
.assistant-chat .yesno input { margin:0; }
.assistant-chat button { margin-top:12px; }
.assistant-notes { margin:14px 0 0; padding-left:1.2em; max-width:640px; }
.assistant-notes li { margin:2px 0; }
/* The conversation plays in order once in view (site.js): later steps wait dimmed, never hidden,
   so nothing is missing without JavaScript and no space sits empty. */
.assistant-chat.waiting .step:not(:first-child) { opacity:.3; }
.assistant-chat .step { transition:opacity 500ms ease-out; }
.assistant-chat.play .step:nth-child(2) { transition-delay:700ms; }
.assistant-chat.play .step:nth-child(3) { transition-delay:1600ms; }
.assistant-chat.play .step:nth-child(4) { transition-delay:2500ms; }
@media (prefers-reduced-motion: reduce) { .assistant-chat .step { transition:none; } .assistant-chat.waiting .step { opacity:1; } }
@media (max-width:480px) { .assistant-chat { padding:16px 12px 18px; } .assistant-chat .person { max-width:92%; } .assistant-chat .ticket { transform:none; } }
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
.programme { padding-top:0; }
ol.acts { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); border-top:1.5px solid var(--rule); }
@media (max-width:820px) { ol.acts { grid-template-columns:1fr; } }
ol.acts li { display:grid; grid-template-columns:44px 1fr; gap:6px; padding:22px 22px 22px 0; border-bottom:1px solid var(--line); }
@media (min-width:821px) { ol.acts li + li { border-left:1px solid var(--line); padding-left:22px; } }
.act { font-family:var(--serif); font-style:italic; font-size:24px; color:var(--accent); line-height:1.1; }
ol.acts p { margin:0; color:var(--muted); }
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
