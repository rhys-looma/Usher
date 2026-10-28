// The walkthrough's pages: the dashboard card ("Map my site"), the start form, the live view while a
// run walks the site (masked frames and a step log, streamed), and the result: each page's masked
// screenshot with every element's box drawn over it, coloured by risk and tagged with its key, the
// same elements as a table, both linked (hover or focus one and the other lights), each element
// correctable inline, and a Publish button. The same annotated view serves the public picker's forms.

import type { UsherMap } from '@usher/core';
import { vocabulary } from '@usher/core';
import type { WalkthroughPage, WalkthroughRun } from '../walkthrough.ts';
import { esc, html, page, when, type Raw } from './html.ts';

const RISK_NAMES: Record<string, string> = { safe: 'safe', consequential: 'consequential', needs_user: 'the person\'s' };

export const ANNOTATE_STYLE = `
.annotated { position:relative; display:inline-block; max-width:100%; border:1px solid var(--line); background:var(--card); }
.annotated img { display:block; max-width:100%; height:auto; }
.annotated .box { position:absolute; border:2px solid; border-radius:3px; text-decoration:none; outline-offset:2px; }
.annotated .box span { position:absolute; left:-2px; top:-1.45em; font:600 11px/1.3 Inter,system-ui,sans-serif; padding:1px 5px; border-radius:3px 3px 3px 0; white-space:nowrap; color:#fff; }
.annotated .box.safe { border-color:#0f7a3d; } .annotated .box.safe span { background:#0f7a3d; }
.annotated .box.consequential { border-color:#b26a00; } .annotated .box.consequential span { background:#b26a00; }
.annotated .box.needs_user { border-color:#b3261e; } .annotated .box.needs_user span { background:#b3261e; }
.annotated .box.lit, .annotated .box:focus { box-shadow:0 0 0 4px rgba(116,52,211,.45); z-index:2; }
table.elements tr.lit { background:rgba(116,52,211,.10); }
table.elements td { vertical-align:top; }
.pages { display:grid; gap:28px; }
.page-head { display:flex; flex-wrap:wrap; gap:8px 18px; align-items:baseline; }
.leads { display:flex; align-items:center; gap:10px; margin:8px 0 0; font-size:14px; }
.leads img { width:120px; border:1px solid var(--line); }
.risk-dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; vertical-align:0; }
.risk-dot.safe { background:#0f7a3d; } .risk-dot.consequential { background:#b26a00; } .risk-dot.needs_user { background:#b3261e; }
.live { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(0,1fr); gap:18px; align-items:start; }
.browser { border:1.5px solid var(--line); border-radius:10px; overflow:hidden; background:var(--card); }
.browser .bar { display:flex; gap:6px; align-items:center; padding:8px 12px; border-bottom:1px solid var(--line); font-size:13px; color:var(--muted); }
.browser .bar i { width:10px; height:10px; border-radius:50%; background:var(--line); display:inline-block; }
.browser img { display:block; width:100%; min-height:240px; background:#eef0f3; }
ol.steplog { margin:0; padding-left:20px; font-size:14px; max-height:520px; overflow:auto; }
ol.steplog li { margin:4px 0; }
details.correct { display:inline-block; margin-left:10px; font-size:13px; } details.correct summary { cursor:pointer; color:var(--accent,#7434d3); }
details.correct[open] { display:block; margin:8px 0 0; }
form.correct button { padding:4px 12px; font-size:13px; }
form.correct { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
form.correct input, form.correct select { font:inherit; font-size:13px; padding:3px 6px; }
form.correct input[name=key] { width:15em; } form.correct input[name=label] { width:14em; }
@media (max-width:860px) { .live { grid-template-columns:minmax(0,1fr); } }
`;

/** One page's screenshot with its elements' boxes over it, and the same elements as a table. */
export function annotated(input: { map: UsherMap; screenshot: string; width: number; height: number }, options: { editable?: { path: string }; anchor?: string } = {}): Raw {
  const { map } = input;
  const pct = (n: number, of: number) => `${Math.max(0, Math.min(100, (n / of) * 100)).toFixed(3)}%`;
  const elements = [...map.fields, ...map.actions].filter((e) => e.box && e.box.width > 0 && e.box.height > 0);
  const prefix = options.anchor ?? 'p';
  const box = (e: (typeof elements)[number]) =>
    html`<a class="box ${e.risk}" id="${prefix}-box-${e.id}" href="#${prefix}-row-${e.id}" data-el="${prefix}-${e.id}" style="left:${pct(e.box!.x, input.width)};top:${pct(e.box!.y, input.height)};width:${pct(e.box!.width, input.width)};height:${pct(e.box!.height, input.height)}" aria-label="${e.label || e.key}: ${e.key}, ${RISK_NAMES[e.risk]}"><span>${e.key}</span></a>`;
  const keys = vocabulary.entries.map((v) => v.key);
  const row = (e: UsherMap['fields'][number] | UsherMap['actions'][number]) => {
    const control = 'control' in e ? e.control : e.kind;
    const condition = 'shown_if' in e && e.shown_if ? html`<br><small class="muted">shown when ${e.shown_if.field} is ${String(e.shown_if.value ?? '')}</small>` : '';
    const leads = 'leads_to' in e && e.leads_to ? html`<br><small class="muted">leads to ${e.leads_to}</small>` : '';
    const edit = options.editable
      ? html`<code>${e.key}</code><details class="correct"><summary>Correct</summary><form class="correct" method="post" action="/dashboard/walkthrough/correct"><input type="hidden" name="path" value="${options.editable.path}"><input type="hidden" name="id" value="${e.id}"><input name="key" value="${e.key}" list="vocab" aria-label="Key for ${e.label}"><select name="risk" aria-label="Risk for ${e.label}">${['safe', 'consequential', 'needs_user'].map((r) => html`<option value="${r}"${r === e.risk ? ' selected' : ''}>${RISK_NAMES[r]}</option>`)}</select><input name="label" value="${e.label}" aria-label="Label"><button type="submit">Save</button></form></details>`
      : html`<code>${e.key}</code>`;
    return html`<tr id="${prefix}-row-${e.id}" data-el="${prefix}-${e.id}"><td>${e.box ? html`<a href="#${prefix}-box-${e.id}">${e.label || '(no label)'}</a>` : e.label || '(no label)'}${condition}${leads}</td><td>${control}</td><td><span class="risk-dot ${e.risk}"></span>${RISK_NAMES[e.risk]}</td><td>${edit}</td></tr>`;
  };
  return html`<div class="annotated"><img src="data:image/png;base64,${input.screenshot}" alt="The page as Usher saw it, inputs masked, with a box over each element it mapped" width="${input.width}" height="${input.height}">${elements.map(box)}</div>
<table class="elements"><thead><tr><th>Element</th><th>Control</th><th>Risk</th><th>Key</th></tr></thead><tbody>${[...map.fields, ...map.actions].map(row)}</tbody></table>
${options.editable ? html`<datalist id="vocab">${keys.map((k) => html`<option value="${k}">`)}</datalist>` : ''}`;
}

/** The dashboard card: start a walkthrough, or why it can't start, and the last run. */
export function walkthroughCard(input: { origin: string; refusal: string | null; last: WalkthroughRun | null }): Raw {
  const last = input.last;
  return html`<div class="card"><h2>Map my site</h2>
<p>Usher walks your journey in its own browser with test answers, tries every option to see what each one shows, labels every page with Muse Spark (three runs where it matters), and shows you each page with what it found. Nothing is published until you say so.</p>
${last ? html`<p class="small">Last run ${when(last.started_at)}: <b>${last.status}</b>${last.reason ? html` (${last.reason})` : ''}, ${last.pages.length} page${last.pages.length === 1 ? '' : 's'}. <a href="/dashboard/walkthrough">See it</a>.</p>` : ''}
${input.refusal ? html`<p><button type="button" disabled>Map my site</button></p><p class="small muted">${input.refusal}</p>` : html`<p><a class="button" href="/dashboard/walkthrough/new">Map my site</a></p>`}</div>`;
}

/** The start form: the first page, the test answers, whether the last button may be pressed. */
export function startForm(origin: string, error?: string): string {
  return page(
    'Map my site',
    html`<h1>Map my site</h1>
${error ? html`<div class="card error">${error}</div>` : ''}
<form class="card stack" method="post" action="/dashboard/walkthrough">
<label>First page of the journey<input name="start" required value="${origin}/" pattern="${esc(origin).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*"></label>
<label><input type="checkbox" name="generated" value="1" checked> Use a generated test person (fictional; nothing about anyone real)</label>
<label>Or your own test answers, one per line as <code>key: value</code> (for example <code>person.first_name: Test</code>)<textarea name="values" rows="6"></textarea></label>
<label><input type="checkbox" name="final" value="1"> Press the last button too (the one that submits), on this test run</label>
<p class="small muted">Test answers stay in the run's memory: they are never stored, logged, sent to the model or shown in a screenshot (every input is masked), and are gone when the run ends. One run per day; it counts against the daily model budget.</p>
<button type="submit">Start</button></form>`,
  );
}

/** While it runs: masked frames and the step log, streamed; on finish the page reloads to the result. */
export function liveView(run: WalkthroughRun, events: string): Raw {
  return html`<div class="live" data-events="${events}" id="walkthrough-live">
<div class="browser"><div class="bar"><i></i><i></i><i></i><span id="live-url">${run.start}</span></div><img id="live-frame" alt="Usher's browser, inputs masked" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div>
<div><h2>What Usher is doing</h2><ol class="steplog" id="live-log">${run.log.map((l) => html`<li>${l}</li>`)}</ol>
<form method="post" action="/dashboard/walkthrough/cancel"><input type="hidden" name="id" value="${run.id}"><button type="submit">Stop</button></form>
<p class="small muted">You can close this page: the run carries on, and the result waits here.</p></div></div>`;
}

/** The finished run: each page annotated, in order, with what leads where, the diff and Publish. */
export function resultView(run: WalkthroughRun, options: { editable: boolean; publishAction?: string }): Raw {
  const pageFor = (path: string) => run.pages.find((p) => p.path === path);
  const section = (p: WalkthroughPage, i: number) => {
    const next = p.leads_to ? pageFor(p.leads_to) : undefined;
    const diff = run.diff?.find((d) => d.path === p.path);
    return html`<section class="card" id="page-${String(i + 1)}"><div class="page-head"><h2>${String(i + 1)}. ${p.title || p.path}</h2><code>${p.path}</code><span class="small muted">${p.map.provenance.votes ? `labelled in ${p.map.provenance.votes.runs} run${p.map.provenance.votes.runs === 1 ? '' : 's'}` : ''}</span></div>
${annotated(p, { anchor: `p${i + 1}`, ...(options.editable && { editable: { path: p.path } }) })}
${p.conditions.length ? html`<p class="small"><b>What the options show:</b> ${p.conditions.map((c) => html`"${c.label}" shows ${String(c.reveals.length)} more field${c.reveals.length === 1 ? '' : 's'}; `)}</p>` : ''}
${p.unexplored.length ? html`<p class="small muted"><b>Seen but not mapped in this run</b> (only another option shows them): ${p.unexplored.join(', ')}.</p>` : ''}
${p.lists.length ? html`<p class="small"><b>Lists that appear:</b> ${p.lists.map((l) => html`${l.via}: ${String(l.options)} entries; `)}</p>` : ''}
${diff && (diff.added.length || diff.removed.length || diff.changed.length) ? html`<p class="small"><b>Against the map agents get now:</b> ${diff.added.length ? `new: ${diff.added.join(', ')}. ` : ''}${diff.changed.length ? `changed: ${diff.changed.join(', ')}. ` : ''}${diff.removed.length ? `gone: ${diff.removed.join(', ')}.` : ''}</p>` : ''}
${next ? html`<p class="leads">Leads to <a href="#page-${String(run.pages.indexOf(next) + 1)}">${next.path}</a><img src="data:image/png;base64,${next.screenshot}" alt="Next page, ${next.path}"></p>` : p.leads_to ? html`<p class="leads">Leads to <code>${p.leads_to}</code> (the result page).</p>` : ''}
</section>`;
  };
  return html`<p>Run of ${when(run.started_at)}: <b>${run.status}</b>${run.reason ? html` (${run.reason})` : ''}. ${String(run.pages.length)} page${run.pages.length === 1 ? '' : 's'}, model spend $${run.cost_usd.toFixed(3)}.${run.published_at ? html` Published ${when(run.published_at)}.` : ''}</p>
${options.publishAction && run.pages.length && !run.published_at ? html`<form method="post" action="${options.publishAction}"><button type="submit">Publish these maps</button> <span class="small muted">Agents get them from then on.</span></form>` : ''}
<details><summary>Step log</summary><ol class="steplog">${run.log.map((l) => html`<li>${l}</li>`)}</ol></details>
<div class="pages">${run.pages.map(section)}</div>`;
}

/** The whole walkthrough page: live while running, the result after. */
export function walkthroughPage(run: WalkthroughRun | null, options: { editable: boolean; events?: string; publishAction?: string; title?: string }): string {
  return page(
    options.title ?? 'Map my site',
    html`<h1>${options.title ?? 'Map my site'}</h1>
${!run ? html`<p>No walkthrough yet. <a href="/dashboard/walkthrough/new">Start one</a>.</p>` : run.status === 'running' && options.events ? liveView(run, options.events) : resultView(run, options)}`,
    { scripts: ['/walkthrough.js'], style: ANNOTATE_STYLE },
  );
}

/** The live view's script and the annotations' linking: served from this origin (/walkthrough.js). */
export const WALKTHROUGH_JS = `(() => {
  // Hover or focus a box or a row, and its pair lights.
  const pair = (el) => document.querySelectorAll('[data-el="' + el.getAttribute('data-el') + '"]');
  for (const el of document.querySelectorAll('[data-el]')) {
    const on = () => pair(el).forEach((n) => n.classList.add('lit'));
    const off = () => pair(el).forEach((n) => n.classList.remove('lit'));
    el.addEventListener('mouseenter', on); el.addEventListener('mouseleave', off);
    el.addEventListener('focusin', on); el.addEventListener('focusout', off);
  }
  // The live view: masked frames and the step log over server-sent events.
  const live = document.getElementById('walkthrough-live');
  if (!live || !('EventSource' in window)) return;
  const frame = document.getElementById('live-frame');
  const log = document.getElementById('live-log');
  const source = new EventSource(live.getAttribute('data-events'));
  let seen = log.children.length;
  source.addEventListener('frame', (e) => { frame.src = 'data:image/jpeg;base64,' + e.data; });
  source.addEventListener('log', (e) => {
    if (seen > 0) { seen--; return; }
    const li = document.createElement('li'); li.textContent = e.data; log.appendChild(li); log.scrollTop = log.scrollHeight;
  });
  source.addEventListener('done', () => { source.close(); setTimeout(() => location.reload(), 600); });
})();
`;
