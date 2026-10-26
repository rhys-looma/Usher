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

const STYLE = `
:root { --bg:#fbfbfa; --card:#fff; --ink:#1c2230; --muted:#626a7a; --line:#e3e5ea; --accent:#0b6e6e; --accent-ink:#fff;
  --safe:#0f7a3d; --safe-bg:#e7f5ec; --cons:#8a5a00; --cons-bg:#fdf3dc; --user:#a1251b; --user-bg:#fbe9e7; --code:#f3f4f6; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171c; --card:#1b1f26; --ink:#e7e9ee; --muted:#9aa2b1; --line:#2c323c;
  --accent:#43b3b0; --accent-ink:#0b1416; --safe:#6fd39a; --safe-bg:#173325; --cons:#f0c05a; --cons-bg:#3a2f14; --user:#f19389; --user-bg:#3b1d1a; --code:#232831; } }
* { box-sizing: border-box; }
body { margin:0; font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--ink); background:var(--bg); }
header.top { border-bottom:1px solid var(--line); background:var(--card); }
header.top .inner, main { max-width:1040px; margin:0 auto; padding:14px 20px; }
header.top .inner { display:flex; gap:20px; align-items:baseline; flex-wrap:wrap; }
header.top a.brand { font-weight:700; font-size:19px; color:var(--ink); text-decoration:none; }
header.top nav { display:flex; gap:16px; flex-wrap:wrap; } header.top nav a { color:var(--muted); text-decoration:none; }
header.top nav a:hover, a { color:var(--accent); }
main { padding-top:28px; padding-bottom:60px; }
h1 { font-size:28px; margin:0 0 6px; line-height:1.25; } h2 { font-size:20px; margin:34px 0 12px; } h3 { font-size:16px; margin:20px 0 8px; }
p.lede { color:var(--muted); margin:0 0 22px; max-width:68ch; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:18px 20px; margin:14px 0; }
.grid { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); }
.stat b { display:block; font-size:24px; } .stat span { color:var(--muted); font-size:14px; }
table { width:100%; border-collapse:collapse; font-size:15px; } th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-weight:600; color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:.03em; }
code, pre, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13.5px; }
code { background:var(--code); padding:1px 5px; border-radius:4px; }
pre { background:var(--code); padding:14px; border-radius:8px; overflow:auto; max-height:520px; }
.badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12.5px; font-weight:600; white-space:nowrap; }
.risk-safe, .rule-allow { color:var(--safe); background:var(--safe-bg); } .risk-consequential, .rule-confirm { color:var(--cons); background:var(--cons-bg); }
.risk-needs_user, .rule-forbid { color:var(--user); background:var(--user-bg); } .badge.plain { color:var(--muted); background:var(--code); }
.muted { color:var(--muted); } .small { font-size:14px; }
.notice { border-left:4px solid var(--accent); } .error { border-left:4px solid var(--user); } .warn { border-left:4px solid var(--cons); }
form.inline { display:flex; gap:10px; flex-wrap:wrap; }
input[type=text], input[type=url], input[type=password], textarea { font:inherit; padding:9px 11px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--ink); }
input[type=url], input[type=text] { flex:1; min-width:260px; } textarea { width:100%; min-height:96px; }
button { font:inherit; font-weight:600; padding:9px 16px; border:0; border-radius:8px; background:var(--accent); color:var(--accent-ink); cursor:pointer; }
button.secondary { background:var(--code); color:var(--ink); }
ol.timeline { list-style:none; padding:0; margin:0; } ol.timeline li { display:grid; grid-template-columns:150px 110px 1fr; gap:10px; padding:7px 0; border-bottom:1px solid var(--line); font-size:15px; }
ol.timeline .src { color:var(--muted); }
details summary { cursor:pointer; color:var(--accent); }
footer { color:var(--muted); font-size:13px; text-align:center; padding:30px 0; }
`;

export function page(title: string, body: Raw, options: { nav?: Raw } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Usher</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top"><div class="inner"><a class="brand" href="/">Usher</a><nav><a href="/viewer">Map viewer</a><a href="/dashboard">Site dashboard</a>${options.nav ?? ''}</nav></div></header>
<main>${body}</main>
<footer>Usher registry · maps hold structure, never values</footer>
</body>
</html>`;
}
