// The walkthrough's pages: the dashboard card ("Map my site"), the start form, the live view while a
// run walks the site (masked frames and a step log, streamed), and the result: each page's masked
// screenshot with every element's box drawn over it, coloured by risk and tagged with its key, the
// same elements as a table, both linked (hover or focus one and the other lights), each element
// correctable inline, and a Publish button. The same annotated view serves the public picker's forms.

import type { UsherMap } from '@usher/core';
import { RISKS, vocabulary } from '@usher/core';
import type { ChatMessage, EditProposal, WalkthroughPage, WalkthroughRun } from '../walkthrough.ts';
import { esc, html, page, when, type Raw } from './html.ts';
import { TOOLS_STYLE, flowStrip, stepNames, type FlowStep } from './tools.ts';

const RISK_NAMES: Record<string, string> = { safe: 'safe', consequential: 'consequential', needs_user: 'the person\'s' };
const RISK_CHOICES: Record<string, string> = {
  safe: 'Safe: an agent may fill it',
  consequential: 'Consequential: the agent checks with the person first',
  needs_user: 'The person\'s: only the person gives it',
};

/** A condition in words, with the other field's label and the option's label rather than keys and values. */
export function shownWhen(map: UsherMap, c: NonNullable<UsherMap['fields'][number]['shown_if']>): string {
  const field = map.fields.find((f) => f.key === c.field);
  const name = field?.label ? `“${field.label}”` : c.field;
  const option = (v: string) => `“${field?.options?.items.find((o) => o.value === v)?.label ?? v}”`;
  const values = Array.isArray(c.value) ? c.value : c.value === undefined ? [] : [c.value];
  if (c.op === 'checked') return `Shown when ${name} is ticked`;
  if (c.op === 'filled') return `Shown when ${name} is filled in`;
  if (c.op === 'not_equals') return `Shown unless ${name} is ${values.map(option).join(' or ')}`;
  return `Shown when ${name} is ${values.map(option).join(' or ')}`;
}

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
table.elements th, table.elements td { padding:10px 12px 10px 0; }
table.elements .meaning { display:block; margin-top:4px; max-width:28em; }
table.elements .note { display:block; margin-top:4px; font-size:13px; color:var(--muted); line-height:1.4; }
.elements .badge, .badge.new, .badge.changed { display:inline-block; margin-left:6px; padding:1px 8px; border-radius:999px; font-size:12px; font-weight:600; vertical-align:1px; }
.badge.new { background:rgba(116,52,211,.12); color:var(--accent,#7434d3); }
.badge.changed { background:rgba(178,106,0,.14); color:#8a5200; }
table.elements tr.saved { background:rgba(15,122,61,.08); }
table.elements .saved-note { display:none; margin-left:8px; font-size:13px; font-weight:600; color:#0f7a3d; }
table.elements tr.saved .saved-note { display:inline; }
.risk { display:inline-flex; align-items:center; gap:6px; white-space:nowrap; font-size:14px; }
.risk .risk-dot { margin:0; }
details.correct { margin-top:6px; font-size:14px; }
details.correct summary { display:inline-block; cursor:pointer; list-style:none; padding:3px 12px; border:1px solid var(--line); border-radius:999px; color:var(--accent,#7434d3); font-weight:600; font-size:13px; }
details.correct summary::-webkit-details-marker { display:none; }
details.correct[open] summary { background:var(--accent,#7434d3); border-color:var(--accent,#7434d3); color:#fff; }
form.correct { display:grid; gap:10px; margin-top:10px; padding:14px; border:1px solid var(--line); border-radius:10px; background:var(--card); max-width:30em; }
form.correct label { display:grid; gap:4px; font-size:13px; font-weight:600; }
form.correct label small { font-weight:400; color:var(--muted); }
form.correct input, form.correct select { font:inherit; font-size:14px; padding:6px 8px; width:100%; box-sizing:border-box; }
form.correct .row { display:flex; gap:10px; align-items:center; }
form.correct button { padding:6px 16px; font-size:14px; }
.live.talk { grid-template-columns:minmax(0,1.4fr) minmax(0,1fr); }
.browser.clickable img { cursor:pointer; outline:3px solid rgba(116,52,211,.35); outline-offset:-3px; }
.browser .hint { margin-left:auto; color:var(--accent,#7434d3); font-weight:600; }
.chat { display:flex; flex-direction:column; gap:10px; max-height:560px; overflow:auto; padding:2px 2px 8px; }
.msg { max-width:92%; padding:10px 14px; border-radius:14px; font-size:15px; line-height:1.45; }
.msg p { margin:0; }
.msg.usher { align-self:flex-start; background:var(--card); border:1px solid var(--line); border-bottom-left-radius:4px; }
.msg.owner { align-self:flex-end; background:var(--accent,#7434d3); color:#fff; border-bottom-right-radius:4px; }
.msg .thumbs { display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; }
.msg .thumbs img { width:150px; max-height:110px; object-fit:cover; object-position:top; border:1px solid var(--line); border-radius:6px; }
.msg form.choices { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
.msg form.choices button { padding:6px 12px; font-size:14px; border-radius:999px; }
.msg form.choices button:disabled { opacity:.45; cursor:default; }
.msg.thinking { color:var(--muted); font-style:italic; }
form.say { display:flex; gap:8px; margin-top:10px; align-items:flex-end; }
form.say textarea { flex:1; font:inherit; font-size:15px; padding:8px 10px; border:1px solid var(--line); border-radius:10px; resize:vertical; }
.live details summary { cursor:pointer; color:var(--muted); font-size:14px; margin-top:12px; }
@media (max-width:860px) { .live, .live.talk { grid-template-columns:minmax(0,1fr); } }
`;

/** One page's screenshot with its elements' boxes over it, and the same elements as a table. */
export function annotated(input: { map: UsherMap; screenshot: string; width: number; height: number }, options: { editable?: { path: string }; anchor?: string; status?: Record<string, 'new' | 'changed'> } = {}): Raw {
  const { map } = input;
  const pct = (n: number, of: number) => `${Math.max(0, Math.min(100, (n / of) * 100)).toFixed(3)}%`;
  const elements = [...map.fields, ...map.actions].filter((e) => e.box && e.box.width > 0 && e.box.height > 0);
  const prefix = options.anchor ?? 'p';
  const box = (e: (typeof elements)[number]) =>
    html`<a class="box ${e.risk}" id="${prefix}-box-${e.id}" href="#${prefix}-row-${e.id}" data-el="${prefix}-${e.id}" style="left:${pct(e.box!.x, input.width)};top:${pct(e.box!.y, input.height)};width:${pct(e.box!.width, input.width)};height:${pct(e.box!.height, input.height)}" aria-label="${e.label || e.key}: ${e.key}, ${RISK_NAMES[e.risk]}"><span>${e.key}</span></a>`;
  const keys = vocabulary.entries.map((v) => v.key);
  const row = (e: UsherMap['fields'][number] | UsherMap['actions'][number]) => {
    const control = 'control' in e ? e.control : e.kind;
    const rowId = `${prefix}-row-${e.id}`;
    const condition = 'shown_if' in e && e.shown_if ? html`<span class="note">${shownWhen(map, e.shown_if)}</span>` : '';
    const leads = 'leads_to' in e && e.leads_to ? html`<span class="note">Goes on to ${e.leads_to}</span>` : '';
    const meaning = vocabulary.entries.find((v) => v.key === e.key)?.meaning;
    const key = html`<code>${e.key}</code>${meaning ? html`<small class="muted meaning">${meaning}</small>` : ''}`;
    const edit = options.editable
      ? html`<details class="correct"><summary>Edit</summary><form class="correct" method="post" action="/dashboard/walkthrough/correct"><input type="hidden" name="path" value="${options.editable.path}"><input type="hidden" name="id" value="${e.id}"><input type="hidden" name="row" value="${rowId}">
<label>What it is <small>A key from the vocabulary (start typing), or custom.something</small><input name="key" value="${e.key}" list="vocab" required spellcheck="false" autocomplete="off"></label>
<label>Who decides<select name="risk">${RISKS.map((r) => html`<option value="${r}"${r === e.risk ? ' selected' : ''}>${RISK_CHOICES[r]}</option>`)}</select></label>
<label>Label <small>What agents and people call it</small><input name="label" value="${e.label}"></label>
<div class="row"><button type="submit">Save</button><span class="small muted">Saved to this run; agents see it once you publish.</span></div></form></details>`
      : '';
    return html`<tr id="${rowId}" data-el="${prefix}-${e.id}"><td>${e.box ? html`<a href="#${prefix}-box-${e.id}">${e.label || '(no label)'}</a>` : e.label || '(no label)'}${options.status?.[e.id] ? html` <span class="badge ${options.status[e.id]!}">${options.status[e.id] === 'new' ? 'New' : 'Labelled differently'}</span>` : ''}<span class="saved-note">Saved</span>${condition}${leads}</td><td>${control}</td><td><span class="risk"><span class="risk-dot ${e.risk}"></span>${RISK_NAMES[e.risk]}</span></td><td>${key}${edit}</td></tr>`;
  };
  return html`<div class="annotated"><img src="data:image/png;base64,${input.screenshot}" alt="The page as Usher saw it, inputs masked, with a box over each element it mapped" width="${input.width}" height="${input.height}">${elements.map(box)}</div>
<table class="elements"><thead><tr><th>Element</th><th>Control</th><th>Risk</th><th>What it is</th></tr></thead><tbody>${[...map.fields, ...map.actions].map(row)}</tbody></table>
${options.editable ? html`<datalist id="vocab">${keys.map((k) => html`<option value="${k}">`)}</datalist>` : ''}`;
}

/** The dashboard card: start a walkthrough, or why it can't start, and the last run. */
export function walkthroughCard(input: { origin: string; refusal: string | null; last: WalkthroughRun | null }): Raw {
  const last = input.last;
  return html`<div class="card"><h2>Map my site</h2>
<p>Usher goes through your site in its own browser with test answers, tries every option to see what each one shows, labels every page with Muse Spark (three runs where it matters), and shows you each page with what it found. Nothing is published until you say so.</p>
${last ? html`<p class="small">Last run ${when(last.started_at)}: <b>${last.status}</b>${last.reason ? html` (${last.reason})` : ''}, ${last.pages.length} page${last.pages.length === 1 ? '' : 's'}. <a href="/dashboard/walkthrough">See it</a>.</p>` : ''}
${input.refusal ? html`<p><button type="button" disabled>Map my site</button></p><p class="small muted">${input.refusal}</p>` : html`<p><a class="button" href="/dashboard/walkthrough/new">Map my site</a></p>`}
<p class="small muted">Your corrections teach the mapper: <a href="/dashboard/learning">see how</a>.</p></div>`;
}

/** The start form: the first page, update or fresh, the test answers, whether the last button may be pressed. */
export function startForm(origin: string, error?: string, state: { published?: number; unpublished?: boolean } = {}): string {
  const mode = state.published
    ? html`<fieldset class="mode"><legend>Your site has ${String(state.published)} published map${state.published === 1 ? '' : 's'}</legend>
<label><input type="radio" name="mode" value="update" checked> <b>Update them</b> <span class="small muted">Each page starts from its published map, so your corrections stay. Anything new on the page is marked for you to check.</span></label>
<label><input type="radio" name="mode" value="fresh"> <b>Start fresh</b> <span class="small muted">Muse Spark labels every page again, ignoring the published maps. What it labels differently is marked.</span></label>
<p class="small muted">Either way, the maps agents get stay as they are until you publish.</p></fieldset>`
    : '';
  return page(
    'Map my site',
    html`<h1>${state.published ? 'Update my maps' : 'Map my site'}</h1>
${error ? html`<div class="card error">${error}</div>` : ''}
${state.unpublished ? html`<div class="card warn">Your last run isn't published. Starting a new one replaces it, with any corrections you made to it. <a href="/dashboard/walkthrough">Publish it first</a>.</div>` : ''}
<form class="card stack" method="post" action="/dashboard/walkthrough">
${mode}
<label>Where to start <span class="small muted">(your home page is fine: Usher asks where to go, and can map every form in one run)</span><input name="start" placeholder="${origin}/" pattern="${esc(origin).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*"></label>
<label><input type="checkbox" name="generated" value="1" checked> Use a generated test person (fictional; nothing about anyone real)</label>
<label>Or your own test answers, one per line as <code>key: value</code> (for example <code>person.first_name: Test</code>)<textarea name="values" rows="6"></textarea></label>
<label><input type="checkbox" name="final" value="1"> Press the last button too (the one that submits), on this test run</label>
<p class="small muted">Test answers stay in the run's memory: they are never stored, logged, sent to the model or shown in a screenshot (every input is masked), and are gone when the run ends. One run per day, and a run that maps nothing doesn't count; it counts against the daily model budget. While it runs you can talk to Usher, pick where it goes, or click its browser; it never leaves your site.</p>
<button type="submit">Start</button></form>`,
    { style: '.mode { border:1px solid var(--line); border-radius:10px; padding:12px 14px; display:grid; gap:10px; } .mode legend { font-weight:600; padding:0 6px; } .mode label { display:block; } .mode label .small { display:block; margin-left:1.6em; }' },
  );
}

/** While it runs: masked frames and the step log, streamed; on finish the page reloads to the result. */
export function liveView(run: WalkthroughRun, events: string, interactive = false): Raw {
  const steplog = html`<ol class="steplog" id="live-log">${run.log.map((l) => html`<li>${l}</li>`)}</ol>`;
  const stop = html`<form method="post" action="/dashboard/walkthrough/cancel"><input type="hidden" name="id" value="${run.id}"><button type="submit" class="secondary">Stop</button></form>`;
  if (!run.chat)
    return html`<div class="live" data-events="${events}" id="walkthrough-live">
<div class="browser"><div class="bar"><i></i><i></i><i></i><span id="live-url">${run.start}</span></div><img id="live-frame" alt="Usher's browser, inputs masked" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div>
<div><h2>What Usher is doing</h2>${steplog}
${stop}
<p class="small muted">You can close this page: the run carries on, and the result waits here.</p></div></div>`;
  // The last message with choices is the one that can still be answered.
  const open = run.waiting ? run.chat.map((m) => Boolean(m.options)).lastIndexOf(true) : -1;
  return html`<div class="live talk" data-events="${events}" data-run="${run.id}" id="walkthrough-live"${interactive ? html` data-act="/dashboard/walkthrough"` : ''}${run.waiting ? html` data-waiting` : ''}>
<div class="browser${interactive && run.clickable && run.waiting ? ' clickable' : ''}" id="live-browser"${interactive && run.clickable ? html` data-clickable` : ''}><div class="bar"><i></i><i></i><i></i><span id="live-url">${run.start}</span>${interactive && run.clickable ? html`<span class="hint" id="live-hint"${run.waiting ? '' : ' hidden'}>Click the page to use it</span>` : ''}</div><img id="live-frame" alt="Usher's browser, inputs masked${interactive && run.clickable ? '; while Usher waits, clicking it clicks the page' : ''}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div>
<div><h2>Usher</h2>
<p class="small muted">Model spend this run: $<span id="live-cost">${run.cost_usd.toFixed(3)}</span>. Usher reads up to 40 messages a run, within a daily allowance for your site.</p>
<div class="chat" id="live-chat" aria-live="polite">${run.chat.map((m, i) => chatMessage(run, m, { interactive, open: i === open }))}</div>
${interactive ? html`<form class="say" method="post" action="/dashboard/walkthrough/say" id="live-say"><input type="hidden" name="id" value="${run.id}"><textarea name="text" rows="2" maxlength="500" required placeholder="Say where to go next, or ask Usher something" aria-label="Message to Usher"></textarea><button type="submit">Send</button></form>` : ''}
<details><summary>Step log</summary>${steplog}</details>
${stop}
<p class="small muted">Usher's browser stays on your site: it can't open any other address. Test answers are masked in every picture.</p></div></div>`;
}

/** One line of the conversation: words, thumbnails of the pages it's about, and its choices. */
export function chatMessage(run: Pick<WalkthroughRun, 'id' | 'pages'>, m: ChatMessage, o: { interactive: boolean; open: boolean }): Raw {
  const thumbs = m.pages?.filter((i) => run.pages[i]).length
    ? html`<div class="thumbs">${m.pages.filter((i) => run.pages[i]).map((i) => html`<a href="#page-${String(i + 1)}"><img src="/dashboard/walkthrough/shot?page=${String(i)}" alt="${run.pages[i]!.title || run.pages[i]!.path}, as Usher mapped it"></a>`)}</div>`
    : '';
  const choices = !m.options
    ? ''
    : o.interactive
      ? html`<form class="choices" method="post" action="/dashboard/walkthrough/choose"><input type="hidden" name="id" value="${run.id}">${m.options.map((c) => html`<button type="submit" name="option" value="${c.id}" title="${c.path}"${o.open ? '' : ' disabled'}>${c.label}</button>`)}<button type="submit" name="option" value="finish" class="secondary"${o.open ? '' : ' disabled'}>Finish here</button></form>`
      : html`<p class="small muted">${m.options.map((c) => c.label).join(' · ')}</p>`;
  return html`<div class="msg ${m.from}"><p>${m.text}</p>${thumbs}${choices}</div>`;
}

/** The finished run: each page annotated, in order, with what leads where, the diff and Publish. */
/** The chat editor: a sentence in, proposed changes out, nothing applied until the owner accepts. */
function editPanel(run: WalkthroughRun, edits: EditProposal | null, error?: string): Raw {
  const name = (r: string) => RISK_NAMES[r] ?? r;
  const change = (c: EditProposal['changes'][number]) =>
    html`<li><b>${c.element}</b> <span class="muted small">(${c.path})</span>: ${c.key ? html`key <code>${c.before.key}</code> → <code>${c.key}</code>; ` : ''}${c.risk ? html`risk ${name(c.before.risk)} → <b>${name(c.risk)}</b>; ` : ''}${c.label ? html`label "${c.before.label}" → "${c.label}"; ` : ''}<span class="muted">${c.why}</span></li>`;
  const pending = edits
    ? html`<div class="card notice"><p><b>You said:</b> ${edits.text}</p>
${edits.changes.length ? html`<p>Usher would make ${String(edits.changes.length)} change${edits.changes.length === 1 ? '' : 's'}:</p><ul>${edits.changes.map(change)}</ul>` : html`<p>No changes to the map came out of that.</p>`}
${edits.unclear ? html`<p class="small"><b>Not sure what you meant:</b> ${edits.unclear}</p>` : ''}
${edits.rules ? html`<p class="small"><b>That sounds like a site rule</b>, not a label: "${edits.rules}". Rules go on the <a href="/dashboard/rules">rules page</a>, where they bind every agent.</p>` : ''}
${edits.refused.length ? html`<p class="small muted"><b>Left out:</b> ${edits.refused.join('; ')}.</p>` : ''}
<form method="post" action="/dashboard/walkthrough/edit/apply" class="inline">${edits.changes.length ? html`<input type="hidden" name="id" value="${edits.id}"><button type="submit">Make these changes</button> ` : ''}<button type="submit" formaction="/dashboard/walkthrough/edit/discard" class="secondary">Discard</button></form></div>`
    : '';
  return html`<section class="card" id="edit"><h2>Change it in words</h2>
${error ? html`<div class="card error">${error}</div>` : ''}${pending}
<form method="post" action="/dashboard/walkthrough/edit"><p><label for="edit-text">Tell Usher what to change, for example "the smoker question is the person's own on every page" or "call the third field the policy number".</label></p>
<p><textarea id="edit-text" name="text" rows="3" maxlength="1000" required style="width:100%"></textarea></p>
<p><button type="submit">Suggest changes</button> <span class="small muted">Muse Spark reads the request and the map's structure; nothing changes until you accept.</span></p></form></section>`;
}

/** The conversation of a finished run, folded away above its pages. */
function transcript(run: WalkthroughRun): Raw {
  if (!run.chat?.length) return html``;
  return html`<details class="card"><summary>The conversation (${String(run.chat.length)} messages)</summary><div class="chat">${run.chat.map((m) => chatMessage(run, m, { interactive: false, open: false }))}</div></details>`;
}

export function resultView(run: WalkthroughRun, options: { editable: boolean; publishAction?: string; edits?: EditProposal | null; editError?: string }): Raw {
  const pageFor = (path: string) => run.pages.find((p) => p.path === path);
  const section = (p: WalkthroughPage, i: number) => {
    const next = p.leads_to ? pageFor(p.leads_to) : undefined;
    const diff = run.diff?.find((d) => d.path === p.path);
    return html`<section class="card" id="page-${String(i + 1)}" data-panel><div class="page-head"><h2>${String(i + 1)}. ${stepName(p)}</h2><code>${p.path}</code><span class="small muted">${p.map.provenance.votes ? `labelled in ${p.map.provenance.votes.runs} run${p.map.provenance.votes.runs === 1 ? '' : 's'}` : ''}</span></div>
${annotated(p, { anchor: `p${i + 1}`, ...(p.status && { status: p.status }), ...(options.editable && { editable: { path: p.path } }) })}
${p.conditions.length ? html`<p class="small"><b>What the options show:</b> ${p.conditions.map((c) => html`"${c.label}" shows ${String(c.reveals.length)} more field${c.reveals.length === 1 ? '' : 's'}; `)}</p>` : ''}
${p.unexplored.length ? html`<p class="small muted"><b>Seen but not mapped in this run</b> (only another option shows them): ${p.unexplored.join(', ')}.</p>` : ''}
${p.lists.length ? html`<p class="small"><b>Lists that appear:</b> ${p.lists.map((l) => html`${l.via}: ${String(l.options)} entries; `)}</p>` : ''}
${diff && (diff.added.length || diff.removed.length || diff.changed.length) ? html`<p class="small"><b>Against the map agents get now:</b> ${diff.added.length ? `new: ${diff.added.join(', ')}. ` : ''}${diff.changed.length ? `changed: ${diff.changed.join(', ')}. ` : ''}${diff.removed.length ? `gone: ${diff.removed.join(', ')}.` : ''}</p>` : ''}
${next ? html`<p class="leads">Leads to <a href="#page-${String(run.pages.indexOf(next) + 1)}">${next.path}</a><img src="data:image/png;base64,${next.screenshot}" alt="Next page, ${next.path}"></p>` : p.leads_to ? html`<p class="leads">Leads to <code>${p.leads_to}</code> (the result page).</p>` : ''}
<p class="step-nav">${i > 0 ? html`<a href="#page-${String(i)}">← ${stepName(run.pages[i - 1]!)}</a>` : ''}${i < run.pages.length - 1 ? html`<a class="next" href="#page-${String(i + 2)}">${stepName(run.pages[i + 1]!)} →</a>` : ''}</p>
</section>`;
  };
  // The run's pages by journey: one strip each, and one page open below them.
  const journeys = new Map<string, WalkthroughPage[]>();
  for (const p of run.pages) journeys.set(p.map.form.intent ?? p.path, [...(journeys.get(p.map.form.intent ?? p.path) ?? []), p]);
  const names = new Map([...journeys.values()].flatMap((pages) => {
    const short = stepNames(pages.map((p) => ({ path: p.path, purpose: p.map.form.purpose })));
    return pages.map((p, i) => [p, short[i]!] as const);
  }));
  const stepName = (p: WalkthroughPage) => names.get(p) ?? p.path;
  const flowSteps = (pages: WalkthroughPage[]): FlowStep[] => pages.map((p) => {
    const marks = Object.keys(p.status ?? {}).length;
    return { name: stepName(p), path: p.path, href: `#page-${run.pages.indexOf(p) + 1}`, ...(marks && { flag: `${marks} to check` }) };
  });
  const flows = run.pages.length > 1 ? html`<p class="small muted" style="margin:16px 0 6px">Pick a page to check it.</p>${[...journeys.values()].map((pages) => html`<div class="flow-group">${journeys.size > 1 ? html`<p>${pages[0]!.map.form.purpose.replace(/:.*$/, '')}</p>` : ''}${flowStrip(flowSteps(pages), { label: 'Pages mapped' })}</div>`)}` : '';
  const marked = run.pages.reduce((n, p) => n + Object.keys(p.status ?? {}).length, 0);
  const mode = run.mode === 'update'
    ? html`<p class="small"><b>An update of your published maps:</b> your labels and corrections are kept${marked ? html`; ${String(marked)} element${marked === 1 ? ' is' : 's are'} new and marked <span class="badge new">New</span> for you to check` : ', and nothing is new'}.</p>`
    : marked ? html`<p class="small"><b>A fresh run:</b> ${String(marked)} element${marked === 1 ? ' is' : 's are'} new or labelled differently from your published maps, and marked.</p>` : '';
  return html`${mode}<p>Run of ${when(run.started_at)}: <b>${run.status}</b>${run.reason ? html` (${run.reason})` : ''}. ${String(run.pages.length)} page${run.pages.length === 1 ? '' : 's'}, model spend $${run.cost_usd.toFixed(3)}.${run.published_at ? html` Published ${when(run.published_at)}.` : ''}</p>
${options.publishAction && run.pages.length && !run.published_at ? html`<form method="post" action="${options.publishAction}"><button type="submit">Publish these maps</button> <span class="small muted">Each one becomes a task in your assistant app, and agents get the maps from then on.</span></form>` : ''}
<details><summary>Step log</summary><ol class="steplog">${run.log.map((l) => html`<li>${l}</li>`)}</ol></details>
${flows}<div class="pages" data-panels>${run.pages.map(section)}</div>
${options.editable && run.pages.length && run.status !== 'running' ? editPanel(run, options.edits ?? null, options.editError) : ''}`;
}

/** The whole walkthrough page: live while running, the result after. */
export function walkthroughPage(run: WalkthroughRun | null, options: { editable: boolean; events?: string; publishAction?: string; title?: string; edits?: EditProposal | null; editError?: string; setup?: { strip: Raw; next: Raw | null; style: string } }): string {
  // On the owner's page: where mapping sits in the twenty minutes, and what comes after it.
  const after = options.setup && run?.published_at
    ? html`<div class="card notice"><p><b>Published.</b> Each one is a task in your assistant app now, and agents get these maps too.${options.setup.next ? html` Next: ${options.setup.next}.` : ' Your app is published.'}</p></div>`
    : '';
  return page(
    options.title ?? 'Map my site',
    html`<h1>${options.title ?? 'Map my site'}</h1>
${options.setup ? html`<p class="lede">Step two of the twenty minutes: Usher goes through your site, and you publish what it found.</p>${options.setup.strip}` : ''}${after}
${!run ? html`<p>No walkthrough yet. <a href="/dashboard/walkthrough/new">Start one</a>.</p>` : run.status === 'running' && options.events ? liveView(run, options.events, options.editable) : html`${transcript(run)}${resultView(run, options)}`}`,
    { scripts: ['/panels.js', '/walkthrough.js'], style: ANNOTATE_STYLE + TOOLS_STYLE + (options.setup?.style ?? '') },
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
  // Back from saving a correction: mark the row that changed.
  const saved = new URLSearchParams(location.search).get('saved');
  const row = saved && /^[A-Za-z0-9_-]+$/.test(saved) ? document.getElementById(saved) : null;
  if (row) { row.classList.add('saved'); row.scrollIntoView({ block: 'center' }); history.replaceState(null, '', location.pathname); }
  // The live view: masked frames and the step log over server-sent events.
  const live = document.getElementById('walkthrough-live');
  if (!live || !('EventSource' in window)) return;
  const frame = document.getElementById('live-frame');
  const log = document.getElementById('live-log');
  const source = new EventSource(live.getAttribute('data-events'));
  let seen = log.children.length;
  source.addEventListener('frame', (e) => { frame.src = 'data:image/jpeg;base64,' + e.data; });
  const address = document.getElementById('live-url');
  source.addEventListener('url', (e) => { if (address) address.textContent = e.data; });
  source.addEventListener('log', (e) => {
    if (seen > 0) { seen--; return; }
    const li = document.createElement('li'); li.textContent = e.data; log.appendChild(li); log.scrollTop = log.scrollHeight;
  });
  source.addEventListener('done', () => { source.close(); setTimeout(() => location.reload(), 600); });

  // The conversation: Usher's messages and choices arrive as events; the owner answers by choice,
  // by words or by clicking the live page while Usher waits.
  const chat = document.getElementById('live-chat');
  if (!chat) return;
  const act = live.getAttribute('data-act');
  const runId = live.getAttribute('data-run');
  const browser = document.getElementById('live-browser');
  const hint = document.getElementById('live-hint');
  let waiting = live.hasAttribute('data-waiting');
  let thinking = null;
  const post = (path, body) => fetch(act + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(Object.assign({ id: runId }, body)) });
  const closeChoices = () => chat.querySelectorAll('form.choices button').forEach((b) => { b.disabled = true; });
  const setWaiting = (w) => {
    waiting = w;
    if (hint) hint.hidden = !w;
    if (browser && act && browser.hasAttribute('data-clickable')) browser.classList.toggle('clickable', w);
    if (!w) closeChoices();
  };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const render = (m) => {
    const box = el('div', 'msg ' + m.from);
    box.appendChild(el('p', '', m.text));
    if (m.pages && m.pages.length) {
      const thumbs = el('div', 'thumbs');
      for (const i of m.pages) { const img = el('img'); img.src = '/dashboard/walkthrough/shot?page=' + i; img.alt = 'A page as Usher mapped it'; thumbs.appendChild(img); }
      box.appendChild(thumbs);
    }
    if (m.options && act) {
      closeChoices();
      const form = el('form', 'choices');
      for (const o of m.options.concat([{ id: 'finish', label: 'Finish here', path: '' }])) {
        const b = el('button', o.id === 'finish' ? 'secondary' : '', o.label);
        b.type = 'submit'; b.name = 'option'; b.value = o.id; if (o.path) b.title = o.path;
        form.appendChild(b);
      }
      box.appendChild(form);
    }
    if (thinking && m.from === 'usher') { thinking.remove(); thinking = null; }
    chat.appendChild(box);
    chat.scrollTop = chat.scrollHeight;
  };
  source.addEventListener('chat', (e) => render(JSON.parse(e.data)));
  source.addEventListener('waiting', (e) => setWaiting(JSON.parse(e.data)));
  const cost = document.getElementById('live-cost');
  source.addEventListener('cost', (e) => { if (cost) cost.textContent = e.data; });
  chat.scrollTop = chat.scrollHeight;
  if (!act) return;
  chat.addEventListener('submit', (e) => {
    if (!e.target.matches('form.choices')) return;
    e.preventDefault();
    const option = e.submitter && e.submitter.value;
    if (!option || !waiting) return;
    closeChoices();
    post('/choose', { option });
  });
  const say = document.getElementById('live-say');
  if (say) {
    const box = say.querySelector('textarea');
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); say.requestSubmit(); } });
    say.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = box.value.trim();
      if (!text) return;
      box.value = '';
      // The owner's words come back as an event; until Usher answers, say it's reading.
      setTimeout(() => {
        if (waiting && !thinking) { thinking = el('div', 'msg usher thinking', 'Usher is reading that…'); chat.appendChild(thinking); chat.scrollTop = chat.scrollHeight; }
      }, 150);
      post('/say', { text }).then((r) => {
        if (r.status === 429 || r.status === 409) {
          if (thinking) { thinking.remove(); thinking = null; }
          render({ from: 'usher', text: r.status === 429 ? 'That is a lot of messages in an hour. Pick one of the choices, or wait a little.' : 'I couldn\u2019t take that message just now. Try again in a moment.' });
        }
      });
    });
  }
  frame.addEventListener('click', (e) => {
    if (!waiting || !frame.naturalWidth || !browser || !browser.hasAttribute('data-clickable')) return;
    const r = frame.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * frame.naturalWidth);
    const y = Math.round(((e.clientY - r.top) / r.height) * frame.naturalHeight);
    setWaiting(false);
    post('/click', { x: String(x), y: String(y) });
  });
})();
`;
