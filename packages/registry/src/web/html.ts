// Server-rendered HTML for the registry's pages: an escaping template tag and one layout.

export class Raw {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function esc(value: unknown): string {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function render(value: unknown): string {
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === false || value === null || value === undefined) return '';
  return esc(value);
}

/** Interpolated values are escaped unless they are Raw (as nested html`` results are). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  return new Raw(strings.reduce((out, s, i) => out + s + (i < values.length ? render(values[i]) : ''), ''));
}

export function riskBadge(risk: string): Raw {
  return html`<span class="badge risk-${risk}">${risk.replace('_', ' ')}</span>`;
}

export function ruleBadge(rule: string): Raw {
  return html`<span class="badge rule-${rule}">${rule}</span>`;
}

export function when(date: string | undefined): Raw {
  if (!date) return html`<span class="muted">never</span>`;
  return html`<time datetime="${date}">${date.replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC')}</time>`;
}

/**
 * The two typefaces, served by this registry from /fonts/ (nothing is loaded from any other
 * origin). Text shows in the system face until a file arrives, and stays there if none does.
 */
const FONT_FACES = [
  ...[400, 500, 600, 700].map((w) => `@font-face { font-family:"Instrument Sans"; font-style:normal; font-weight:${w}; font-display:swap; src:url("/fonts/instrument-sans-${w}.woff2") format("woff2"); }`),
  ...[400, 500].map((w) => `@font-face { font-family:"JetBrains Mono"; font-style:normal; font-weight:${w}; font-display:swap; src:url("/fonts/jetbrains-mono-${w}.woff2") format("woff2"); }`),
].join('\n');

/**
 * Looks shared by every page: one typeface, a flat page with rules rather than boxes, panels one
 * level deep, and one colour of Usher's own used in a few places. The stage (the front page, the
 * header band, a summary panel) is dark petrol; owner pages are light. The two states an owner
 * learns, agent fills and person confirms, are a fixed pair everywhere. Pages load nothing from
 * anywhere but this origin.
 */
export const THEME = `
${FONT_FACES}
:root { --bg:#f3f7f7; --paper:#ffffff; --card:#ffffff; --ink:#0b2a33; --muted:#4f6d72; --dim:#7f9ea3; --line:#d3e0e2; --rule:#0b2a33; --accent:#c2452c; --accent-ink:#ffffff;
  --button:#0b2a33; --button-ink:#ffffff; --code:#e9f0f1; --footer:#0b2a33;
  --stage:#0b2a33; --stage-paper:#061b22; --stage-ink:#eef5f5; --stage-muted:#a7c4c8; --stage-line:#275a66; --stage-accent:#ff6a4d;
  --safe:#1f9d66; --safe-bg:#e3f5ec; --cons:#b8860b; --cons-bg:#fff9ec; --user:#a1251b; --user-bg:#f7e2de;
  --sans:"Instrument Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
@media (prefers-color-scheme: dark) { :root { --bg:#0b2a33; --paper:#061b22; --card:#0a2129; --ink:#eef5f5; --muted:#a7c4c8; --dim:#7fa8ae; --line:#1c4650; --rule:#275a66; --accent:#ff6a4d; --accent-ink:#061b22;
  --button:#ff6a4d; --button-ink:#061b22; --code:#0f3540; --footer:#061b22; --stage:#061b22; --stage-paper:#0b2a33;
  --safe:#6fe3a6; --safe-bg:#0f3a2c; --cons:#f0b429; --cons-bg:#3a2f14; --user:#f19389; --user-bg:#3b1d1a; } }
* { box-sizing:border-box; }
html { background:var(--bg); }
body { margin:0; font:15px/1.5 var(--sans); color:var(--ink); background:var(--bg); min-height:100vh; display:flex; flex-direction:column; -webkit-font-smoothing:antialiased; }
main { flex:1; width:100%; }
a { color:var(--ink); text-decoration-color:var(--line); text-decoration-thickness:1px; text-underline-offset:3px; }
a:hover { color:var(--accent); text-decoration-color:currentColor; }
/* The header: a plain dark bar. Mark and wordmark left, nav right; on owner pages the site's host
   and Sign out, with the tabs in a row beneath, the open one joining the page below. */
header.top { background:var(--stage); color:var(--stage-ink); }
header.top .inner, main, footer .inner { max-width:1120px; margin:0 auto; padding-left:24px; padding-right:24px; }
header.top .bar { display:flex; gap:12px 20px; align-items:center; justify-content:space-between; padding-top:14px; padding-bottom:14px; flex-wrap:wrap; }
header.top .bar.with-tabs { padding-bottom:6px; }
a.brand { display:inline-flex; align-items:center; gap:10px; font-weight:700; font-size:20px; letter-spacing:-0.02em; color:var(--stage-ink); text-decoration:none; }
a.brand::before { content:""; flex:none; width:22px; height:22px; background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 22 22' fill='none'%3E%3Crect x='2' y='2' width='18' height='18' rx='2' stroke='%23ff6a4d' stroke-width='2.5'/%3E%3Cpath d='M8 11h6M11 8l3 3-3 3' stroke='%23ff6a4d' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/contain no-repeat; }
header.top nav { display:flex; gap:12px 22px; align-items:center; flex-wrap:wrap; min-width:0; } header.top nav a:not(.button) { color:var(--stage-muted); text-decoration:none; font-size:15px; font-weight:500; }
header.top nav a:not(.button):hover { color:var(--stage-ink); }
header.top nav a.button, header.top nav button { background:var(--stage-accent); border-color:var(--stage-accent); color:#061b22; padding:8px 14px; font-size:14px; }
header.top nav button.secondary { background:transparent; border-color:var(--stage-line); color:var(--stage-ink); }
header.top nav button.secondary:hover { border-color:var(--stage-ink); color:var(--stage-ink); }
header.top nav form { margin:0; }
header.top .host { display:inline-flex; align-items:center; gap:8px; font:400 13px var(--mono); color:var(--stage-muted); min-width:0; max-width:100%; }
header.top .host span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
header.top .host i { flex:none; width:8px; height:8px; border-radius:50%; background:var(--stage-line); }
header.top .host i.on { background:#6fe3a6; }
header.top .tabs { display:flex; flex-wrap:wrap; gap:0 4px; align-items:flex-end; margin:0; }
header.top .tabs a { padding:9px 14px; text-decoration:none; font-weight:600; font-size:14px; color:var(--stage-muted); border-radius:6px 6px 0 0; }
header.top .tabs a:hover { color:var(--stage-ink); }
header.top .tabs a[aria-current] { background:var(--bg); color:var(--ink); }
header.top .tabs a.action { margin-left:auto; color:var(--stage-accent); }
header.top .tabs a.action:hover { color:var(--stage-ink); }
@media (max-width:640px) { header.top nav { gap:12px 16px; } header.top nav .wide { display:none; } header.top .tabs a { padding:11px 12px; } header.top .tabs a.action { margin-left:0; } }
h1, h2, h3 { color:var(--ink); font-weight:700; }
h1 { line-height:1.05; letter-spacing:-0.03em; }
h2 { font-size:clamp(24px, 2.6vw, 28px); font-weight:700; margin:0 0 14px; letter-spacing:-0.025em; line-height:1.15; }
h3 { font-size:17px; font-weight:600; margin:0 0 6px; }
/* The one label left: mono, small, uppercase, on a dark panel in the accent, elsewhere muted. */
.mono-label { font:500 12px/1.4 var(--mono); letter-spacing:.04em; text-transform:uppercase; color:var(--muted); margin:0 0 8px; }
.lede { color:var(--muted); }
.card { background:var(--paper); border:1px solid var(--line); border-radius:6px; padding:20px 22px; margin:14px 0; min-width:0; }
.card p { margin:0 0 10px; } .card p:last-child { margin-bottom:0; }
/* One level only: a card inside a card is a plain block with a rule above it. */
.card .card { border:0; border-top:1px solid var(--line); border-radius:0; background:transparent; padding:14px 0 0; margin:14px 0 0; }
/* The dark panel on a light page: today's summary, the rules quoted. Once or twice a page. */
.card.dark { background:var(--stage); color:var(--stage-ink); border-color:var(--stage); }
.card.dark .mono-label { color:var(--stage-accent); }
.card.dark .muted, .card.dark .dim, .card.dark .small.muted { color:var(--stage-muted); }
.card.dark a { color:var(--stage-ink); text-decoration-color:var(--stage-line); } .card.dark a:hover { color:var(--stage-accent); }
.card.dark h2, .card.dark h3 { color:var(--stage-ink); }
.card.dark button.secondary { border-color:var(--stage-line); color:var(--stage-ink); } .card.dark button.secondary:hover { border-color:var(--stage-accent); color:var(--stage-accent); }
.card.dark code { background:rgba(255,255,255,.08); color:var(--stage-ink); }
.card.dark .quote { font-size:20px; line-height:1.35; font-weight:500; letter-spacing:-0.01em; margin:0; }
.card.dashed { border-style:dashed; background:transparent; color:var(--muted); }
.grid { display:grid; gap:14px; } .grid > .card { margin:0; }
pre, code, .mono { font-family:var(--mono); font-size:13px; }
pre { background:var(--code); padding:12px 14px; border-radius:4px; overflow:auto; margin:0 0 12px; }
code { background:var(--code); padding:1px 5px; border-radius:3px; }
table { width:100%; border-collapse:collapse; font-size:14px; } th, td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-weight:600; color:var(--muted); font-size:11px; letter-spacing:.02em; border-bottom:1px solid var(--line); }
td code { background:transparent; padding:0; }
input[type=text], input[type=url], input[type=email], input[type=password], textarea, input:not([type]) { font:inherit; padding:9px 10px; border:1px solid var(--line); border-radius:4px; background:var(--bg); color:var(--ink); }
input:focus, textarea:focus, select:focus { outline:none; border-color:var(--ink); }
button, a.button { display:inline-block; font:inherit; font-weight:600; font-size:15px; padding:11px 18px; border:1px solid var(--button); border-radius:4px; background:var(--button); color:var(--button-ink); cursor:pointer; text-decoration:none; align-self:flex-start; line-height:1.3; }
button:hover, a.button:hover { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); }
a.button.ghost, button.secondary { background:transparent; border-color:var(--rule); color:var(--ink); }
a.button.ghost:hover, button.secondary:hover { background:transparent; border-color:var(--accent); color:var(--accent); }
a.small-button { padding:7px 12px; }
.muted { color:var(--muted); } .small { font-size:13px; } .dim { color:var(--dim); }
/* A status line, not a card: the words under the heading, muted, the time in mono. */
.card.notice, .card.error, .card.warn, p.status { border:0; background:transparent; padding:0; margin:0 0 18px; font-size:14px; color:var(--muted); }
.card.notice b, .card.warn b { color:var(--ink); }
.card.error { color:var(--user); } .card.error b { color:var(--user); }
.card.notice time, p.status time { font-family:var(--mono); font-size:12px; }
footer { background:var(--footer); color:var(--stage-muted); font-size:14px; margin-top:56px; }
footer .inner { display:flex; justify-content:space-between; gap:16px 24px; flex-wrap:wrap; align-items:center; padding-top:20px; padding-bottom:20px; }
footer a { color:var(--stage-muted); text-decoration:none; } footer a:hover { color:var(--stage-ink); }
footer nav { display:flex; gap:12px 20px; flex-wrap:wrap; }
footer .foot-brand { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
ul.claims { list-style:none; margin:18px 0; padding:0; display:grid; gap:10px; }
ul.claims li { display:flex; flex-direction:column; gap:2px; padding-top:10px; border-top:1px solid var(--line); }
ul.claims span { color:var(--muted); font-size:14px; }
/* Wide tables scroll inside their panel on narrow screens, never the page. */
.card:has(> table), .table-scroll { overflow-x:auto; }
@media (max-width:720px) { .card:has(> table) > table, .table-scroll > table { min-width:720px; } }
`;

/** The tab icon: Usher's mark, a square with an arrow in, inline so nothing is fetched. */
export const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0b2a33"/><rect x="14" y="14" width="36" height="36" rx="4" fill="none" stroke="#ff6a4d" stroke-width="5"/><path d="M24 32h14M32 25l7 7-7 7" fill="none" stroke="#ff6a4d" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>')}`;

/** How a map came to be trusted: verified by whom and when, or unverified and private to its agent. */
export function verificationNote(record: { submitted_by?: string; verification?: { by: 'agent' | 'keeper' | 'admin'; verifier?: string; at: string }; agreements?: string[]; disagreements?: number }): Raw | string {
  if (record.verification) {
    const who = record.verification.by === 'keeper' ? 'the keeper, which rebuilt the form and got the same map' : record.verification.by === 'admin' ? "Usher's admin, who checked it" : html`a second agent (<span class="mono">${record.verification.verifier?.slice(0, 10) ?? ''}…</span>) that agreed with it and completed a run`;
    return html`Verified ${when(record.verification.at)} by ${who}.`;
  }
  if (!record.submitted_by) return '';
  const tally = [record.agreements?.length ? `${record.agreements.length} agent${record.agreements.length === 1 ? '' : 's'} agreed` : '', record.disagreements ? `${record.disagreements} differed` : ''].filter(Boolean).join(', ');
  return html`Unverified: shared by an agent and served only to it until a second agent or the keeper confirms it${tally ? html` (${tally})` : ''}.`;
}

/** What a site gets, in three claims: on the front page, the dashboard sign-in and signup. */
export const SITE_CLAIMS: [string, string][] = [
  ['No changes to your systems.', 'One script tag on the pages you already have. Agents come through the same forms your customers use.'],
  ['You set the terms.', 'Which forms, which actions need a person, how often, which agents. Written in plain English, enforced on every visit.'],
  ['Every agent action on the record.', 'Who the agent was and what it did, step by step, by meaning. Your customers\' data is never captured.'],
];

export function siteClaims(): Raw {
  return html`<ul class="claims">${SITE_CLAIMS.map(([bold, text]) => html`<li><b>${bold}</b><span>${text}</span></li>`)}</ul>`;
}

/** One line at the foot of every page. */
export const LOOMA_FOOTER = `<span class="foot-brand">Usher · Apache-2.0 · built by <a href="https://looma.insure" aria-label="Looma, who built Usher">Looma</a></span>`;

const STYLE = `
${THEME}
main { padding-top:28px; padding-bottom:60px; }
h1 { font-size:30px; margin:0 0 8px; } h2 { font-size:17px; font-weight:600; margin:28px 0 10px; } h3 { font-size:15px; margin:18px 0 6px; }
.card > h2:first-child { margin-top:0; }
p.lede { margin:0 0 22px; max-width:68ch; font-size:15px; }
.grid { grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); }
/* Stat tiles: one row, hairlines between, the number large and tabular. */
.grid.stats { grid-template-columns:repeat(4,minmax(0,1fr)); gap:0; background:var(--paper); border:1px solid var(--line); border-radius:6px; }
.grid.stats > .stat { border:0; border-left:1px solid var(--line); border-radius:0; margin:0; padding:16px 18px; } .grid.stats > .stat:first-child { border-left:0; }
.stat b { display:block; font-size:34px; font-weight:700; letter-spacing:-0.04em; line-height:1.1; font-variant-numeric:tabular-nums; } .stat span { color:var(--muted); font-size:13px; }
@media (max-width:720px) { .grid.stats { grid-template-columns:repeat(2,minmax(0,1fr)); } .grid.stats > .stat:nth-child(odd) { border-left:0; } .grid.stats > .stat:nth-child(n+3) { border-top:1px solid var(--line); } }
pre { max-height:520px; }
/* The states as a fixed pair: a square before the words, the same everywhere an owner sees them. */
.badge { display:inline-flex; align-items:center; gap:7px; padding:1px 0; border-radius:0; font-size:13px; font-weight:500; white-space:nowrap; background:transparent; }
.badge::before { content:""; width:8px; height:8px; flex:none; background:currentColor; }
.risk-safe, .rule-allow { color:var(--safe); } .risk-consequential, .rule-confirm { color:var(--cons); }
.risk-needs_user, .rule-forbid { color:var(--user); } .badge.plain { color:var(--muted); } .badge.plain::before { background:transparent; border:1px solid currentColor; }
/* A long label, such as a question quoted in the rules table, wraps after its square. */
td .badge.plain { white-space:normal; align-items:flex-start; } td .badge.plain::before { margin-top:6px; }
tr.cons > td { background:var(--cons-bg); }
h1, h2 { overflow-wrap:anywhere; }
.card:has(> table), .card > details:has(> table), [data-live]:has(> table) { overflow-x:auto; }
[id] { scroll-margin-top:16px; }
form.inline { display:flex; gap:10px; flex-wrap:wrap; }
form.inline input[type=url], form.inline input[type=text] { flex:1; min-width:min(260px,100%); }
textarea { width:100%; min-height:96px; box-sizing:border-box; }
/* Every field: its label above it, one width, the same shape, whichever page it's on. */
select { font:inherit; padding:9px 8px; border:1px solid var(--line); border-radius:4px; background:var(--bg); color:var(--ink); }
main label:not(:has(> input[type=color])):has(> input:not([type=checkbox], [type=radio], [type=hidden]), > select, > textarea) { display:block; font-weight:600; font-size:14px; margin:0 0 16px; max-width:520px; }
main label:has(> textarea) { max-width:none; }
main label:not(:has(> input[type=color])) > input:not([type=checkbox], [type=radio]), main label > select, main label > textarea { display:block; width:100%; box-sizing:border-box; margin-top:4px; font-weight:400; font-size:16px; }
main label > small, main label > .hint { display:block; font-weight:400; color:var(--muted); font-size:13px; }
main label:has(> input[type=checkbox], > input[type=radio]) { display:flex; gap:8px; align-items:flex-start; margin:0 0 12px; }
main label > input[type=checkbox], main label > input[type=radio] { flex:none; margin-top:5px; }
form.stack { display:flex; flex-direction:column; align-items:stretch; }
/* Usher at your side: anything the model does for you, in one floating panel, wherever you are on the page. */
.partner { position:fixed; right:20px; bottom:20px; z-index:40; width:min(400px, calc(100vw - 32px)); background:var(--paper); border:1px solid var(--rule); border-radius:6px; }
.partner > summary { display:flex; align-items:center; gap:10px; padding:12px 16px; font-weight:600; color:var(--ink); cursor:pointer; list-style:none; }
.partner > summary::-webkit-details-marker { display:none; }
.partner > summary::after { content:"▾"; margin-left:auto; color:var(--muted); }
.partner:not([open]) > summary::after { content:"▴"; }
.partner-mark { flex:none; width:22px; height:22px; border-radius:3px; background:var(--accent); color:var(--accent-ink); display:inline-grid; place-items:center; font-size:12px; font-weight:700; }
.partner:not([open]) { width:auto; max-width:calc(100vw - 32px); }
.partner:not([open]) > summary { gap:10px; }
.partner-body { padding:0 16px 16px; max-height:min(55vh, 480px); overflow:auto; font-size:14px; }
.partner-body .card { padding:12px; margin:0 0 10px; }
.partner-body textarea { min-height:72px; }
.partner-body p { margin:0 0 10px; }
/* Waiting on the model: a turning mark, words and the seconds so far. */
.spin { flex:none; display:inline-block; width:14px; height:14px; border-radius:50%; border:2px solid var(--accent); border-right-color:transparent; animation:spin .9s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation-duration:3s; } }
button:disabled { opacity:.5; cursor:default; }
.partner[data-keep] { border-color:var(--cons); }
.fill-examples { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.rules-next { display:flex; flex-wrap:wrap; gap:10px 14px; align-items:center; margin:14px 0 0; }
label.button { display:inline-block; font-weight:600; font-size:14px; padding:10px 16px; border:1px solid var(--button); border-radius:4px; background:var(--button); color:var(--button-ink); cursor:pointer; }
p.busy { display:flex; align-items:center; gap:8px; margin:10px 0 0; font-size:14px; font-weight:600; color:var(--muted); }
/* A dialog: opened by the browser (popover), so it needs no script and sits above any table. */
.dialog { white-space:normal; margin:auto; padding:24px; width:min(480px, calc(100vw - 32px)); max-height:calc(100vh - 48px); overflow:auto; border:1px solid var(--rule); border-radius:6px; background:var(--paper); color:var(--ink); }
.dialog::backdrop { background:rgba(6,27,34,.55); }
.dialog h2 { margin:0 0 10px; font-size:20px; }
.dialog-actions { display:flex; flex-wrap:wrap; gap:10px; margin:6px 0 0; }
button.danger { background:var(--user); border-color:var(--user); color:#fff; }
button.small, .small-button { padding:6px 11px; font-size:13px; }
/* Touch targets stay at 44px on a phone: the small button is for desktop only. */
@media (max-width:720px) { button.small, .small-button, a.small-button, .row-actions > button, .row-actions > form > button { padding:11px 16px; font-size:15px; } }
.row-actions { display:flex; gap:8px; white-space:nowrap; align-items:center; }
.row-actions form { margin:0; }
.row-actions > button, .row-actions > form > button { padding:8px 14px; font-size:14px; }
pre.key { white-space:pre-wrap; word-break:break-all; }
ol.timeline { list-style:none; padding:0; margin:0; } ol.timeline li { display:grid; grid-template-columns:150px 110px 1fr; gap:10px; padding:8px 0; border-bottom:1px solid var(--line); font-size:14px; }
ol.timeline .src { color:var(--muted); }
@media (max-width:720px) { ol.timeline li { grid-template-columns:1fr; gap:2px; } }
details summary { cursor:pointer; color:var(--muted); }
/* Two columns, one under 720px. */
.two { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; align-items:start; } .two > .card { margin:0; }
@media (max-width:720px) { .two { grid-template-columns:minmax(0,1fr); } }
`;

/** A button and the dialog it opens. The body holds its own form; `cancel` is the button that closes it. */
export function dialog(id: string, open: { label: string; class?: string }, title: string, body: (cancel: Raw) => Raw): Raw {
  const cancel = html`<button type="button" class="secondary" popovertarget="${id}" popovertargetaction="hide">Cancel</button>`;
  return html`<button type="button"${open.class ? html` class="${open.class}"` : ''} popovertarget="${id}">${open.label}</button><div id="${id}" class="dialog" popover><h2>${title}</h2>${body(cancel)}</div>`;
}

/** Usher at your side: a floating panel for what the model does for you. Folds away; stays while you read the page. */
export function partner(title: string, body: Raw, options: { id?: string; open?: boolean; keep?: boolean } = {}): Raw {
  return html`<details class="partner"${options.id ? html` id="${options.id}"` : ''}${options.open === false ? '' : ' open'}${options.keep ? ' data-keep' : ''}><summary><span class="partner-mark" aria-hidden="true">U</span>${title}</summary><div class="partner-body">${body}</div></details>`;
}

/** The owner's site in the header: its host in mono, a green dot when its app is on, and Sign out (not on the public demo). */
export interface SiteHeader {
  host: string;
  on: boolean;
  signOut?: boolean;
}

export function page(title: string, body: Raw, options: { nav?: Raw; scripts?: string[]; style?: string; site?: SiteHeader; tabs?: Raw } = {}): string {
  const right = options.site
    ? html`<span class="host" title="${options.site.on ? 'Your assistant app is on' : 'Your assistant app is off'}"><i class="${options.site.on ? 'on' : ''}" aria-hidden="true"></i><span>${options.site.host}</span></span>${options.nav ?? ''}${options.site.signOut ? html`<form method="post" action="/dashboard/logout"><button class="secondary">Sign out</button></form>` : ''}`
    : html`<a href="/dashboard">Site dashboard</a>${options.nav ?? ''}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Usher</title>
<link rel="icon" href="${FAVICON}">
<style>${STYLE}${options.style ?? ''}</style>
${[...(options.scripts ?? []), '/busy.js'].map((src) => `<script src="${esc(src)}" defer></script>`).join('\n')}
</head>
<body>
<header class="top"><div class="inner bar${options.tabs ? ' with-tabs' : ''}"><a class="brand" href="/">Usher</a><nav>${right}</nav></div>${options.tabs ? `<div class="inner">${options.tabs}</div>` : ''}</header>
<main>${body}</main>
<footer><div class="inner">
${LOOMA_FOOTER}
<nav><a href="/dashboard">Site dashboard</a><a href="/sites/new">Get your keys</a><a href="/privacy">Privacy</a></nav>
</div></footer>
</body>
</html>`;
}
