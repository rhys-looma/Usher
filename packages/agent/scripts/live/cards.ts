// The live demo's own screens: title cards with numbers and timers, the knock ticket, the Browser
// Use race replay and the map / knock / log diagram. Dark, large type, the site's own palette.
// Each is a whole HTML page, shown with page.setContent; timers run in the page.

const esc = (s: string | number) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `
:root { --bg:#12132c; --card:#1b1d3d; --ink:#f1ede3; --muted:#b0afc4; --line:#34365a; --accent:#c5a3ff;
  --safe:#6fd39a; --safe-bg:#173325; --cons:#f0c05a; --cons-bg:#3a2f14; --user:#f19389; --user-bg:#3b1d1a;
  --serif:"Iowan Old Style","Charter","Palatino Linotype",Palatino,Georgia,serif; }
* { box-sizing:border-box; }
html, body { margin:0; height:100%; background:var(--bg); color:var(--ink); font:28px/1.45 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
main { padding:56px 64px; height:100%; display:flex; flex-direction:column; gap:28px; }
h1 { font-family:var(--serif); font-size:64px; line-height:1.05; margin:0; letter-spacing:-0.01em; }
h1::after { content:"."; color:var(--accent); }
h2 { font-family:var(--serif); font-size:40px; margin:0; }
.label { text-transform:uppercase; letter-spacing:.12em; font-size:18px; color:var(--muted); margin:0; }
.lede { color:var(--muted); margin:0; max-width:46ch; }
.card { background:var(--card); border:1.5px solid var(--line); border-radius:14px; padding:28px 32px; }
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:20px; }
.stat b { display:block; font-family:var(--serif); font-size:60px; line-height:1.1; font-variant-numeric:tabular-nums; }
.stat span { color:var(--muted); font-size:22px; }
.timer { font-family:var(--serif); font-size:120px; line-height:1; font-variant-numeric:tabular-nums; }
.timer.done { color:var(--safe); }
code, .mono { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:.85em; }
.badge { display:inline-block; border-radius:999px; padding:2px 14px; font-size:20px; font-weight:600; }
.safe { background:var(--safe-bg); color:var(--safe); } .cons { background:var(--cons-bg); color:var(--cons); } .user { background:var(--user-bg); color:var(--user); }
.foot { margin-top:auto; color:var(--muted); font-size:20px; }
`;

const TIMER_SCRIPT = `<script>
for (const el of document.querySelectorAll('[data-start]')) {
  const tick = () => {
    const end = el.dataset.end ? Number(el.dataset.end) : Date.now();
    const s = Math.max(0, (end - Number(el.dataset.start)) / 1000) * Number(el.dataset.speed || 1);
    const cap = el.dataset.cap ? Number(el.dataset.cap) : Infinity;
    el.textContent = Math.min(s, cap).toFixed(1) + ' s';
    if (el.dataset.end || s >= cap) el.classList.add('done');
    if (!el.dataset.end && s < cap) requestAnimationFrame(tick);
  };
  tick();
}
window.stopTimer = (id, end) => { const el = document.getElementById(id); el.dataset.end = String(end); el.classList.add('done'); };
</script>`;

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main>${TIMER_SCRIPT}</body></html>`;

export interface Stat {
  value: string | number;
  label: string;
}

/** A scene card: label, title, a line of context, numbers, and an optional running timer. */
export function sceneCard(o: { label: string; title: string; lede?: string; stats?: Stat[]; timer?: { id: string; start: number; end?: number; caption: string }; foot?: string }): string {
  return page(
    o.title,
    `<p class="label">${esc(o.label)}</p><h1>${esc(o.title)}</h1>${o.lede ? `<p class="lede">${esc(o.lede)}</p>` : ''}
${o.timer ? `<div class="card"><div class="timer" id="${esc(o.timer.id)}" data-start="${o.timer.start}"${o.timer.end ? ` data-end="${o.timer.end}"` : ''}>0.0 s</div><p class="lede">${esc(o.timer.caption)}</p></div>` : ''}
${o.stats?.length ? `<div class="stats">${o.stats.map((s) => `<div class="card stat"><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join('')}</div>` : ''}
${o.foot ? `<p class="foot">${esc(o.foot)}</p>` : ''}`,
  );
}

export interface Ticket {
  purpose: string;
  session: string;
  agent: string;
  identity: string;
  knocks: { path: string; match: string }[];
  byMeaning: number;
  confirm: string[];
  userOnly: string[];
  fields: number;
  digest: string;
}

/** What the last knock got: the map, the rules and the pass, as a ticket. */
export function ticketCard(t: Ticket, passMinutes: number): string {
  return page(
    'The ticket',
    `<p class="label">The last knock</p><h1>${esc(t.purpose)}</h1>
<div class="card" style="display:grid;grid-template-columns:1fr 280px;gap:0;padding:0;transform:rotate(-1deg);max-width:1100px">
<div style="padding:32px 36px;display:flex;flex-direction:column;gap:16px">
<p class="label">Agent</p><p style="margin:0" class="mono">${esc(t.agent)} <span class="badge safe">${esc(t.identity)}</span></p>
<p class="label">The map</p><p style="margin:0">${t.fields} fields by meaning · <span class="mono">${esc(t.digest.slice(0, 19))}…</span></p>
<p class="label">The rules</p>
<p style="margin:0">${t.confirm.map((k) => `<span class="badge cons">${esc(k)}</span> `).join('')}<span class="muted" style="color:var(--muted)"> needs the user's OK</span></p>
<p style="margin:0">${t.userOnly.map((k) => `<span class="badge user">${esc(k)}</span> `).join('')}<span style="color:var(--muted)"> the user's alone</span></p>
</div>
<div style="border-left:2px dashed var(--line);padding:32px 28px;display:flex;flex-direction:column;gap:12px">
<p class="label">Session</p><b class="mono" style="font-size:22px;word-break:break-all">${esc(t.session)}</b>
<p class="label">Knocks</p><b style="font-family:var(--serif);font-size:56px;line-height:1">${t.knocks.length}</b><span style="color:var(--muted);font-size:20px">${t.knocks.map((k) => `${esc(k.path)} · ${esc(k.match)}`).join('<br>')}</span>
<p class="label">Done by meaning</p><b style="font-family:var(--serif);font-size:56px;line-height:1">${t.byMeaning}</b>
</div></div>
<p class="foot">Structure only: what each field means and what was done to it, never what anyone typed. The pass is signed by the registry and lasts ${passMinutes} minutes.</p>`,
  );
}

export interface RaceSide {
  title: string;
  seconds: number;
  steps: { at: number; what: string }[];
}

/** Two recorded runs side by side, replayed against their own clocks. */
export function raceCard(left: RaceSide, right: RaceSide, note: string, speed: number): string {
  const side = (s: RaceSide, id: string) => `<div class="card" style="display:flex;flex-direction:column;gap:14px;min-height:0">
<h2>${esc(s.title)}</h2>
<div class="timer" id="${id}" data-cap="${s.seconds}">0.0 s</div>
<p class="label"><span id="${id}-n">0</span> of ${s.steps.length} actions</p>
<ol id="${id}-steps" style="margin:0;padding-left:1.4em;font-size:22px;color:var(--muted);overflow:hidden;flex:1"></ol></div>`;
  return page(
    'The race',
    `<p class="label">Browser Use on Muse Spark, the same quote, replayed from the recorded runs</p>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:28px;flex:1;min-height:0">${side(left, 'left')}${side(right, 'right')}</div>
<p class="foot">${esc(note)}</p>
<script>
const runs = { left: ${JSON.stringify(left)}, right: ${JSON.stringify(right)} };
const speed = ${speed};
window.startRace = () => {
  const t0 = performance.now();
  for (const [id, run] of Object.entries(runs)) {
    const el = document.getElementById(id), list = document.getElementById(id + '-steps'), n = document.getElementById(id + '-n');
    let shown = 0;
    const tick = () => {
      const s = Math.min(run.seconds, ((performance.now() - t0) / 1000) * speed);
      el.textContent = s.toFixed(1) + ' s';
      while (shown < run.steps.length && run.steps[shown].at <= s) {
        const li = document.createElement('li'); li.value = shown + 1; li.textContent = run.steps[shown].what; list.appendChild(li);
        if (list.children.length > 12) list.removeChild(list.firstChild);
        n.textContent = String(++shown);
      }
      if (s < run.seconds) requestAnimationFrame(tick); else el.classList.add('done');
    };
    tick();
  }
};
</script>`,
  );
}

/** A refused request, as the site answered it. */
export function refusalCard(o: { request: string; status: number; body: string; then: string }): string {
  return page(
    'Rules hold',
    `<p class="label">Rules hold</p><h1>No knock, no quote</h1>
<div class="card"><p class="label">An agent skips the page and calls the API</p><p class="mono" style="margin:8px 0 0">${esc(o.request)}</p></div>
<div class="card" style="border-color:var(--user)"><p class="label">The site answers</p><p style="margin:8px 0"><span class="badge user">HTTP ${o.status}</span></p><pre class="mono" style="margin:0;white-space:pre-wrap;font-size:22px">${esc(o.body)}</pre></div>
<p class="foot">${esc(o.then)}</p>`,
  );
}

/** The map / knock / log diagram, with the Meta models labelled by their jobs. */
export function diagramCard(): string {
  const box = (x: number, n: string, title: string, lines: string[]) => `<g transform="translate(${x},150)">
<rect width="460" height="300" rx="18" fill="#1b1d3d" stroke="#f1ede3" stroke-width="2"/>
<text x="32" y="56" fill="#b0afc4" font-size="20" letter-spacing="3">${n}</text>
<text x="32" y="112" fill="#f1ede3" font-family="Iowan Old Style,Georgia,serif" font-size="56" font-weight="700">${title}</text>
${lines.map((l, i) => `<text x="32" y="${170 + i * 38}" fill="#b0afc4" font-size="26">${esc(l)}</text>`).join('')}</g>`;
  const model = (x: number, y: number, w: number, name: string, job: string) => `<g transform="translate(${x},${y})">
<rect width="${w}" height="104" rx="52" fill="#2a2152" stroke="#c5a3ff" stroke-width="2"/>
<text x="${w / 2}" y="44" text-anchor="middle" fill="#c5a3ff" font-size="26" font-weight="700">${esc(name)}</text>
<text x="${w / 2}" y="78" text-anchor="middle" fill="#f1ede3" font-size="22">${esc(job)}</text></g>`;
  const arrow = (x: number) => `<path d="M${x} 300 h52" stroke="#c5a3ff" stroke-width="4" marker-end="url(#a)"/>`;
  // Each box's models stacked in its column, joined to it by one line.
  const column = (x: number, pills: [string, string][]) =>
    `<path d="M${x + 230} 450 V500" stroke="#c5a3ff" stroke-width="2" stroke-dasharray="6 6"/>${pills.map(([name, job], i) => model(x, 500 + i * 124, 460, name, job)).join('')}`;
  return page(
    'Map, knock, log',
    `<svg viewBox="0 0 1600 880" style="width:100%;height:100%" font-family="Inter,system-ui,sans-serif" role="img" aria-label="Map, knock and log, with the Meta models that do each job">
<defs><marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="#c5a3ff"/></marker></defs>
<text x="40" y="80" fill="#f1ede3" font-family="Iowan Old Style,Georgia,serif" font-size="60" font-weight="700">Map, knock, log<tspan fill="#c5a3ff">.</tspan></text>
${box(40, 'I', 'Map', ['Each form, by what its fields', 'mean and which buttons matter.', 'Structure, never values.'])}
${arrow(504)}
${box(570, 'II', 'Knock', ['The agent says who it is and', 'gets the map, the site\u2019s rules', 'and a short-lived pass.'])}
${arrow(1034)}
${box(1100, 'III', 'Log', ['The site sees what each agent', 'did, step by step, by meaning.', 'People are never tracked.'])}
${column(40, [['Muse Spark', 'labels each field by meaning'], ['Muse Spark Open', 'second opinion on risk'], ['The keeper', 'Spark Open triages a change, Spark rebuilds']])}
${column(570, [['Muse Spark', 'turns plain-English rules into policy']])}
${column(1100, [['Muse Spark', 'explains sessions to the site owner']])}
</svg>`,
  );
}
