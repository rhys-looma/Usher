// The front page (LU-53): what Usher is, the map viewer inline, the two quickstarts, the numbers
// from the committed reports, and an interest form that carries Usher's own script tag.

import { readFile } from 'node:fs/promises';
import { esc, html, type Raw } from './html.ts';

const ROOT = new URL('../../../../', import.meta.url);

export const SENTENCE = 'Usher is the front door for AI agents on web forms. Agents knock, get in fast, and follow the house rules.';
export const SUBLINE = 'More of the web, open to agents.';
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
  return html`<section id="numbers"><h2>Numbers</h2>
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
  /** The viewer box: what was pasted, and a reason if it failed. */
  viewer?: { url: string; error: string };
  interest?: { error?: string };
}

export function landingPage(o: LandingOptions): string {
  const tag = `<script src="${o.url}/usher.js"\n        data-usher-registry="${o.url}"\n        data-usher-site-key="usp_…" defer></script>`;
  const mcp = JSON.stringify({ mcpServers: { usher: { command: 'npx', args: ['tsx', '/path/to/Usher/packages/registry/src/mcp.ts'], env: { USHER_REGISTRY_URL: o.url } } } }, null, 2);
  const description = `${SENTENCE} ${SUBLINE}`;
  const body = html`<section class="hero">
<h1>${SENTENCE}</h1>
<p class="lede">${SUBLINE}</p>
</section>

<section class="grid three" id="how">
<div class="card"><h3>Map</h3><p>Each form is described once, by what its fields mean and which buttons matter, never what anyone typed.</p></div>
<div class="card"><h3>Knock</h3><p>An agent says who it is before it fills a form, and gets the map, the site's rules and a short-lived pass.</p></div>
<div class="card"><h3>Log</h3><p>The site sees what each agent did, step by step, by meaning, while people using the form are never tracked.</p></div>
</section>

<section id="try"><h2>Try it</h2>
<form class="inline card" method="post" action="/viewer">
<input type="hidden" name="from" value="home">
<input type="url" name="url" required placeholder="https://example.com/contact" value="${o.viewer?.url ?? ''}" aria-label="Address of a page with a form">
<button type="submit">See the map</button>
</form>
${o.viewer ? html`<div class="card error">${o.viewer.error}</div>` : html`<p class="small muted">Paste the address of a page with a form. Usher reads its structure, never anything typed, and Muse Spark says what each field means and how risky it is to act on. Nothing is submitted.</p>`}
</section>

<section class="grid two" id="start">
<div class="card"><h2>For sites</h2>
<p>Add one tag to the pages with your forms:</p>
<pre>${tag}</pre>
<p><a class="button" href="/sites/new">Get your keys</a></p>
<p class="small muted">Then lock the actions that matter (getting a quote, sending a message) on your server, with <a href="${REPOSITORY}/tree/main/packages/site-middleware">one check</a>.</p></div>
<div class="card"><h2>For agents</h2>
<p>Add one MCP server to your agent's configuration:</p>
<pre>${mcp}</pre>
<p><b>No signup. Your agent's key is its identity.</b></p>
<p class="small muted">The server runs beside your agent and holds its key, made on first use. It gives the agent <code>knock</code>, <code>get_map</code> and <code>get_plan</code>.</p></div>
</section>

${numbersSection(o.numbers)}

<section id="interest"><h2>I run a site with forms</h2>
${o.interest?.error ? html`<div class="card error">${o.interest.error}</div>` : ''}
<form class="card stack" method="post" action="/interest">
<label>Your site<input type="url" name="site" required placeholder="https://www.example.com"></label>
<label>Email<input type="email" name="email" required autocomplete="email"></label>
<label>Anything else? <span class="muted small">(optional)</span><input type="text" name="note" maxlength="200"></label>
<button type="submit">Tell me more</button>
<p class="small muted">This form is agent-ready too: it carries the Usher tag, and an agent filling it for you knocks first.</p>
</form>
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
<style>${LANDING_STYLE}</style>
${o.siteKey ? `<script src="${esc(o.url)}/usher.js" data-usher-registry="${esc(o.url)}" data-usher-site-key="${esc(o.siteKey)}" defer></script>\n` : ''}</head>
<body>
<header class="top"><div class="inner"><a class="brand" href="/">Usher</a><nav><a href="#try">Try it</a><a href="#start">Get started</a><a href="/dashboard">Sign in</a></nav></div></header>
<main>${body}</main>
<footer><nav>
<a href="/dashboard">Site dashboard</a>
<a href="${REPOSITORY}">GitHub</a>
<a href="/spec/">Specifications</a>
<a href="${REPOSITORY}/blob/main/docs/security.md">Security</a>
</nav>
<p>Built by Looma · Code Apache-2.0 · Specifications CC BY 4.0</p></footer>
</body>
</html>`;
}

const LANDING_STYLE = `
:root { --bg:#fbfbfa; --card:#fff; --ink:#1c2230; --muted:#626a7a; --line:#e3e5ea; --accent:#0b6e6e; --accent-ink:#fff; --code:#f3f4f6; --user:#a1251b; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171c; --card:#1b1f26; --ink:#e7e9ee; --muted:#9aa2b1; --line:#2c323c; --accent:#43b3b0; --accent-ink:#0b1416; --code:#232831; --user:#f19389; } }
* { box-sizing: border-box; }
body { margin:0; font:17px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--ink); background:var(--bg); }
a { color:var(--accent); }
header.top { border-bottom:1px solid var(--line); background:var(--card); }
header.top .inner, main, footer { max-width:1040px; margin:0 auto; padding:14px 16px; }
header.top .inner { display:flex; gap:20px; align-items:baseline; justify-content:space-between; flex-wrap:wrap; }
header.top a.brand { font-weight:700; font-size:20px; color:var(--ink); text-decoration:none; }
header.top nav { display:flex; gap:16px; } header.top nav a { color:var(--muted); text-decoration:none; }
section { margin:0 0 44px; }
.hero { padding:36px 0 8px; }
h1 { font-size:clamp(26px, 5vw, 40px); line-height:1.2; margin:0 0 12px; max-width:24ch; letter-spacing:-0.01em; }
h2 { font-size:22px; margin:0 0 12px; } h3 { font-size:18px; margin:0 0 6px; }
.lede { color:var(--muted); font-size:20px; margin:0; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:18px 20px; margin:12px 0; min-width:0; }
.card p { margin:0 0 10px; } .card p:last-child { margin-bottom:0; }
.grid { display:grid; gap:14px; } .grid > .card { margin:0; }
.grid.three { grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); }
.grid.two { grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
.grid:not(.two):not(.three) { grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); }
.stat b { display:block; font-size:28px; } .stat span { color:var(--muted); font-size:15px; }
pre, code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13.5px; }
pre { background:var(--code); padding:12px 14px; border-radius:8px; overflow-x:auto; margin:0 0 12px; }
code { background:var(--code); padding:1px 5px; border-radius:4px; }
table { width:100%; border-collapse:collapse; font-size:15px; } th, td { text-align:left; padding:8px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-weight:600; color:var(--muted); font-size:13px; }
@media (max-width:640px) { table, tbody, tr, td { display:block; } thead { display:none; } tr { padding:8px 0; border-bottom:1px solid var(--line); } td { border:0; padding:2px 0; } td[data-label]::before { content:attr(data-label) ": "; color:var(--muted); } }
form.inline { display:flex; gap:10px; flex-wrap:wrap; }
form.stack { display:flex; flex-direction:column; gap:12px; max-width:520px; }
form.stack label { display:flex; flex-direction:column; gap:4px; font-weight:600; font-size:15px; }
input { font:inherit; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--ink); min-width:0; }
form.inline input[type=url] { flex:1 1 240px; }
button, a.button { display:inline-block; font:inherit; font-weight:600; padding:10px 18px; border:0; border-radius:8px; background:var(--accent); color:var(--accent-ink); cursor:pointer; text-decoration:none; align-self:flex-start; }
.muted { color:var(--muted); } .small { font-size:14px; }
.notice { border-left:4px solid var(--accent); } .error { border-left:4px solid var(--user); }
footer { color:var(--muted); font-size:14px; border-top:1px solid var(--line); padding-top:20px; padding-bottom:40px; }
footer nav { display:flex; gap:18px; flex-wrap:wrap; margin-bottom:8px; }
`;
