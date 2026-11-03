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
 * Looks shared by every page: printed matter for a front door. Paper and navy ink, thin rules
 * rather than shadows, a serif for headings, one accent (Looma's purple) used sparingly. System
 * fonts only: pages load nothing from anywhere else.
 */
export const THEME = `
:root { --bg:#f5f2ea; --paper:#fbf9f4; --card:#fffdf8; --ink:#191942; --muted:#5b5f7a; --line:#d9d4c7; --rule:#191942; --accent:#7434d3; --accent-ink:#fff;
  --button:#191942; --button-ink:#fbf9f4; --pill-bg:transparent; --code:#efeadf; --footer:#191942;
  --serif:"Iowan Old Style","Charter","Palatino Linotype",Palatino,Georgia,serif;
  --safe:#0f7a3d; --safe-bg:#e3f1e6; --cons:#8a5a00; --cons-bg:#f8edd2; --user:#a1251b; --user-bg:#f7e2de; }
@media (prefers-color-scheme: dark) { :root { --bg:#12132c; --paper:#171936; --card:#1b1d3d; --ink:#f1ede3; --muted:#b0afc4; --line:#34365a; --rule:#f1ede3; --accent:#c5a3ff; --accent-ink:#12132c;
  --button:#f1ede3; --button-ink:#12132c; --code:#22244a; --footer:#0b0c20;
  --safe:#6fd39a; --safe-bg:#173325; --cons:#f0c05a; --cons-bg:#3a2f14; --user:#f19389; --user-bg:#3b1d1a; } }
* { box-sizing:border-box; }
html { background:var(--bg); }
body { margin:0; font:17px/1.6 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:var(--ink); background:var(--bg); min-height:100vh; display:flex; flex-direction:column; -webkit-font-smoothing:antialiased; }
main { flex:1; width:100%; }
a { color:var(--ink); text-decoration-color:var(--accent); text-decoration-thickness:2px; text-underline-offset:4px; }
a:hover { color:var(--accent); }
header.top { border-bottom:1px solid var(--rule); background:var(--bg); }
header.top .inner, main, footer .inner { max-width:1120px; margin:0 auto; padding-left:24px; padding-right:24px; }
header.top .inner { display:flex; gap:20px; align-items:center; justify-content:space-between; padding-top:16px; padding-bottom:16px; }
a.brand { font-family:var(--serif); font-weight:700; font-size:26px; letter-spacing:-0.01em; color:var(--ink); text-decoration:none; }
a.brand::after { content:"."; color:var(--accent); }
header.top nav { display:flex; gap:24px; align-items:center; } header.top nav a:not(.button) { color:var(--ink); text-decoration:none; font-size:15px; }
header.top nav a:not(.button):hover { color:var(--accent); }
@media (max-width:640px) { header.top nav { gap:16px; } header.top nav .wide { display:none; } }
h1, h2, h3 { font-family:var(--serif); color:var(--ink); }
h1 { font-weight:700; line-height:1.08; letter-spacing:-0.015em; }
h2 { font-size:clamp(26px, 3.2vw, 34px); font-weight:700; margin:0 0 18px; letter-spacing:-0.01em; line-height:1.15; }
h3 { font-size:21px; font-weight:700; margin:0 0 6px; }
.label { font-family:Inter,system-ui,sans-serif; font-size:12px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }
.lede { color:var(--muted); }
.card { background:var(--card); border:1px solid var(--line); border-radius:4px; padding:22px 24px; margin:14px 0; min-width:0; }
.card p { margin:0 0 10px; } .card p:last-child { margin-bottom:0; }
.grid { display:grid; gap:18px; } .grid > .card { margin:0; }
pre, code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13.5px; }
pre { background:var(--code); padding:14px 16px; border-radius:3px; overflow:auto; margin:0 0 12px; border-left:3px solid var(--accent); }
code { background:var(--code); padding:1px 5px; border-radius:3px; }
table { width:100%; border-collapse:collapse; font-size:15px; } th, td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-weight:700; color:var(--muted); font-size:11.5px; text-transform:uppercase; letter-spacing:.1em; border-bottom:1px solid var(--rule); }
input[type=text], input[type=url], input[type=email], input[type=password], textarea, input:not([type]) { font:inherit; padding:11px 2px; border:0; border-bottom:1.5px solid var(--rule); border-radius:0; background:transparent; color:var(--ink); }
input:focus, textarea:focus { outline:none; border-bottom-color:var(--accent); }
button, a.button { display:inline-block; font:inherit; font-weight:600; font-size:15px; padding:12px 22px; border:1.5px solid var(--button); border-radius:2px; background:var(--button); color:var(--button-ink); cursor:pointer; text-decoration:none; align-self:flex-start; }
button:hover, a.button:hover { background:var(--accent); border-color:var(--accent); color:#fff; }
a.button.ghost, button.secondary { background:transparent; color:var(--ink); }
a.button.ghost:hover, button.secondary:hover { background:var(--ink); border-color:var(--ink); color:var(--bg); }
a.small-button { padding:8px 16px; }
.muted { color:var(--muted); } .small { font-size:14px; }
.notice { border-left:3px solid var(--accent); } .error { border-left:3px solid var(--user); } .warn { border-left:3px solid var(--cons); }
footer { background:var(--footer); color:rgba(251,249,244,.62); font-size:14px; margin-top:56px; }
footer .inner { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) auto; gap:28px; align-items:start; padding-top:40px; padding-bottom:44px; }
@media (max-width:760px) { footer .inner { grid-template-columns:1fr; } }
footer a { color:rgba(251,249,244,.85); text-decoration:none; } footer a:hover { color:#fff; }
footer .brand { color:#fbf9f4; font-size:24px; } footer .brand::after { color:#c5a3ff; } footer .foot-brand p { margin:8px 0 0; max-width:40ch; }
footer nav { display:flex; flex-direction:column; gap:8px; }
.looma { display:flex; flex-direction:column; gap:6px; align-items:flex-start; }
.looma small { text-transform:uppercase; letter-spacing:.14em; font-size:11px; font-weight:700; color:rgba(251,249,244,.45); }
.looma a.wordmark { font-size:30px; font-weight:500; letter-spacing:-0.02em; color:#fff; line-height:1; }
.looma a.wordmark sup { font-size:10px; margin-left:1px; }
.looma span { font-size:12.5px; color:rgba(251,249,244,.45); }
ul.claims { list-style:none; margin:18px 0; padding:0; display:grid; gap:12px; }
ul.claims li { display:flex; flex-direction:column; gap:2px; padding-left:14px; border-left:3px solid var(--accent); }
ul.claims span { color:var(--muted); font-size:15px; }
/* Wide tables scroll inside their card on narrow screens, never the page. */
.card:has(> table) { overflow-x:auto; }
`;

/** The tab icon: a serif U with Looma's purple point, inline so nothing is fetched. */
export const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#191942"/><text x="29" y="46" font-family="Georgia,serif" font-size="42" font-weight="700" fill="#fbf9f4" text-anchor="middle">U</text><circle cx="50" cy="44" r="4.5" fill="#a978ff"/></svg>')}`;

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

/** Looma's wordmark and link, at the foot of every page. */
/** What a site gets, in three claims: on the front page, the dashboard sign-in and signup. */
export const SITE_CLAIMS: [string, string][] = [
  ['No changes to your systems.', 'One script tag on the pages you already have. Agents come through the same forms your customers use.'],
  ['You set the terms.', 'Which forms, which actions need a person, how often, which agents. Written in plain English, enforced on every visit.'],
  ['Every agent action on the record.', 'Who the agent was and what it did, step by step, by meaning. Your customers\' data is never captured.'],
];

export function siteClaims(): Raw {
  return html`<ul class="claims">${SITE_CLAIMS.map(([bold, text]) => html`<li><b>${bold}</b><span>${text}</span></li>`)}</ul>`;
}

export const LOOMA_FOOTER = `<div class="looma"><small>Built by</small><a class="wordmark" href="https://looma.insure" aria-label="Looma, who built Usher">Looma<sup>®</sup></a><span>Code Apache-2.0 · Specifications CC BY 4.0</span></div>`;

const STYLE = `
${THEME}
main { padding-top:36px; padding-bottom:60px; }
h1 { font-size:clamp(30px, 4.2vw, 44px); margin:0 0 12px; } h2 { font-size:24px; margin:36px 0 12px; } h3 { font-size:18px; margin:20px 0 8px; }
.card > h2:first-child { margin-top:0; }
p.lede { margin:0 0 24px; max-width:68ch; font-size:18px; }
.grid { grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); }
.stat b { display:block; font-family:var(--serif); font-size:32px; font-weight:700; } .stat span { color:var(--muted); font-size:14px; }
pre { max-height:520px; }
.badge { display:inline-block; padding:2px 9px; border-radius:999px; font-size:12.5px; font-weight:650; white-space:nowrap; }
.risk-safe, .rule-allow { color:var(--safe); background:var(--safe-bg); } .risk-consequential, .rule-confirm { color:var(--cons); background:var(--cons-bg); }
.risk-needs_user, .rule-forbid { color:var(--user); background:var(--user-bg); } .badge.plain { color:var(--muted); background:var(--code); }
h1, h2 { overflow-wrap:anywhere; }
.card:has(> table), .card > details:has(> table), [data-live]:has(> table) { overflow-x:auto; }
[id] { scroll-margin-top:64px; }
form.inline { display:flex; gap:10px; flex-wrap:wrap; }
form.inline input[type=url], form.inline input[type=text] { flex:1; min-width:min(260px,100%); }
textarea { width:100%; min-height:96px; box-sizing:border-box; }
/* Every field: its label above it, one width, the same shape, whichever page it's on. */
select { font:inherit; padding:10px 8px; border:1.5px solid var(--rule); border-radius:2px; background:var(--card); color:var(--ink); }
main label:not(:has(> input[type=color])):has(> input:not([type=checkbox], [type=radio], [type=hidden]), > select, > textarea) { display:block; font-weight:600; font-size:14px; margin:0 0 16px; max-width:520px; }
main label:has(> textarea) { max-width:none; }
main label:not(:has(> input[type=color])) > input:not([type=checkbox], [type=radio]), main label > select, main label > textarea { display:block; width:100%; box-sizing:border-box; margin-top:4px; font-weight:400; font-size:16px; }
main label > small, main label > .hint { display:block; font-weight:400; color:var(--muted); font-size:13px; }
main label:has(> input[type=checkbox], > input[type=radio]) { display:flex; gap:8px; align-items:flex-start; margin:0 0 12px; }
main label > input[type=checkbox], main label > input[type=radio] { flex:none; margin-top:5px; }
form.stack { display:flex; flex-direction:column; align-items:stretch; }
/* Usher at your side: anything the model does for you, in one floating panel, wherever you are on the page. */
.partner { position:fixed; right:20px; bottom:20px; z-index:40; width:min(400px, calc(100vw - 32px)); background:var(--card); border:1.5px solid var(--accent); border-radius:12px; box-shadow:0 18px 50px -18px rgba(18,19,44,.55); }
.partner > summary { display:flex; align-items:center; gap:10px; padding:12px 16px; font-weight:700; color:var(--ink); cursor:pointer; list-style:none; }
.partner > summary::-webkit-details-marker { display:none; }
.partner > summary::after { content:"▾"; margin-left:auto; color:var(--muted); }
.partner:not([open]) > summary::after { content:"▴"; }
.partner-mark { flex:none; width:24px; height:24px; border-radius:50%; background:var(--accent); color:#fff; display:inline-grid; place-items:center; font-size:13px; font-weight:700; }
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
.partner[data-keep] { box-shadow:0 0 0 4px rgba(116,52,211,.2), 0 18px 50px -18px rgba(18,19,44,.55); }
.fill-examples { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.rules-next { display:flex; flex-wrap:wrap; gap:10px 14px; align-items:center; margin:14px 0 0; }
label.button { display:inline-block; font-weight:600; font-size:15px; padding:12px 22px; border:1.5px solid var(--button); border-radius:2px; background:var(--button); color:var(--button-ink); cursor:pointer; }
p.busy { display:flex; align-items:center; gap:8px; margin:10px 0 0; font-size:14px; font-weight:600; color:var(--accent); }
/* A dialog: opened by the browser (popover), so it needs no script and sits above any table. */
.dialog { white-space:normal; margin:auto; padding:24px; width:min(480px, calc(100vw - 32px)); max-height:calc(100vh - 48px); overflow:auto; border:1.5px solid var(--rule); border-radius:6px; background:var(--card); color:var(--ink); }
.dialog::backdrop { background:rgba(18,19,44,.5); }
.dialog h2 { margin:0 0 10px; font-size:22px; }
.dialog-actions { display:flex; flex-wrap:wrap; gap:10px; margin:6px 0 0; }
button.danger { background:var(--user); border-color:var(--user); color:#fff; }
button.small, .small-button { padding:7px 12px; font-size:14px; }
.row-actions { display:flex; gap:8px; white-space:nowrap; align-items:center; }
.row-actions form { margin:0; }
.row-actions > button, .row-actions > form > button { padding:8px 14px; font-size:14px; }
.table-scroll { overflow-x:auto; }
pre.key { white-space:pre-wrap; word-break:break-all; }
ol.timeline { list-style:none; padding:0; margin:0; } ol.timeline li { display:grid; grid-template-columns:150px 110px 1fr; gap:10px; padding:8px 0; border-bottom:1px solid var(--line); font-size:15px; }
ol.timeline .src { color:var(--muted); }
details summary { cursor:pointer; color:var(--accent); }
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

export function page(title: string, body: Raw, options: { nav?: Raw; scripts?: string[]; style?: string } = {}): string {
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
<header class="top"><div class="inner"><a class="brand" href="/">Usher</a><nav><a href="/dashboard">Site dashboard</a>${options.nav ?? ''}</nav></div></header>
<main>${body}</main>
<footer><div class="inner">
<div class="foot-brand"><a class="brand" href="/">Usher</a><p>Let AI agents use your site, on your terms. Maps hold structure, never values.</p></div>
<nav><a href="/dashboard">Site dashboard</a><a href="/sites/new">Get your keys</a><a href="/privacy">Privacy</a></nav>
${LOOMA_FOOTER}
</div></footer>
</body>
</html>`;
}
