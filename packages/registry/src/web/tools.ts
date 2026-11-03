// The owner's view of what their site offers: each tool (one for each journey), and from it the
// pages it runs through. The flow is a strip of numbered steps, one page open at a time, so a long
// journey never becomes a long page. The strip also serves the walkthrough's results.

import { HANDOFF_MESSAGE_MAX, composePlan, effectiveRules, type SiteHandoff, type UsherMap, type UsherPlan, type UsherPolicy } from '@usher/core';
import type { Registry, SiteApp } from '../registry.ts';
import { siteTools, type SiteTool } from '../site-app.ts';
import type { MapRecord, Session } from '../storage.ts';
import type { BlockedEntry } from './dashboard.ts';
import { html, page, riskBadge, ruleBadge, when, type Raw } from './html.ts';
import { shownWhen } from './walkthrough.ts';

const REPOSITORY = 'https://github.com/rhys-looma/Usher';

export const TOOLS_STYLE = `
.after label { display:block; margin:14px 0; font-weight:600; font-size:14px; }
.after input[type=text], .after select { display:block; width:100%; max-width:480px; margin-top:4px; font-weight:400; }
.after fieldset { border:0; margin:0 0 6px; padding:0; }
.after legend { font-weight:600; font-size:14px; padding:0; margin-bottom:8px; }
.after-modes { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
.after-modes legend { grid-column:1 / -1; }
.after label.choice { display:flex; gap:10px; align-items:flex-start; margin:0; padding:12px; border:1.5px solid var(--line); border-radius:8px; cursor:pointer; }
.after label.choice:has(input:checked) { border-color:var(--accent); }
.after label.choice input { flex:none; margin-top:3px; }
.after label.choice small { display:block; font-weight:400; color:var(--muted); margin-top:2px; }
.after .field { font-weight:600; font-size:14px; margin:14px 0 6px; }
.after .asks { display:flex; flex-wrap:wrap; gap:6px 18px; margin:0 0 14px; }
.after label.tick { display:inline-flex; gap:6px; align-items:center; margin:0; font-weight:400; font-size:15px; }
.after details { margin:0 0 14px; font-size:14px; }
.after summary { cursor:pointer; }
.after:has(input[value=none]:checked) .if-page, .after:has(input[value=none]:checked) .if-redirect, .after:has(input[value=instructions]:checked) .if-redirect, .after:has(input[value=redirect]:checked) .if-instructions { display:none; }
@media (max-width:640px) { .after-modes { grid-template-columns:minmax(0,1fr); } }

.dash-nav { position:sticky; top:0; z-index:5; display:flex; flex-wrap:wrap; gap:4px 22px; align-items:center; background:var(--bg); border-bottom:1px solid var(--line); margin:0 0 22px; padding:10px 0 0; }
.dash-nav a { padding:6px 2px 10px; text-decoration:none; font-weight:600; font-size:15px; color:var(--muted); border-bottom:3px solid transparent; margin-bottom:-1px; }
.dash-nav a:hover { color:var(--ink); }
.dash-nav a[aria-current] { color:var(--ink); border-bottom-color:var(--accent); }
.dash-nav .action { margin-left:auto; color:var(--accent); }
[data-panel], [data-panel] [id], #flow { scroll-margin-top:70px; }
[data-panel].off { display:none; }
.tool-row { display:grid; gap:8px; }
.tool-row h3 { margin:0; font-size:20px; } .tool-row h3 a { text-decoration:none; } .tool-row h3 a:hover { text-decoration:underline; }
.tool-row p { margin:0; }
.tool-top { display:flex; flex-wrap:wrap; gap:6px 12px; align-items:center; }
.tool-top .open { margin-left:auto; font-weight:600; font-size:15px; white-space:nowrap; }
.clip { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; max-width:75ch; }
.crumb { margin:0 0 6px; }
ol.flow { list-style:none; margin:0; padding:0; display:grid; gap:8px; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); }
ol.flow a, ol.flow .end { display:flex; gap:10px; align-items:flex-start; height:100%; padding:10px 12px; border:1px solid var(--line); border-radius:4px; background:var(--card); color:var(--ink); text-decoration:none; font-size:14px; line-height:1.3; min-width:0; }
ol.flow a:hover { border-color:var(--accent); }
ol.flow a[aria-current] { border-color:var(--accent); box-shadow:inset 0 0 0 1px var(--accent); }
ol.flow .n { flex:none; width:24px; height:24px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:12.5px; font-weight:700; background:var(--code); }
ol.flow a[aria-current] .n { background:var(--accent); color:var(--accent-ink); }
ol.flow b, ol.flow small { display:block; overflow-wrap:anywhere; } ol.flow b { font-weight:600; } ol.flow small { color:var(--muted); font-size:12.5px; margin-top:2px; }
ol.flow .flag { color:var(--cons); font-weight:600; }
ol.flow .end { border-style:dashed; color:var(--muted); }
.flow-group { margin:0 0 14px; } .flow-group > p { margin:0 0 6px; font-weight:600; font-size:14px; }
ol.dots { list-style:none; margin:0; padding:0; display:flex; flex-wrap:wrap; gap:4px 0; align-items:center; }
ol.dots li { display:flex; align-items:center; }
ol.dots li + li::before { content:""; width:14px; height:2px; background:var(--line); }
ol.dots a { width:24px; height:24px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:12.5px; font-weight:700; text-decoration:none; color:var(--ink); background:var(--code); }
ol.dots a:hover { background:var(--accent); color:var(--accent-ink); }
ol.dots a.flag { background:var(--cons-bg); color:var(--cons); }
ol.dots .tick { width:24px; text-align:center; color:var(--muted); }
.step-head { display:flex; flex-wrap:wrap; gap:6px 14px; align-items:baseline; margin-bottom:12px; } .step-head h2 { margin:0; font-size:22px; }
.step-nav { display:flex; justify-content:space-between; gap:16px; margin-top:16px !important; font-weight:600; font-size:15px; } .step-nav .next { margin-left:auto; text-align:right; }
.tool-edit label { display:block; margin:10px 0 0; } .tool-edit input[type=text] { width:100%; } .tool-edit label.check { display:flex; gap:8px; align-items:center; }
.tool-edit.suggested { border-left:3px solid var(--accent); }
.tool-buttons { margin-top:14px !important; display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
.suggested-note { padding:10px 12px; border-radius:8px; background:rgba(116,52,211,.08); }
`;

/** The owner's tabs. On the dashboard itself they switch panels; anywhere else they lead back to it. */
export function dashNav(active: 'tools' | 'activity' | 'rules' | 'publish' | null, options: { base?: string; demo?: boolean } = {}): Raw {
  const base = options.base ?? '/dashboard';
  const tab = (id: string, name: string, href: string) => html`<a href="${href}"${active === id ? html` aria-current="page"` : ''}>${name}</a>`;
  return html`<nav class="dash-nav" aria-label="Dashboard" data-panel-nav>${tab('tools', 'Tasks', `${base}#tools`)}${tab('activity', 'Activity', `${base}#activity`)}${tab('rules', 'Rules', `${base}#rules`)}${options.demo ? '' : html`${tab('publish', 'Publish', '/dashboard/app')}<a class="action" href="/dashboard/walkthrough/new">Map my site</a>`}</nav>`;
}

export interface FlowStep {
  name: string;
  path: string;
  href: string;
  /** Something to look at on this step: "changed", "2 new". */
  flag?: string;
}

/** The steps of a flow, every one a link, wrapping to fit: all of it in view however long it is. */
export function flowStrip(steps: FlowStep[], options: { label: string; current?: number; end?: Raw }): Raw {
  return html`<ol class="flow" aria-label="${options.label}" data-panel-nav>${steps.map(
    (s, i) => html`<li><a href="${s.href}"${options.current === i ? html` aria-current="step"` : ''}><span class="n">${String(i + 1)}</span><span><b>${s.name}</b><small>${s.path}</small>${s.flag ? html`<small class="flag">${s.flag}</small>` : ''}</span></a></li>`,
  )}${options.end ? html`<li>${options.end}</li>` : ''}</ol>`;
}

/** The same flow small enough for a list of tools: numbered dots, named when hovered or read out. */
function flowDots(steps: FlowStep[], options: { label: string; complete: boolean }): Raw {
  return html`<ol class="dots" aria-label="${options.label}">${steps.map(
    (s, i) => html`<li><a href="${s.href}"${s.flag ? html` class="flag"` : ''} title="${String(i + 1)}. ${s.name} · ${s.path}${s.flag ? ` · ${s.flag}` : ''}" aria-label="Step ${String(i + 1)}: ${s.name}">${String(i + 1)}</a></li>`,
  )}${options.complete ? html`<li><span class="tick" aria-hidden="true">✓</span></li>` : ''}</ol>`;
}

/**
 * How a journey ends: at the site's result page; at the final button, whose result Usher doesn't
 * press through when it maps; or at a next-page button that goes somewhere not mapped yet.
 */
function journeyEnd(plan: UsherPlan): { kind: 'done' } | { kind: 'final'; label: string } | { kind: 'open' } {
  if (plan.complete) return { kind: 'done' };
  const advance = plan.steps.at(-1)?.advance;
  return advance && advance.key !== 'nav.next' ? { kind: 'final', label: advance.label } : { kind: 'open' };
}

const capitalised = (text: string) => text.replace(/^(.)/, (c) => c.toUpperCase());

/** Short names for a journey's pages: what follows the journey's name, or the path where those repeat. */
export function stepNames(steps: { path: string; purpose: string }[]): string[] {
  const names = steps.map((s) => s.purpose.split(':')[1]?.trim() || s.purpose);
  return names.map((n, i) => capitalised(names.filter((x) => x === n).length > 1 ? (steps[i]!.path.split('/').filter(Boolean).at(-1) ?? n).replace(/[-_]+/g, ' ') : n));
}

export interface ToolView {
  tool: SiteTool;
  plan: UsherPlan;
  maps: Map<string, UsherMap>;
  names: string[];
  /** The pages whose form has changed since they were mapped. */
  drifted: Set<string>;
  runs: Session[];
  blocked: BlockedEntry[];
  /** The owner's description, or the one Usher wrote: without what every tool says to the assistant. */
  blurb: string;
}

/** Every tool on the site, hidden ones too, with the pages behind it and what happened on them. */
export async function toolViews(registry: Registry, origin: string, app: SiteApp, seen: { records: MapRecord[]; sessions: Session[]; blocked: BlockedEntry[] }): Promise<ToolView[]> {
  const maps = await registry.currentMaps(origin);
  const newest = new Map<string, MapRecord>();
  for (const r of seen.records) if (!newest.has(r.map.path) || newest.get(r.map.path)!.added_at < r.added_at) newest.set(r.map.path, r);
  const out: ToolView[] = [];
  for (const tool of await siteTools(registry, origin, app, { includeHidden: true })) {
    const plan = composePlan(new URL(tool.url).pathname, maps);
    if (!plan) continue;
    const paths = new Set(plan.steps.map((s) => s.path));
    const own = app.tools?.[tool.intent];
    out.push({
      tool,
      plan,
      maps,
      names: stepNames(plan.steps),
      drifted: new Set([...paths].filter((p) => newest.get(p)?.drift)),
      runs: seen.sessions.filter((s) => s.intent === tool.intent),
      blocked: seen.blocked.filter((b) => paths.has(b.path)),
      blurb: own?.description?.trim() || tool.summary,
    });
  }
  return out;
}

function toolStatus(view: ToolView, published: boolean): Raw {
  if (view.tool.hidden) return html`<span class="badge plain">Hidden</span>`;
  if (view.drifted.size || journeyEnd(view.plan).kind === 'open') return html`<span class="badge rule-confirm">Needs attention</span>`;
  return published ? html`<span class="badge rule-allow">Live</span>` : html`<span class="badge plain" title="Agents can use it. It joins your assistant app once you publish.">Not in your app yet</span>`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function steps(view: ToolView, base: string): FlowStep[] {
  return view.plan.steps.map((s, i) => ({
    name: view.names[i]!,
    path: s.path,
    href: `${base}/tools/${view.tool.intent}?step=${i + 1}#flow`,
    ...(view.drifted.has(s.path) && { flag: 'Form changed' }),
  }));
}

/** The top of the dashboard: each tool, what state it's in, and the way down to its pages. */
export function toolsList(views: ToolView[], options: { base: string; published: boolean; demo: boolean }): Raw {
  if (!views.length) return html`<div class="card"><p><b>No tasks yet.</b> Each thing Usher maps on your site, like a quote or a booking, becomes a task assistants can do.${options.demo ? '' : html` <a href="/dashboard/walkthrough/new">Map my site</a>.`}</p></div>`;
  return html`${views.map((v) => {
    const href = `${options.base}/tools/${v.tool.intent}`;
    const name = v.tool.title.replace(/ from .*$/, '');
    return html`<article class="card tool-row"><div class="tool-top"><h3><a href="${href}">${name}</a></h3>${toolStatus(v, options.published)}<code>${v.tool.name}</code><a class="open" href="${href}">Open →</a></div>
<p class="small muted clip">${v.blurb}</p>
${flowDots(steps(v, options.base), { label: `Steps in ${name}`, complete: journeyEnd(v.plan).kind !== 'open' })}
<p class="small muted">${plural(v.plan.steps.length, 'step')} · ${plural(v.tool.params.length, 'question')} · ${plural(v.runs.length, 'run')}${v.blocked.length ? ` · ${v.blocked.length} blocked` : ''}</p></article>`;
  })}`;
}

function stepPanel(view: ToolView, index: number, options: { base: string; mapHref: (digest: string) => string | undefined; policy: UsherPolicy | undefined }): Raw {
  const step = view.plan.steps[index]!;
  const map = view.maps.get(step.path)!;
  const rules = effectiveRules(options.policy, map, step.path).actions;
  const link = options.mapHref(step.map);
  const at = (i: number) => `${options.base}/tools/${view.tool.intent}?step=${i + 1}#flow`;
  return html`<section class="card" id="step"><div class="step-head"><h2>${String(index + 1)}. ${view.names[index]!}</h2><code>${step.path}</code>${view.drifted.has(step.path) ? html`<span class="badge rule-confirm">Form changed</span>` : ''}${link ? html`<a class="small" href="${link}">View the full map</a>` : ''}</div>
<p class="small muted">${step.purpose}</p>
${map.fields.length ? html`<table class="small"><thead><tr><th>Question</th><th>Risk</th><th>Notes</th></tr></thead><tbody>${map.fields.map(
    (f) => html`<tr><td>${f.label || f.key}</td><td>${riskBadge(f.risk)}</td><td class="muted">${[f.required ? 'Required' : '', f.shown_if ? shownWhen(map, f.shown_if) : ''].filter(Boolean).join('. ')}</td></tr>`,
  )}</tbody></table>` : html`<p class="muted small">No questions on this page.</p>`}
${map.actions.length ? html`<table class="small"><thead><tr><th>Button or link</th><th>Risk</th><th>Under your rules</th></tr></thead><tbody>${map.actions.map(
    (a) => html`<tr><td>${a.label || a.key}${a.leads_to ? html` <span class="muted">→ ${a.leads_to}</span>` : ''}</td><td>${riskBadge(a.risk)}</td><td>${rules[a.key] ? ruleBadge(rules[a.key]!) : ''}</td></tr>`,
  )}</tbody></table>` : ''}
<p class="step-nav">${index > 0 ? html`<a href="${at(index - 1)}">← ${view.names[index - 1]!}</a>` : ''}${index < view.plan.steps.length - 1 ? html`<a class="next" href="${at(index + 1)}">${view.names[index + 1]!} →</a>` : ''}</p></section>`;
}

/** One tool: what assistants see of it, its flow with one page open, and how it's been used. */
const AFTER_MODES: { mode: SiteHandoff['mode']; title: string; what: string }[] = [
  { mode: 'none', title: 'Stay in the assistant', what: 'No link' },
  { mode: 'instructions', title: 'Send them to a page', what: 'They enter their reference' },
  { mode: 'redirect', title: 'Open it on your site', what: 'One click. Needs a developer' },
];
const AFTER_SHOW: { show: SiteHandoff['show']; title: string }[] = [
  { show: 'all', title: 'The full result' },
  { show: 'reference', title: 'The reference only' },
  { show: 'nothing', title: 'Nothing from the page' },
];
/** What a retrieve page may ask for, as tick boxes; a stored ask counts if it mentions the word. */
const AFTER_ASKS: { word: string; title: string; ask: string }[] = [
  { word: 'reference', title: 'Reference', ask: 'your reference' },
  { word: 'birth', title: 'Date of birth', ask: 'your date of birth' },
  { word: 'postcode', title: 'Postcode', ask: 'your postcode' },
  { word: 'email', title: 'Email', ask: 'your email' },
];

/** The owner's choice of what happens when the task finishes; only what the choice needs shows. Read-only on the public demo. */
function afterCard(action: string, input: { origin: string; intent: string; demo: boolean; handoff: SiteHandoff; registryUrl: string }): Raw {
  const h = input.handoff;
  if (input.demo) return html`<div class="card" id="after"><h2>When it finishes</h2><p><b>${AFTER_MODES.find((m) => m.mode === h.mode)!.title}.</b> ${AFTER_MODES.find((m) => m.mode === h.mode)!.what}.</p></div>`;
  const route = h.redirect?.url ?? '/handoff';
  const snippet = `import { createUsherCheck, sendHandoffPage } from '@usher/site-middleware';

const usher = createUsherCheck({
  registry: '${input.registryUrl}',
  origin: '${input.origin}',
  intent: '${input.intent}',
});

// 1. Where the result is created: remember which Usher session asked for it.
const check = await usher.check(req, { form, action: 'form.submit' });
if (check.status === 'knock_required') return usher.reject(req, res, check, 'form.submit');
if (check.status === 'ok') saveResult({ ...result, usherSession: check.claims.sid });

// 2. A new route. GET shows a page; only POST uses the token up.
app.get('${route}', (req, res) => sendHandoffPage(res, req.query.token));
app.post('${route}', async (req, res) => {
  const opened = await usher.openHandoff(req, req.body.token);
  const result = opened.ok && findResultByUsherSession(opened.sid);
  if (!result) return res.redirect('/retrieve');
  startNewSession(res, result);        // your own cookie, as after any sign-in
  res.redirect(resultPageFor(result));
});`;
  const page = h.resume ? `${h.resume.url}${h.resume.reference_param ? `?${h.resume.reference_param}=` : ''}` : '';
  const asks = h.resume?.asks ?? ['your reference'];
  return html`<form class="card after" method="post" action="${action}/after" id="after"><h2>When it finishes</h2>
<fieldset class="after-modes"><legend>Where do they go next?</legend>${AFTER_MODES.map((m) => html`<label class="choice"><input type="radio" name="mode" value="${m.mode}"${h.mode === m.mode ? ' checked' : ''}> <span><b>${m.title}</b><small>${m.what}</small></span></label>`)}</fieldset>
<div class="if-redirect"><label>Your route <input type="text" name="redirect_url" value="${route}" spellcheck="false" autocomplete="off"></label>
<details><summary>Setup for your developer</summary><pre class="wrap small">${snippet}</pre><p class="small"><a href="${REPOSITORY}/blob/main/docs/handoff.md">The full guide</a>. Set this up before you switch it on.</p></details></div>
<div class="if-page"><label><span class="if-redirect">If the link has expired, send them to</span><span class="if-instructions">Your page</span> <input type="text" name="retrieve_url" value="${page}" placeholder="/retrieve?reference=" spellcheck="false" autocomplete="off"></label>
<div class="if-instructions"><p class="field">They'll need</p><p class="asks">${AFTER_ASKS.map((a) => html`<label class="tick"><input type="checkbox" name="ask" value="${a.ask}"${asks.some((x) => x.includes(a.word)) ? ' checked' : ''}> ${a.title}</label>`)}</p></div></div>
<label>Show them <select name="show">${AFTER_SHOW.map((s) => html`<option value="${s.show}"${h.show === s.show ? ' selected' : ''}>${s.title}</option>`)}</select></label>
<label>Your message <span class="small muted">(optional)</span><input type="text" name="message" value="${h.message ?? ''}" maxlength="${String(HANDOFF_MESSAGE_MAX)}" placeholder="We'll email your documents within a day."></label>
<input type="hidden" name="retrieve_label" value="${h.resume?.label ?? 'Retrieve your result'}"><input type="hidden" name="redirect_label" value="${h.redirect?.label ?? 'Open your result'}">
<p class="tool-buttons"><button type="submit">Save</button></p></form>`;
}

export function toolPage(view: ToolView, input: {
  origin: string;
  step: number;
  base: string;
  demo: boolean;
  published: boolean;
  own: { name?: string; description?: string; hidden?: boolean } | undefined;
  policy: UsherPolicy | undefined;
  mapHref: (digest: string) => string | undefined;
  notice?: string;
  problems?: string[];
  canSuggest?: boolean;
  suggested?: { name: string; description: string };
  /** What the owner chose for when this task finishes, and this registry's address for the setup steps. */
  handoff: SiteHandoff;
  registryUrl: string;
}): string {
  const { tool, plan } = view;
  const index = Math.min(Math.max(input.step, 1), plan.steps.length) - 1;
  const action = `/dashboard/tools/${tool.intent}`;
  const title = tool.title.replace(/ from .*$/, '');
  const finish = journeyEnd(plan);
  const end = finish.kind === 'done'
    ? html`<span class="end"><span class="n">✓</span><span><b>Done</b><small>The site's result page</small></span></span>`
    : finish.kind === 'final'
      ? html`<span class="end"><span class="n">✓</span><span><b>${finish.label}</b><small>The final step, left to the person</small></span></span>`
      : html`<span class="end"><span class="n">?</span><span><b>Not mapped yet</b><small>What comes after this page</small></span></span>`;
  const edit = input.demo ? '' : html`<form class="card tool-edit${input.suggested ? ' suggested' : ''}" method="post" action="${action}" id="edit"><h2>How assistants see it</h2>
<p class="small muted">The name is what assistants call; the description tells them when to use it. Usher wrote these from the pages; change them in your own words, or ask Muse Spark for a suggestion.</p>
${input.suggested ? html`<p class="suggested-note"><b>Muse Spark's suggestion is in the boxes.</b> Check it, change anything, then save. Nothing changes until you do.</p>` : ''}
<label>Name <input type="text" name="name" value="${input.suggested?.name ?? input.own?.name ?? tool.name}" pattern="[a-z][a-z0-9_]{2,63}" required spellcheck="false" autocomplete="off"></label>
<label>Description<textarea name="description" maxlength="600" rows="3" required>${input.suggested?.description ?? input.own?.description ?? tool.summary}</textarea></label>
<label class="check"><input type="checkbox" name="hidden" value="1"${tool.hidden ? ' checked' : ''}> Hide this task from assistants</label>
<details class="small"><summary>What it asks for (${String(tool.params.length)})</summary><ul>${tool.params.map((p) => html`<li><code>${p.name}</code>: ${p.description}${p.options ? html` <span class="muted">(${p.options.join(', ')})</span>` : ''}</li>`)}</ul></details>
<p class="tool-buttons"><button type="submit">Save</button>${input.canSuggest ? html` <button type="submit" class="secondary" formaction="${action}/suggest" formnovalidate>Suggest with Muse Spark</button>` : ''}${input.suggested ? html` <a href="${action}">Discard the suggestion</a>` : ''}</p></form>`;
  const sessions = view.runs.slice(0, 10);
  return page(
    `${title} · ${input.origin}`,
    html`${dashNav('tools', { base: input.base, demo: input.demo })}
<p class="crumb small muted"><a href="${input.base}#tools">Tasks</a> · ${title}</p>
<h1>${title}</h1>
<p class="lede">${toolStatus(view, input.published)} <code>${tool.name}</code> · ${plural(plan.steps.length, 'step')} · ${plural(tool.params.length, 'question')}</p>
${input.notice ? html`<div class="card notice">${input.notice}</div>` : ''}${input.problems?.length ? html`<div class="card error">${input.problems.map((p) => html`<p>${p}</p>`)}</div>` : ''}
<div class="flow-group" id="flow"><p>The steps</p>${flowStrip(steps(view, input.base), { label: `Steps in ${title}`, current: index, end })}</div>
${stepPanel(view, index, input)}
${edit}
${afterCard(action, { ...input, intent: tool.intent })}
<div class="card"><h2>How it's been used</h2>
${sessions.length ? html`<table class="small"><thead><tr><th>When</th><th>Agent session</th><th>Events</th></tr></thead><tbody>${sessions.map((s) => html`<tr><td>${when(s.created_at)}</td><td><a href="${input.base}/sessions/${s.id}" class="mono">${s.id.slice(0, 14)}…</a></td><td>${String(s.events.length)}</td></tr>`)}</tbody></table>` : html`<p class="muted">No agents have run this yet.</p>`}
${view.blocked.length ? html`<p class="small"><a href="${input.base}#blocked">${plural(view.blocked.length, 'blocked attempt')}</a> on these pages.</p>` : ''}</div>`,
    { style: TOOLS_STYLE },
  );
}
