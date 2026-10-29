// The look of Usher's cards: the MCP Apps widget (packages/mcp/src/apps.ts) and the front page's
// illustration of it use the same rules, scoped under .uc, so what the page shows is what a client
// renders. Colours come from the usual custom properties (--card, --ink, --accent, …). A site's
// theme (core theme.ts) sets only --accent, --btn, --btn-ink, --band, --band-ink, --font,
// --title-font and --radius; without one, each falls back to Usher's own.

/** The palette, light and dark, as custom property declarations. */
export const CARD_LIGHT = '--bg:#fbf9f4; --card:#fffdf8; --ink:#191942; --muted:#5b5f7a; --line:#d9d4c7; --rule:#191942; --accent:#7434d3; --cons:#8a5a00; --cons-bg:#f8edd2; --user:#a1251b; --user-bg:#f7e2de; --safe:#0f7a3d; --safe-bg:#e3f1e6;';
export const CARD_DARK = '--bg:#12132c; --card:#1b1d3d; --ink:#f1ede3; --muted:#b0afc4; --line:#34365a; --rule:#f1ede3; --accent:#c5a3ff; --cons:#f0c05a; --cons-bg:#3a2f14; --user:#f19389; --user-bg:#3b1d1a; --safe:#6fd39a; --safe-bg:#173325;';

export const CARD_CSS = `
.uc .card { background:var(--card); border:1.5px solid var(--rule); border-radius:var(--radius,0); padding:16px 18px; margin:0; color:var(--ink); overflow:hidden; }
.uc .band { display:flex; align-items:center; gap:10px; margin:-16px -18px 14px; padding:9px 18px; background:var(--band); color:var(--band-ink); }
.uc .band img { height:28px; max-width:140px; object-fit:contain; display:block; }
.uc .band .name { font-weight:700; font-size:15px; }
.uc .band .via { margin-left:auto; font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; opacity:.9; white-space:nowrap; }
.uc .label { font-size:11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin:0; }
.uc .title { font-family:var(--title-font,var(--serif)); font-size:22px; line-height:1.2; margin:4px 0 2px; }
.uc .title::after { content:"."; color:var(--accent); }
.uc .where { color:var(--muted); font-size:13px; margin:0 0 10px; word-break:break-all; }
.uc .asking { display:inline-block; font-size:12.5px; font-weight:600; background:var(--cons-bg); color:var(--cons); padding:2px 10px; border-radius:999px; margin:0 0 12px; }
.uc .row { border-top:1px dotted var(--line); padding:10px 0; }
.uc .row:first-of-type { border-top:0; }
.uc label.check { display:flex; gap:10px; align-items:flex-start; cursor:pointer; }
.uc label.check input { margin-top:3px; width:18px; height:18px; accent-color:var(--accent); flex:none; }
.uc .verbatim { white-space:pre-wrap; }
.uc .terms { margin:8px 0 0 28px; font-size:13px; color:var(--muted); border-left:2px solid var(--line); padding-left:10px; max-height:140px; overflow:auto; white-space:pre-wrap; }
.uc .terms a, .uc a { color:var(--ink); text-decoration-color:var(--accent); text-underline-offset:3px; }
.uc .tag { font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; border-radius:999px; padding:1px 8px; margin-left:6px; white-space:nowrap; }
.uc .req { background:var(--user-bg); color:var(--user); }.uc .opt { background:var(--safe-bg); color:var(--safe); }
.uc .yesno { display:flex; gap:14px; margin:8px 0 0 28px; font-size:14px; }
.uc .yesno label { display:flex; gap:6px; align-items:center; cursor:pointer; }
.uc .said { margin:6px 0 0; font-size:14px; color:var(--muted); }
.uc .disclosure { margin:6px 0 0 28px; font-size:13px; color:var(--muted); white-space:pre-wrap; }
.uc input[type=text], .uc select { width:100%; font:inherit; color:var(--ink); background:var(--bg); border:1.5px solid var(--line); border-radius:var(--radius,0); padding:7px 9px; margin-top:6px; }
.uc button { font:inherit; font-weight:600; background:var(--btn,var(--rule)); color:var(--btn-ink,var(--card)); border:0; border-radius:var(--radius,0); padding:10px 18px; cursor:pointer; margin-top:12px; }
.uc button:disabled { opacity:.5; cursor:default; }
.uc .note { font-size:12.5px; color:var(--muted); margin:8px 0 0; }
.uc .warn { color:var(--user); }
.uc .ticket { display:grid; grid-template-columns:minmax(0,1fr) 92px; padding:0; }
.uc .ticket-main { padding:16px 18px; }
.uc .ticket dl { margin:10px 0 0; display:grid; gap:7px; }
.uc .ticket dl div { display:grid; grid-template-columns:92px 1fr; gap:10px; border-top:1px dotted var(--line); padding-top:7px; }
.uc .ticket dt { font-size:10.5px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); padding-top:2px; }
.uc .ticket dd { margin:0; font-size:14px; }
.uc .stub { border-left:1.5px dashed var(--rule); padding:16px 8px; display:flex; flex-direction:column; align-items:center; justify-content:space-between; text-align:center; gap:6px; }
.uc .stub b { font-family:var(--title-font,var(--serif)); font-size:24px; writing-mode:vertical-rl; transform:rotate(180deg); letter-spacing:.06em; }
.uc .stub span:last-child { font-size:11px; color:var(--muted); }
.uc .facts { list-style:none; margin:10px 0 0; padding:0; }
.uc .facts li { border-top:1px dotted var(--line); padding:7px 0; font-size:15px; }
.uc .facts li:first-child { border-top:0; font-family:var(--title-font,var(--serif)); font-size:22px; font-weight:700; }
.uc .thumb { display:block; width:100%; max-height:180px; object-fit:cover; object-position:top; border:1px solid var(--line); margin-top:10px; }
.uc .outcome { font-weight:700; }
.uc .outcome.ok { color:var(--safe); }.uc .outcome.no { color:var(--user); }
@media (max-width:420px) { .uc .ticket { grid-template-columns:1fr; }.uc .stub { border-left:0; border-top:1.5px dashed var(--rule); flex-direction:row; padding:10px 18px; }.uc .stub b { writing-mode:horizontal-tb; transform:none; }.uc .ticket dl div { grid-template-columns:1fr; gap:1px; } }
`;
