// "Publish as an assistant app" (LU-59): the owner's page for their site's app. The setup strip
// (joined, mapped, rules, look, published) with the join-to-publish time; the switch; the endpoint
// to add to Claude or ChatGPT; each journey's tool with its name, description and whether it shows;
// the look (the theme page); example prompts; and the directory submission pack.

import type { SiteApp, SiteAppUsage, SiteSetup } from '../registry.ts';
import { examplePrompts, type SiteTool } from '../site-app.ts';
import { html, page, when, type Raw } from './html.ts';
import { TOOLS_STYLE, dashNav, siteHeader } from './tools.ts';

const HREF: Record<SiteSetup['steps'][number]['key'], string> = { joined: '/dashboard', mapped: '/dashboard/walkthrough', rules: '/dashboard#rules', look: '/dashboard/theme', published: '/dashboard/app#switch' };

/** The first step still to do, as a link, or null once the app is published. */
export function nextStep(setup: SiteSetup): Raw | null {
  const next = setup.steps.find((s) => !s.done_at);
  return next ? html`<a href="${HREF[next.key]}">${next.label}</a>` : null;
}

/** What must be done before an app can be published: its rules and its look, each with where to do it. */
export function stillToDo(setup: SiteSetup, themes: boolean): { label: string; href: string }[] {
  return setup.steps.filter((s) => !s.done_at && (s.key === 'rules' || (s.key === 'look' && themes))).map((s) => ({ label: s.label, href: HREF[s.key] }));
}

/** "14 min 32 s", "2 h 5 min", "3 days". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86_400)} days`;
}

/** The strip: one row of five ticks, each done (when, on hover) or still to do (a link), and the time from joining to publishing at the right. */
export function setupStrip(setup: SiteSetup, now: Date): Raw {
  const joined = setup.steps[0]!.done_at;
  const time = setup.join_to_publish_ms !== undefined
    ? html`<p class="timer"><b>Joined to published: ${duration(setup.join_to_publish_ms)}</b></p>`
    : joined
      ? html`<p class="timer">Joined ${duration(now.getTime() - Date.parse(joined))} ago; not published yet.</p>`
      : '';
  const short = (label: string) => label.replace(/:.*$/, '');
  return html`<div class="card setup"><ol class="strip">${setup.steps.map(
    (s) => html`<li class="${s.done_at ? 'done' : 'todo'}" title="${s.label}${s.done_at ? `, ${s.done_at.replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC')}` : ''}"><span class="mark" aria-hidden="true">${s.done_at ? '✓' : ''}</span><span>${s.done_at ? short(s.label) : html`<a href="${HREF[s.key]}">${short(s.label)}</a>`}</span></li>`,
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
.card.setup { display:flex; gap:10px 24px; align-items:center; flex-wrap:wrap; padding:14px 22px; }
.strip { flex:1 1 auto; list-style:none; display:flex; flex-wrap:wrap; gap:8px 22px; margin:0; padding:0; }
.strip li { display:flex; gap:8px; align-items:center; font-size:14px; }
.strip .mark { flex:none; width:16px; height:16px; border:1px solid var(--line); display:inline-flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; }
.strip li.done .mark { background:var(--safe); border-color:var(--safe); color:#fff; }
.timer { margin:0; font-size:14px; } .timer b { font-family:var(--mono); font-weight:500; font-size:13px; }
.endpoint { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.endpoint code { font-size:13px; padding:5px 9px; border:1px solid var(--line); border-radius:4px; background:var(--bg); word-break:break-all; }
.suggested-note { padding:10px 12px; border:1px solid var(--cons); border-radius:4px; }
.tool-buttons { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
.prompts li { margin:4px 0; }
`;

export function appPage(input: { origin: string; name: string; endpoint: string; app: SiteApp; setup: SiteSetup; needs?: { label: string; href: string }[]; usage: SiteAppUsage; tools: SiteTool[]; look: Raw; now: Date; notice?: Raw | string; problems?: string[] }): string {
  const { app, tools } = input;
  const live = tools.filter((t) => !t.hidden);
  const switchCard = html`<div class="card" id="switch"><h2>Publish</h2>
${app.enabled ? html`<p><b>On</b> since ${when(app.enabled_at)}. Assistants that add your endpoint can use the tasks below.</p>` : html`<p><b>Off.</b> Your endpoint answers no one until you switch it on.</p>`}
<form method="post" action="/dashboard/app/switch"><input type="hidden" name="enabled" value="${app.enabled ? '0' : '1'}">${!app.enabled && live.length && input.needs?.length ? html`<button type="submit" disabled>Publish my app</button> <span class="small muted">First: ${input.needs.map((n, i) => html`${i ? ', ' : ''}<a href="${n.href}">${n.label.replace(/:.*$/, '')}</a>`)}.</span>` : !app.enabled && !live.length ? html`<button type="submit" disabled>Publish my app</button> <span class="small muted">Map a journey first: each one becomes a tool.</span>` : html`<button type="submit"${app.enabled ? ' class="secondary"' : ''}>${app.enabled ? 'Switch my app off' : 'Publish my app'}</button>`}</form>
<p class="small muted">${input.usage.connections} connection${input.usage.connections === 1 ? '' : 's'} and ${input.usage.fills} fill${input.usage.fills === 1 ? '' : 's'} so far.</p></div>`;
  const endpoint = html`<div class="card"><h2>Your endpoint</h2>
<p class="endpoint"><code>${input.endpoint}</code></p>
<ul class="small"><li><b>Claude:</b> Settings, Connectors, Add custom connector; paste the address. No sign-in is needed.</li>
<li><b>ChatGPT:</b> Settings, Apps and connectors, Create (developer mode); paste the address, with no authentication.</li>
<li>It serves ${input.name}'s tasks alone and acts on ${new URL(input.origin).host} only.</li></ul></div>`;
  const toolList = html`<div class="card" id="tools"><h2>Tasks</h2>
${tools.length ? html`<p class="small muted">What your app offers. Open a task to name it, describe it or hide it.</p>
<table class="small"><thead><tr><th>Task</th><th>Assistants call it</th><th></th></tr></thead><tbody>${tools.map((t) => html`<tr><td><a href="/dashboard/tools/${t.intent}">${t.title}</a></td><td><code>${t.name}</code></td><td>${t.hidden ? html`<span class="badge plain">Hidden</span>` : ''}</td></tr>`)}</tbody></table>` : html`<p>No journeys mapped yet. <a href="/dashboard/walkthrough/new">Map my site</a>.</p>`}</div>`;
  const prompts = examplePrompts(input.name, live);
  const body = html`<h1>Publish as an assistant app</h1>
<p class="status">${input.name} inside Claude, ChatGPT and every assistant that speaks MCP: your tasks, on cards in your look, run by Usher under your rules.</p>
${input.notice ? html`<div class="card notice">${input.notice}</div>` : ''}${input.problems?.length ? html`<div class="card error">${input.problems.map((p) => html`<p>${p}</p>`)}</div>` : ''}
${setupStrip(input.setup, input.now)}
${switchCard}${endpoint}${toolList}
${input.look}
<div class="card"><h2>Example prompts</h2>${prompts.length ? html`<ul class="prompts">${prompts.map((p) => html`<li>“${p}”</li>`)}</ul>` : html`<p class="muted">Once a task is mapped.</p>`}</div>
<div class="card"><h2>List it in the directories</h2><p>Everything Claude's and ChatGPT's directories ask for, filled in from your app: name, descriptions, endpoint, tools, example prompts, logo and how data is handled. Add your contact and policy links, then submit.</p>
<p><a class="button" href="/dashboard/app/pack.md">Download the pack (Markdown)</a> <a href="/dashboard/app/pack.json">or as JSON, with the logo</a></p></div>`;
  return page('Publish as an assistant app', body, { style: APP_STYLE + TOOLS_STYLE, site: siteHeader(input.origin, app.enabled, false), tabs: dashNav('publish') });
}
