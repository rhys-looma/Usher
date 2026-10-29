// "Publish as an assistant app" (LU-59): the owner's page for their site's app. The setup strip
// (joined, mapped, rules, look, published) with the join-to-publish time; the switch; the endpoint
// to add to Claude or ChatGPT; each journey's tool with its name, description and whether it shows;
// the look (the theme page); example prompts; and the directory submission pack.

import type { SiteApp, SiteAppUsage, SiteSetup } from '../registry.ts';
import { examplePrompts, type SiteTool } from '../site-app.ts';
import { html, page, when, type Raw } from './html.ts';

const HREF: Record<SiteSetup['steps'][number]['key'], string> = { joined: '/dashboard', mapped: '/dashboard/walkthrough', rules: '/dashboard#rules', look: '/dashboard/theme', published: '/dashboard/app#switch' };

/** The first step still to do, as a link, or null once the app is published. */
export function nextStep(setup: SiteSetup): Raw | null {
  const next = setup.steps.find((s) => !s.done_at);
  return next ? html`<a href="${HREF[next.key]}">${next.label}</a>` : null;
}

/** "14 min 32 s", "2 h 5 min", "3 days". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86_400)} days`;
}

/** The strip: each step done (when) or still to do (where), and the time from joining to publishing. */
export function setupStrip(setup: SiteSetup, now: Date): Raw {
  const joined = setup.steps[0]!.done_at;
  const time = setup.join_to_publish_ms !== undefined
    ? html`<p class="timer"><b>Joined to published: ${duration(setup.join_to_publish_ms)}</b></p>`
    : joined
      ? html`<p class="timer">Joined ${duration(now.getTime() - Date.parse(joined))} ago; not published yet.</p>`
      : '';
  return html`<div class="card setup"><ol class="strip">${setup.steps.map(
    (s) => html`<li class="${s.done_at ? 'done' : 'todo'}"><span class="mark" aria-hidden="true">${s.done_at ? '✓' : ''}</span><span>${s.done_at ? s.label : html`<a href="${HREF[s.key]}">${s.label}</a>`}${s.done_at ? html`<br><small class="muted">${when(s.done_at)}</small>` : ''}</span></li>`,
  )}</ol>${time}</div>`;
}

/** The overview's card: where the app stands, and the way in. */
export function appCard(app: SiteApp, setup: SiteSetup): Raw {
  const left = setup.steps.filter((s) => !s.done_at).length;
  return html`<div class="card"><h2>Your assistant app</h2>
<p>${app.enabled ? html`<b>Published.</b> Claude, ChatGPT and other assistants can use your forms through your own app, under your name and rules.` : html`Your site in every assistant, under your name and rules. ${left ? `${left} step${left === 1 ? '' : 's'} to go.` : 'Ready to publish.'}`}</p>
<p><a class="button" href="/dashboard/app">${app.enabled ? 'Manage your app' : 'Publish as an assistant app'}</a></p></div>`;
}

export const APP_STYLE = `
.strip { list-style:none; display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:10px; margin:0; padding:0; }
.strip li { display:flex; gap:8px; align-items:flex-start; font-size:14px; }
.strip .mark { flex:none; width:22px; height:22px; border-radius:50%; border:1.5px solid var(--line); display:inline-flex; align-items:center; justify-content:center; font-size:13px; font-weight:700; }
.strip li.done .mark { background:#0f7a3d; border-color:#0f7a3d; color:#fff; }
.timer { margin:12px 0 0; }
.endpoint { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.endpoint code { font-size:15px; padding:6px 10px; border:1px solid var(--line); border-radius:6px; background:var(--bg); word-break:break-all; }
.tool { border-top:1px dotted var(--line); padding:12px 0; }
.tool:first-of-type { border-top:0; }
.tool label { display:block; margin:8px 0 0; }
.tool input[type=text] { font:inherit; padding:5px 8px; width:100%; max-width:24em; font-family:ui-monospace,monospace; }
.tool textarea { font:inherit; width:100%; min-height:4.5em; }
.prompts li { margin:4px 0; }
@media (max-width:860px) { .strip { grid-template-columns:minmax(0,1fr); } }
`;

export function appPage(input: { origin: string; name: string; endpoint: string; app: SiteApp; setup: SiteSetup; usage: SiteAppUsage; tools: SiteTool[]; look: Raw; now: Date; notice?: Raw | string; problems?: string[] }): string {
  const { app, tools } = input;
  const live = tools.filter((t) => !t.hidden);
  const switchCard = html`<div class="card" id="switch"><h2>Publish</h2>
${app.enabled ? html`<p><b>On</b> since ${when(app.enabled_at)}. Assistants that add your endpoint can use the tools below.</p>` : html`<p><b>Off.</b> Your endpoint answers no one until you switch it on.</p>`}
<form method="post" action="/dashboard/app/switch"><input type="hidden" name="enabled" value="${app.enabled ? '0' : '1'}">${!app.enabled && !live.length ? html`<button type="submit" disabled>Publish my app</button> <span class="small muted">Map a journey first: each one becomes a tool.</span>` : html`<button type="submit"${app.enabled ? ' class="secondary"' : ''}>${app.enabled ? 'Switch my app off' : 'Publish my app'}</button>`}</form>
<p class="small muted">${input.usage.connections} connection${input.usage.connections === 1 ? '' : 's'} and ${input.usage.fills} fill${input.usage.fills === 1 ? '' : 's'} so far.</p></div>`;
  const endpoint = html`<div class="card"><h2>Your endpoint</h2>
<p class="endpoint"><code>${input.endpoint}</code></p>
<ul class="small"><li><b>Claude:</b> Settings, Connectors, Add custom connector; paste the address. No sign-in is needed.</li>
<li><b>ChatGPT:</b> Settings, Apps and connectors, Create (developer mode); paste the address, with no authentication.</li>
<li>It serves ${input.name}'s tools alone and acts on ${new URL(input.origin).host} only.</li></ul></div>`;
  const toolForm = html`<form class="card" method="post" action="/dashboard/app/tools"><h2>Tools</h2>
<p class="small muted">One for each journey Usher has mapped. Names are what assistants call; descriptions tell them when to. Leave a box empty for the one Usher writes. Hidden tools aren't offered.</p>
${tools.length ? tools.map((t) => html`<div class="tool">
<label>Name <input type="text" name="name:${t.intent}" value="${app.tools?.[t.intent]?.name ?? ''}" placeholder="${t.name}" pattern="[a-z][a-z0-9_]{2,63}"></label>
<label>Description<textarea name="description:${t.intent}" maxlength="600" placeholder="${t.title}.">${app.tools?.[t.intent]?.description ?? ''}</textarea></label>
<label><input type="checkbox" name="hidden:${t.intent}" value="1"${t.hidden ? ' checked' : ''}> Hide this tool</label>
<details class="small"><summary>What it asks for (${t.params.length})</summary><ul>${t.params.map((p) => html`<li><code>${p.name}</code>: ${p.description}${p.options ? html` <span class="muted">(${p.options.join(', ')})</span>` : ''}</li>`)}</ul></details>
</div>`) : html`<p>No journeys mapped yet. <a href="/dashboard/walkthrough/new">Map my site</a>.</p>`}
${tools.length ? html`<p><button type="submit">Save tools</button></p>` : ''}</form>`;
  const prompts = examplePrompts(input.name, live);
  const body = html`<h1>Publish as an assistant app</h1>
<p class="lede">${input.name} inside Claude, ChatGPT and every assistant that speaks MCP: your journeys as tools, on cards in your look, run by Usher under your rules.</p>
${input.notice ? html`<div class="card notice">${input.notice}</div>` : ''}${input.problems?.length ? html`<div class="card error">${input.problems.map((p) => html`<p>${p}</p>`)}</div>` : ''}
${setupStrip(input.setup, input.now)}
${switchCard}${endpoint}${toolForm}
${input.look}
<div class="card"><h2>Example prompts</h2>${prompts.length ? html`<ul class="prompts">${prompts.map((p) => html`<li>“${p}”</li>`)}</ul>` : html`<p class="muted">Once a journey is mapped.</p>`}</div>
<div class="card"><h2>List it in the directories</h2><p>Everything Claude's and ChatGPT's directories ask for, filled in from your app: name, descriptions, endpoint, tools, example prompts, logo and how data is handled. Add your contact and policy links, then submit.</p>
<p><a class="button" href="/dashboard/app/pack.md">Download the pack (Markdown)</a> <a href="/dashboard/app/pack.json">or as JSON, with the logo</a></p></div>`;
  return page('Publish as an assistant app', body, { style: APP_STYLE });
}
