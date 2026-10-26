// The /demo page: large type for screen recording, no dependencies. Scenes are started with the
// buttons or the number keys (0 runs them all); the page only shows what the runner does.

export const DEMO_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Usher demo</title>
<link rel="stylesheet" href="/demo/demo.css">
<script src="/demo/demo.js" defer></script>
</head>
<body>
<header>
  <div class="brand">Usher <span>map · knock · log</span></div>
  <h1 id="title">Usher</h1>
  <p id="caption"></p>
  <p id="note"></p>
</header>
<main id="stage"></main>
<section id="numbers"></section>
<div id="ask" hidden><div class="ask-box"><p id="question"></p><div class="ask-buttons"><button id="yes">Yes, go ahead</button><button id="no" class="secondary">No</button></div></div></div>
<footer id="scenes"></footer>
</body>
</html>
`;

export const DEMO_CSS = `:root {
  --bg: #0d1117; --panel: #161b22; --line: #30363d; --text: #f0f3f6; --muted: #9aa4b1;
  --accent: #58a6ff; --ok: #3fb950; --bad: #ff6b6b; --wait: #e3b341;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body { min-height: 100vh; display: flex; flex-direction: column; padding: 20px 32px 0; gap: 14px; }
header { display: grid; gap: 6px; }
.brand { font-size: 22px; font-weight: 700; color: var(--accent); letter-spacing: .02em; }
.brand span { color: var(--muted); font-weight: 500; margin-left: 10px; }
h1 { font-size: 52px; line-height: 1.05; margin: 0; }
#caption { font-size: 28px; margin: 0; color: var(--text); }
#note { font-size: 20px; margin: 0; color: var(--wait); }
#note:empty, #caption:empty { display: none; }
main { flex: 1; display: grid; gap: 20px; align-content: start; }
main.one { grid-template-columns: 3fr 2fr; }
main.two { grid-template-columns: 1fr 1fr; }
main.none { grid-template-columns: 1fr; }
.panes { display: contents; }
.pane { background: var(--panel); border: 2px solid var(--line); border-radius: 14px; overflow: hidden; display: flex; flex-direction: column; min-width: 0; }
.pane.ok { border-color: var(--ok); } .pane.bad { border-color: var(--bad); } .pane.wait { border-color: var(--wait); }
.pane-head { padding: 12px 18px; display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.pane-title { font-size: 28px; font-weight: 700; }
.pane-sub { font-size: 20px; color: var(--muted); }
.frame { background: #fff; height: 44vh; display: flex; align-items: center; justify-content: center; }
.frame img { width: 100%; height: 100%; object-fit: contain; object-position: top; display: block; }
.frame .empty { color: #6b7280; font-size: 24px; }
.meters { display: grid; grid-template-columns: 1.3fr 1fr 1fr; border-top: 1px solid var(--line); }
.meters.timer-only { grid-template-columns: 1fr; }
.meter { padding: 10px 18px; }
.meter b { display: block; font-size: 40px; font-variant-numeric: tabular-nums; line-height: 1.1; }
.meter span { font-size: 18px; color: var(--muted); }
.status { padding: 10px 18px 14px; font-size: 22px; min-height: 2.2em; }
.cards { display: grid; gap: 16px; align-content: start; }
main.two .cards, main.none .cards { grid-column: 1 / -1; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); }
.card { background: var(--panel); border: 2px solid var(--line); border-radius: 14px; padding: 16px 20px; min-width: 0; }
.card.ok { border-color: var(--ok); } .card.bad { border-color: var(--bad); } .card.info { border-color: var(--accent); }
.card h2 { margin: 0 0 8px; font-size: 26px; }
.card p { margin: 4px 0; font-size: 22px; }
.card pre { margin: 8px 0 0; font-size: 19px; white-space: pre-wrap; word-break: break-word; color: #c9d1d9; background: #0b0f14; padding: 12px; border-radius: 8px; }
.card .clock { font-size: 64px; font-weight: 700; font-variant-numeric: tabular-nums; }
#numbers { display: flex; flex-wrap: wrap; gap: 12px; }
#numbers:empty { display: none; }
.num { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px 16px; }
.num span { display: block; font-size: 17px; color: var(--muted); }
.num b { font-size: 30px; font-variant-numeric: tabular-nums; }
#ask { position: fixed; inset: 0; background: rgba(0, 0, 0, .55); display: flex; align-items: center; justify-content: center; }
#ask[hidden] { display: none; }
.ask-box { background: var(--panel); border: 3px solid var(--wait); border-radius: 18px; padding: 32px 40px; max-width: 900px; }
.ask-box p { font-size: 36px; margin: 0 0 24px; }
.ask-buttons { display: flex; gap: 16px; }
button { font: inherit; font-size: 24px; padding: 12px 24px; border-radius: 10px; border: 0; background: var(--accent); color: #0d1117; font-weight: 700; cursor: pointer; }
button.secondary { background: transparent; color: var(--text); border: 2px solid var(--line); }
button:disabled { opacity: .5; cursor: default; }
footer { display: flex; flex-wrap: wrap; gap: 10px; padding: 14px 0 20px; border-top: 1px solid var(--line); }
footer button { font-size: 17px; padding: 8px 14px; background: transparent; color: var(--muted); border: 1px solid var(--line); font-weight: 500; }
footer button.current { color: var(--text); border-color: var(--accent); }
@media (max-width: 900px) { main.one, main.two { grid-template-columns: 1fr; } h1 { font-size: 36px; } .frame { height: auto; aspect-ratio: 16 / 11; } }
`;

export const DEMO_JS = `(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  let state = null;
  let offset = 0;
  let scenes = [];
  const frames = {};

  const clock = (start, end) => {
    if (!start) return '0.0 s';
    const ms = (end ?? Date.now() + offset) - start;
    return (Math.max(0, ms) / 1000).toFixed(1) + ' s';
  };
  const money = (n) => '$' + n.toFixed(4);
  const tokens = (n) => n.toLocaleString('en-GB');

  function render() {
    if (!state) return;
    $('title').textContent = state.title;
    $('caption').textContent = state.caption;
    $('note').textContent = state.note || '';
    const stage = $('stage');
    stage.className = state.panes.length === 0 ? 'none' : state.panes.length === 1 ? 'one' : 'two';
    stage.replaceChildren();
    for (const p of state.panes) {
      const pane = el('section', 'pane' + (p.tone ? ' ' + p.tone : ''));
      const head = el('div', 'pane-head');
      head.append(el('div', 'pane-title', p.title), el('div', 'pane-sub', p.subtitle || ''));
      const frame = el('div', 'frame');
      if (frames[p.id]) { const img = el('img'); img.alt = ''; img.dataset.pane = p.id; img.src = 'data:image/jpeg;base64,' + frames[p.id]; frame.append(img); }
      else frame.append(el('div', 'empty', 'waiting'));
      const meters = el('div', 'meters' + (p.counters ? '' : ' timer-only'));
      const timer = el('div', 'meter'); const t = el('b', null, clock(p.started_at, p.ended_at)); t.dataset.start = p.started_at || ''; t.dataset.end = p.ended_at || ''; t.className = 'tick';
      timer.append(t, el('span', null, 'time'));
      meters.append(timer);
      if (p.counters) {
        const tk = el('div', 'meter'); tk.append(el('b', null, tokens(p.tokens)), el('span', null, 'model tokens'));
        const c = el('div', 'meter'); c.append(el('b', null, money(p.cost_usd)), el('span', null, 'model cost'));
        meters.append(tk, c);
      }
      pane.append(head, frame, meters, el('div', 'status', p.status));
      stage.append(pane);
    }
    if (state.cards.length) {
      const cards = el('div', 'cards');
      for (const c of state.cards) {
        const card = el('div', 'card' + (c.tone ? ' ' + c.tone : ''));
        card.append(el('h2', null, c.title));
        if (c.timer) { const t = el('div', 'clock tick', clock(c.timer.started_at, c.timer.ended_at)); t.dataset.start = c.timer.started_at; t.dataset.end = c.timer.ended_at || ''; card.append(t); }
        for (const line of c.lines || []) card.append(el('p', null, line));
        if (c.code) card.append(el('pre', null, c.code));
        cards.append(card);
      }
      stage.append(cards);
    }
    const numbers = $('numbers');
    numbers.replaceChildren(...state.numbers.map(([k, v]) => { const n = el('div', 'num'); n.append(el('span', null, k), el('b', null, v)); return n; }));
    $('ask').hidden = !state.ask;
    if (state.ask) $('question').textContent = state.ask.question;
    for (const b of document.querySelectorAll('footer button')) { b.disabled = state.running; b.classList.toggle('current', b.dataset.scene === state.scene); }
  }

  function tick() {
    for (const t of document.querySelectorAll('.tick')) t.textContent = clock(Number(t.dataset.start) || 0, Number(t.dataset.end) || undefined);
    requestAnimationFrame(tick);
  }

  function start(scene) {
    if (!state || state.running) return;
    fetch('/demo/run/' + scene, { method: 'POST' });
  }

  function renderScenes() {
    const footer = $('scenes');
    footer.replaceChildren(...scenes.map((s, i) => { const b = el('button', null, (i + 1) + '  ' + s.title); b.dataset.scene = s.id; b.onclick = () => start(s.id); return b; }));
    const all = el('button', null, '0  all'); all.dataset.scene = 'all'; all.onclick = () => start('all'); footer.append(all);
  }

  const events = new EventSource('/demo/events');
  events.addEventListener('scenes', (e) => { scenes = JSON.parse(e.data); renderScenes(); render(); });
  events.addEventListener('state', (e) => { state = JSON.parse(e.data); offset = state.now - Date.now(); render(); });
  events.addEventListener('frame', (e) => {
    const f = JSON.parse(e.data);
    frames[f.pane] = f.data;
    const img = document.querySelector('img[data-pane="' + f.pane + '"]');
    if (img) img.src = 'data:image/jpeg;base64,' + f.data; else render();
  });

  document.addEventListener('keydown', (e) => {
    if (state && state.ask && (e.key === 'y' || e.key === 'Enter')) return void fetch('/demo/answer?yes=1', { method: 'POST' });
    if (e.key === '0') return start('all');
    const s = scenes[Number(e.key) - 1];
    if (s) start(s.id);
  });
  $('yes').onclick = () => fetch('/demo/answer?yes=1', { method: 'POST' });
  $('no').onclick = () => fetch('/demo/answer?yes=0', { method: 'POST' });
  requestAnimationFrame(tick);
})();
`;
