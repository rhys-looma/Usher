// The site dashboard (LU-37): tools and the pages behind them, the rules editor, agent sessions, blocked
// attempts and explanations, for one origin only. Signed in with the site's secret key for now
// (claiming a domain by DNS or a well-known file is a later ticket).

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { effectiveRules, toBase64Url } from '@usher/core';
import { DEMO_SUBMIT_LIMIT, claimInstructions, visibleTo, type Registry } from '../registry.ts';
import type { MapRecord, RulesDraft, Session, Storage } from '../storage.ts';
import { html, page, siteClaims, when, type Raw, partner } from './html.ts';
import { isMappingRun, keyMeaning, labelsOf, pageName, plainLog, ruleWords, whoRan } from './plain.ts';
import { TOOLS_STYLE, dashNav, toolPage, toolViews, toolsList, type ToolView } from './tools.ts';

/** How the agent proved who it is: both are checked signatures; Web Bot Auth is the web standard. */
function identityBadge(session: Session | undefined): Raw {
  const id = session?.identity;
  if (id?.method === 'hosted') return html`<span class="badge plain" title="A key the registry minted for one hosted MCP connection; the registry signed its tokens as acting for it">hosted</span> <span class="small muted">Usher hosted MCP</span>`;
  if (id?.method === 'web-bot-auth') {
    const where = id.signature_agent ? new URL(id.signature_agent).host : 'key in the knock';
    return html`<span class="badge rule-allow" title="HTTP Message Signatures, tag web-bot-auth">verified identity</span> <span class="small muted">Web Bot Auth · ${where}</span>`;
  }
  return html`<span class="badge plain" title="Ed25519 signature over the knock">signed knock</span>`;
}

const COOKIE = 'usher_site';
const SESSION_HOURS = 12;
/** An admin's sign-in to a site's dashboard is short: it isn't the owner's. */
const ADMIN_SESSION_HOURS = 2;

/** What Usher's admin did on a site's dashboard, kept per origin and shown to its owner. */
export interface AdminAction {
  ts: string;
  /** "POST /dashboard/rules", for instance: what was done, never what was typed. */
  action: string;
}

/** The last 200 admin actions on an origin. */
export async function recordAdminAction(storage: Storage, origin: string, action: string, now = new Date()): Promise<void> {
  const list = (await storage.getCached<AdminAction[]>('admin-audit', origin)) ?? [];
  await storage.putCached('admin-audit', origin, [...list, { ts: now.toISOString(), action }].slice(-200));
}

export interface BlockedEntry {
  ts: string;
  origin: string;
  path: string;
  reason: string;
  source: 'registry' | 'site';
  agent?: string;
  action?: string;
  /** The agent was acting through a hosted Usher connection. */
  hosted?: true;
}

/** An explanation of a form's recent sessions (LU-34), shown when present. */
export interface ExplanationView {
  path: string;
  text: string;
  created_at: string;
  model: string;
  sessions: number;
}

export interface DashboardHooks {
  /** Cached explanations for the origin. */
  explanations?: (origin: string) => Promise<ExplanationView[]>;
  /** Regenerates explanations; returns an error message or null. */
  explain?: (origin: string) => Promise<string | null>;
}

interface KeeperCheckView {
  outcome: string;
  checked_at: string;
  review?: boolean;
  detail: string;
}

/**
 * The public demo (/demo/dashboard): the demo site's dashboard, read-only. Nothing that changes
 * state is shown; rules can be previewed but never applied. Live parts refresh while it is open.
 */
export interface DemoView {
  /** A rules preview to show, with what was typed. */
  preview?: Raw;
}

const demoBanner = (origin: string) =>
  html`<div class="card notice"><b>This is the demo site's live dashboard.</b> Run <code>usher_fill</code> on <a href="${origin}/health/about">Brightwater's health quote</a> (or <a href="${origin}/quote/driver">its car quote</a>) and your agent's session appears here. Read-only: nothing here changes the site.</div>`;
const LIVE_SCRIPT = html`<script src="/demo.js" defer></script>`;

export function shortAgent(id: string | undefined, hosted = false): string {
  return id ? `${hosted ? 'hosted:' : ''}${id.length > 16 ? `${id.slice(0, 10)}…` : id}` : 'unknown';
}

export class Dashboard {
  constructor(
    private readonly registry: Registry,
    private readonly cookieSecret: string,
    private readonly hooks: DashboardHooks = {},
  ) {}

  private sign(value: string): string {
    return toBase64Url(createHmac('sha256', this.cookieSecret).update(value).digest());
  }

  /** The origin this browser is signed in to, from its signed cookie. */
  originOf(req: IncomingMessage): string | null {
    return this.sessionOf(req)?.origin ?? null;
  }

  /** The signed-in origin, and whether Usher's admin opened it (from /admin/sites) rather than its owner. */
  sessionOf(req: IncomingMessage): { origin: string; admin: boolean } | null {
    const raw = /(?:^|;\s*)usher_site=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!raw) return null;
    const [payload, mac] = raw.split('.');
    if (!payload || !mac) return null;
    const expected = this.sign(payload);
    if (expected.length !== mac.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
    try {
      const { origin, exp, admin } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { origin: string; exp: number; admin?: boolean };
      return exp > Date.now() ? { origin, admin: admin === true } : null;
    } catch {
      return null;
    }
  }

  /** Usher's admin opens a site's dashboard with its owner's powers (the caller has checked the admin key). */
  adminSignIn(res: ServerResponse, origin: string): void {
    this.setCookie(res, origin, true);
  }

  private setCookie(res: ServerResponse, origin: string | null, admin = false): void {
    // Secure whenever the registry is served over https, as it is in production.
    const secure = this.registry.url.startsWith('https://') ? '; Secure' : '';
    if (!origin) return void res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    const hours = admin ? ADMIN_SESSION_HOURS : SESSION_HOURS;
    const payload = Buffer.from(JSON.stringify({ origin, exp: Date.now() + hours * 3_600_000, ...(admin && { admin: true }) })).toString('base64url');
    res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${this.sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${hours * 3600}${secure}`);
  }

  async login(res: ServerResponse, form: URLSearchParams): Promise<string | null> {
    const origin = (form.get('origin') ?? '').trim().replace(/\/$/, '');
    const secret = (form.get('secret') ?? '').trim();
    if (!(await this.registry.siteForSecret(origin, `Bearer ${secret}`))) return null;
    this.setCookie(res, origin);
    return origin;
  }

  /** Signs this browser in to a site it just proved it holds (new keys, or keys re-issued after a claim check). */
  signIn(res: ServerResponse, origin: string): void {
    this.setCookie(res, origin);
  }

  logout(res: ServerResponse): void {
    this.setCookie(res, null);
  }

  loginPage(error?: string): string {
    return page(
      'Site dashboard',
      html`<h1>Site dashboard</h1>
<p class="lede">See which agents use your forms and what they do, set the rules they follow, and spot forms that have changed. Sign in with the secret key you were given when you got your keys.</p>
${siteClaims()}
${error ? html`<div class="card error">${error}</div>` : ''}
<form class="card" method="post" action="/dashboard/login">
  <label>Your site's address <input type="text" name="origin" required placeholder="https://www.example.com" autocomplete="url"></label>
  <label>Secret key <input type="password" name="secret" required placeholder="uss_…" autocomplete="off"></label>
  <button type="submit">Sign in</button>
</form>
<p class="small muted">No keys yet? <a href="/sites/new">Get your keys</a>. Lost your secret key? <a href="/sites/lost">Get a new one</a>.</p>`,
    );
  }

  async overview(origin: string, notice?: Raw, demo?: DemoView, options: { cards?: Raw; active?: 'tools' | 'activity' | 'rules' } = {}): Promise<string> {
    const base = demo ? '/demo/dashboard' : '/dashboard';
    const storage = this.registry.storage;
    const [records, sessions, policy, drafts, blockedAll, explanations] = await Promise.all([
      storage.mapsForOrigin(origin),
      storage.listSessions(origin),
      storage.getPolicy(origin),
      storage.listDrafts(origin),
      storage.readLog('blocked') as Promise<BlockedEntry[]>,
      this.hooks.explanations?.(origin) ?? Promise.resolve([]),
    ]);
    const adminActions = demo ? [] : ((await storage.getCached<AdminAction[]>('admin-audit', origin)) ?? []).slice(-10).reverse();
    const blocked = blockedAll.filter((b) => b.origin === origin).reverse();
    // Agents, not the owner's own mapping runs.
    const mappingRuns = sessions.filter(isMappingRun);
    const agentSessions = sessions.filter((s) => !isMappingRun(s));
    const byAgent = new Map<string, Session[]>();
    for (const s of agentSessions) byAgent.set(s.agent, [...(byAgent.get(s.agent) ?? []), s]);
    const pending = drafts.filter((d) => d.status === 'pending');
    // One row per form: its current (newest) version, with what happened to the ones before.
    const byPath = new Map<string, MapRecord[]>();
    for (const r of records) byPath.set(r.map.path, [...(byPath.get(r.map.path) ?? []), r].sort((a, b) => b.added_at.localeCompare(a.added_at)));
    const forms = [...byPath.values()].map((versions) => ({ current: versions[0]!, earlier: versions.slice(1) })).sort((a, b) => a.current.map.path.localeCompare(b.current.map.path));
    const drifted = forms.filter((f) => f.current.drift).length;
    const checks = new Map(
      await Promise.all(forms.map(async (f) => [f.current.map.path, await storage.getCached<KeeperCheckView>('keeper-check', `${origin}|${f.current.map.path}`)] as const)),
    );

    const app = await this.registry.siteApp(origin);
    const tools = await toolViews(this.registry, origin, app, { records, sessions, blocked });
    const toolOf = new Map(tools.flatMap((v) => v.plan.steps.map((s) => [s.path, v] as const)));
    const outside = forms.filter((f) => !toolOf.has(f.current.map.path)).length;
    const active = options.active ?? 'tools';

    return page(
      demo ? `Demo dashboard · ${origin}` : `Dashboard · ${origin}`,
      html`${demo ? LIVE_SCRIPT : html`<form method="post" action="/dashboard/logout" style="float:right"><button class="secondary">Sign out</button></form>`}
<h1>${origin}</h1>
<p class="lede">${demo ? 'The demo quote site: what it offers assistants, who knocked, what they did, what was refused, and the rules they follow.' : 'What your site offers assistants, who knocked, what they did, what was refused, and the rules they follow.'}</p>
${demo ? demoBanner(origin) : ''}
${notice ?? ''}
${dashNav(active, { base, demo: Boolean(demo) })}
<div data-panels data-active="${active}">
<section id="tools" data-panel>
<h2 style="margin-top:0">Tasks</h2>
<p class="small muted">What assistants can do on your site. Open a task to see its steps, its rules and how it's been used.</p>
<div data-live="top">${toolsList(tools, { base, published: Boolean(app.enabled), demo: Boolean(demo) })}</div>
${options.cards ?? ''}
<details class="card" id="forms"><summary><b>All mapped pages</b> <span class="muted small">(${String(forms.length)}${outside ? `, ${outside} not in a task` : ''})</span></summary>
<div data-live="pages"><table>
<thead><tr><th>Page</th><th>Task</th><th>Elements</th><th>Map</th><th>Status</th><th>Keeper</th></tr></thead>
<tbody>${forms.length ? forms.map(({ current: r, earlier }) => {
        const rebuilt = earlier.find((e) => e.replaced?.by === r.digest);
        const check = checks.get(r.map.path);
        const tool = toolOf.get(r.map.path);
        return html`<tr><td><code>${r.map.path}</code><br><span class="small muted">${r.map.form.purpose}</span></td><td class="small">${tool ? html`<a href="${base}/tools/${tool.tool.intent}?step=${String(tool.plan.steps.findIndex((s) => s.path === r.map.path) + 1)}#flow">${tool.tool.title.replace(/ from .*$/, '')}</a>` : html`<span class="muted">Not in a task</span>`}</td><td>${r.map.fields.length} fields, ${r.map.actions.length} actions${earlier.length ? html`<br><span class="small muted">${earlier.length + 1} versions</span>` : ''}</td>
<td class="small">${r.submitted_by ? html`shared by agent <span class="mono">${shortAgent(r.submitted_by)}</span><br>${r.verification ? html`<span class="badge rule-allow">verified</span> ${when(r.verification.at)} by ${r.verification.by === 'keeper' ? 'the keeper' : r.verification.by === 'admin' ? "Usher's admin" : 'a second agent'}` : html`<span class="badge rule-confirm">unverified</span> served only to that agent`}` : r.map.provenance.compiler ?? r.map.provenance.source}${!demo ? html`<br><a href="/dashboard/maps/${encodeURIComponent(r.digest)}">view map</a>` : visibleTo(r) ? html`<br><a href="/maps/view?origin=${encodeURIComponent(origin)}&amp;digest=${encodeURIComponent(r.digest)}">view map</a>` : ''}</td>
<td>${r.drift ? html`<span class="badge rule-confirm">drifted</span><br><span class="small muted">similarity ${r.drift.score}, ${when(r.drift.at)}</span>` : rebuilt ? html`<span class="badge rule-allow">current</span><br><span class="small muted">changed at ${when(rebuilt.drift?.at ?? rebuilt.replaced!.at)}, rebuilt at ${when(rebuilt.replaced!.at)}</span>` : html`<span class="badge rule-allow">current</span>`}</td>
<td class="small">${check ? html`${check.outcome}${check.review ? html` <span class="badge rule-confirm">review</span>` : ''}<br><span class="muted">${when(check.checked_at)}</span>` : html`<span class="muted">not checked</span>`}</td></tr>`;
      }) : html`<tr><td colspan="6" class="muted">No maps yet. They appear when Usher reads your forms or an agent shares one.</td></tr>`}</tbody></table></div></details>
</section>

<section id="activity" data-panel>
<div data-live="bottom">
<div class="grid">
  <div class="card stat"><b>${records.length}</b><span>forms mapped${drifted ? html`, <span class="badge rule-confirm">${drifted} drifted</span>` : ''}</span></div>
  <div class="card stat"><b>${agentSessions.length}</b><span>agent sessions</span></div>
  <div class="card stat"><b>${byAgent.size}</b><span>agents seen</span></div>
  <div class="card stat"><b>${blocked.length}</b><span>blocked attempts</span></div>
</div>

<h2 id="explanations">What agents are doing</h2>
<div class="card">${
        explanations.length
          ? html`${explanations.map((e) => html`<h3><code>${e.path}</code> <span class="muted small">${e.sessions} session${e.sessions === 1 ? '' : 's'} · ${e.model} · ${when(e.created_at)}</span></h3><p>${e.text}</p>`)}`
          : html`<p class="muted">No explanations yet.${demo ? ' Muse Spark explains recent sessions every few minutes.' : this.hooks.explain ? ' Generate them once agents have used your forms.' : ''}</p>`
      }
${this.hooks.explain && !demo ? html`<form method="post" action="/dashboard/explain" data-busy="Muse Spark is reading the sessions…"><button class="secondary">Explain recent sessions</button></form>` : ''}</div>

<h2 id="sessions">Agent sessions</h2>
<div class="card"><table>
<thead><tr><th>Who</th><th>Sessions</th><th>Last seen</th><th>Recent</th></tr></thead>
<tbody>${byAgent.size ? [...byAgent].map(
        ([agent, list]) => html`<tr><td>${whoRan(list[0]!)} <span class="mono small muted" title="${agent}">${shortAgent(agent, list[0]?.identity?.method === 'hosted')}</span></td><td>${list.length}</td><td>${when(list[0]?.created_at)}</td>
<td>${list.slice(0, 5).map((s) => html`<a href="${base}/sessions/${s.id}">${s.events.length} steps</a> `)}</td></tr>`,
      ) : html`<tr><td colspan="4" class="muted">No agent sessions yet.</td></tr>`}</tbody></table>
${mappingRuns.length ? html`<p class="small muted">Your own mapping runs aren't counted here: ${mappingRuns.slice(0, 5).map((s) => html`<a href="${base}/sessions/${s.id}">${when(s.created_at)}</a> `)}</p>` : ''}</div>

<h2 id="blocked">Blocked attempts</h2>
<div class="card"><table>
<thead><tr><th>When</th><th>Where</th><th>Why</th><th>Agent</th><th>Refused by</th></tr></thead>
<tbody>${blocked.length ? blocked.slice(0, 50).map(
        (b) => html`<tr><td class="small">${when(b.ts)}</td><td><code>${b.path}</code>${b.action ? html` <span class="small muted">${b.action}</span>` : ''}</td><td>${reasonText(b.reason)}</td><td class="mono small">${shortAgent(b.agent, b.hosted === true)}</td><td class="small">${b.source === 'site' ? 'your server' : 'Usher'}</td></tr>`,
      ) : html`<tr><td colspan="5" class="muted">Nothing refused yet.</td></tr>`}</tbody></table></div>
</div>
${adminActions.length ? html`<details class="card"><summary><b>Changes by Usher's admin</b> <span class="muted small">(${String(adminActions.length)} most recent, newest first)</span></summary><ul class="small">${adminActions.map((a) => html`<li>${when(a.ts)}: <code>${a.action}</code></li>`)}</ul></details>` : ''}
</section>

<section id="rules" data-panel>
<h2 style="margin-top:0">Rules</h2>
${demo ? '' : pending.map((d) => draftCard(d, records.map((r) => r.map)))}
<div class="card">${
        policy
          ? html`${policy.text ? html`<p><b>Your rules:</b> “${policy.text}”</p>` : ''}<p class="small muted">Applied ${when(policy.confirmed_at)}.</p>${policySummary(policy.policy, records.map((r) => r.map))}
<details><summary>Policy JSON</summary><pre>${JSON.stringify(policy.policy, null, 2)}</pre></details>`
          : html`<p class="muted">No rules yet. Agents may use your forms, and they ask the person before anything that matters, such as submitting. Declarations and payments are always the person's own.</p>`
      }${demo ? html`<p class="small">On this demo the registry also holds each agent to at most ${DEMO_SUBMIT_LIMIT.max} confirmed quotes (<code>${DEMO_SUBMIT_LIMIT.action}</code>) an ${DEMO_SUBMIT_LIMIT.window}, whatever the rules say.</p>` : ''}</div>
${
        demo
          ? html`${demo.preview ?? ''}${partner('Try the rules', html`<form method="post" action="/demo/dashboard/rules" id="sandbox" data-busy="Muse Spark is writing the policy…">
  <p><label for="rules-text">Say the rules in plain English and see the policy. <span class="badge rule-confirm">preview only</span></label></p>
  <textarea id="rules-text" name="text" required maxlength="1000" placeholder="Agents can fill in quotes, but a person confirms the submit, and at most five an hour."></textarea>
  <p><button type="submit">Preview policy</button></p>
</form>`)}`
          : html`${partner('Change your rules', html`<form method="post" action="/dashboard/rules" data-busy="Muse Spark is writing your policy…">
  <p><label for="rules-text">Say them in plain English. You check the policy before anything changes.</label></p>
  <textarea id="rules-text" name="text" required placeholder="Agents can fill in quotes, but a person confirms the submit, and at most five an hour."></textarea>
  <p><button type="submit">Propose policy</button></p>
</form>`, { open: !policy })}`
      }
</section>
</div>`,
      { scripts: ['/panels.js'], style: TOOLS_STYLE },
    );
  }

  /** One tool's page, or null if the site has no such tool. */
  async tool(origin: string, intent: string, input: { step: number; demo?: boolean; notice?: string; problems?: string[]; canSuggest?: boolean; suggested?: { name: string; description: string } }): Promise<string | null> {
    const storage = this.registry.storage;
    const [records, sessions, blockedAll, policy, app] = await Promise.all([storage.mapsForOrigin(origin), storage.listSessions(origin), storage.readLog('blocked') as Promise<BlockedEntry[]>, storage.getPolicy(origin), this.registry.siteApp(origin)]);
    const views: ToolView[] = await toolViews(this.registry, origin, app, { records, sessions, blocked: blockedAll.filter((b) => b.origin === origin).reverse() });
    const view = views.find((v) => v.tool.intent === intent);
    if (!view) return null;
    const demo = Boolean(input.demo);
    const mapHref = (digest: string) => {
      if (!demo) return `/dashboard/maps/${encodeURIComponent(digest)}`;
      const record = records.find((r) => r.digest === digest);
      return record && visibleTo(record) ? `/maps/view?origin=${encodeURIComponent(origin)}&digest=${encodeURIComponent(digest)}` : undefined;
    };
    const handoff = await this.registry.siteHandoff(origin, intent);
    return toolPage(view, { handoff, registryUrl: this.registry.url, origin, step: input.step, base: demo ? '/demo/dashboard' : '/dashboard', demo, published: Boolean(app.enabled), own: app.tools?.[intent], policy: policy?.policy, mapHref, ...(input.notice && { notice: input.notice }), ...(input.problems && { problems: input.problems }), ...(input.canSuggest && { canSuggest: true }), ...(input.suggested && { suggested: input.suggested }) });
  }

  /** A rules preview for the demo: what was typed, and the policy, marked as not applied. */
  previewCard(text: string, reply: { status: number; body: unknown }, maps: import('@usher/core').UsherMap[]): Raw {
    if (reply.status !== 200) return html`<div class="card error">${(reply.body as { message?: string }).message ?? 'The rules could not be turned into a policy.'}</div>`;
    const preview = reply.body as { policy: import('@usher/core').UsherPolicy; summary: string; model: string };
    return html`<div class="card notice"><p><span class="badge rule-confirm">preview only, not applied</span></p>
<p><b>From:</b> “${text}”</p>
<p class="small">${preview.summary} <span class="muted">(${preview.model})</span></p>
${policySummary(preview.policy, maps)}
<details><summary>Policy JSON</summary><pre>${JSON.stringify(preview.policy, null, 2)}</pre></details></div>`;
  }

  async sessionPage(origin: string, sid: string, demo?: DemoView): Promise<string | null> {
    const base = demo ? '/demo/dashboard' : '/dashboard';
    const session = await this.registry.storage.getSession(sid);
    if (!session || session.origin !== origin) return null;
    const explained = await this.registry.storage.getCached<ExplanationView>('session-explanations', sid);
    const events = [...session.events].sort((a, b) => a.ts.localeCompare(b.ts));
    const maps = (await this.registry.storage.mapsForOrigin(origin)).map((r) => r.map);
    return page(
      'Agent session',
      html`${demo ? LIVE_SCRIPT : ''}${dashNav('activity', { base, demo: Boolean(demo) })}<p class="muted small"><a href="${base}#sessions">Activity</a> · ${whoRan(session)}</p>
<h1>${whoRan(session)}</h1>
<p class="lede">Started ${when(session.created_at)}. ${isMappingRun(session) ? "This is Usher going through your site for you, not an agent acting for someone." : 'What was done, never what anyone typed.'}</p>
${demo ? (explained ? html`<div class="card notice"><p>${explained.text}</p><p class="small muted">${explained.model} · ${when(explained.created_at)}</p></div>` : '') : this.hooks.explain && !isMappingRun(session) ? html`<div class="card notice">${explained ? html`<p>${explained.text}</p><p class="small muted">${explained.model} · ${when(explained.created_at)}</p>` : html`<p class="muted">Not explained yet.</p>`}
<form method="post" action="/dashboard/sessions/${session.id}/explain" data-busy="Muse Spark is reading this session…"><button class="secondary">${explained ? 'Explain again' : 'Explain this session'}</button></form></div>` : ''}
<div class="card" data-live="timeline">${plainLog(events, maps)}
<details><summary>Technical log</summary><p class="small muted">Agent <span class="mono">${session.identity?.method === 'hosted' ? 'hosted:' : ''}${session.agent}</span> ${identityBadge(session)} · <code>${session.intent}</code> · session ${session.id}</p><ol class="timeline">${events.map(
        (e) => html`<li><span class="small">${e.ts.slice(11, 19)}</span><span class="src small">${e.source}</span><span><b>${e.action}</b>${e.key ? html` <code>${e.key}</code>` : ''}${e.path ? html` <span class="muted small">on ${e.path}</span>` : ''}${e.detail ? html` <span class="muted small">${detailText(e.detail)}</span>` : ''}</span></li>`,
      )}</ol></details></div>`,
      { style: TOOLS_STYLE },
    );
  }
}

function reasonText(reason: string): string {
  const text: Record<string, string> = {
    missing: 'no knock: no token',
    knock_required: 'no knock',
    expired: 'token expired',
    replayed: 'token reused',
    confirmation_required: 'not confirmed by the user',
    action_forbidden: 'forbidden by your rules',
    agents_not_allowed: 'no agent lane on this form',
    agent_blocked: 'agent not allowed',
    rate_limited: 'over your rate limit',
    wrong_origin: 'token for another site',
    bad_signature: 'forged token',
  };
  return text[reason] ?? reason;
}

function detailText(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      if (typeof v === 'number' && k.endsWith('_ms')) return `${k.slice(0, -3)} ${(v / 1000).toFixed(1)}s`;
      if (typeof v === 'string' && v.startsWith('sha256:')) return `${k} ${v.slice(0, 19)}…`;
      return `${k.replace(/_/g, ' ')} ${v}`;
    })
    .join(' · ');
}

/** A rate limit in words: "At most 5 visits an hour, for each agent". */
function limitWords(l: { action: string; max: number; per: string; window: string }, labels: Map<string, string>): string {
  const what = l.action === 'knock' ? 'visits' : `uses of “${labels.get(l.action) ?? keyMeaning(l.action)}”`;
  return `At most ${l.max} ${what} ${l.window === 'hour' ? 'an hour' : `a ${l.window}`}, ${l.per === 'agent' ? 'for each agent' : 'across all agents'}.`;
}

function policySummary(policy: import('@usher/core').UsherPolicy, maps: import('@usher/core').UsherMap[]): Raw {
  const labels = labelsOf(maps);
  const rows = maps
    .map((m) => {
      // Only what's on this page: a site-wide rule isn't this page's until the page has the question.
      const here = new Set([...m.fields, ...m.actions].map((e) => e.key));
      const actions = Object.entries(effectiveRules(policy, m, m.path).actions).filter(([k]) => here.has(k));
      return { map: m, lane: effectiveRules(policy, m, m.path).agent_lane, confirm: actions.filter(([, v]) => v === 'confirm').map(([k]) => k), forbid: actions.filter(([, v]) => v === 'forbid').map(([k]) => k) };
    })
    .sort((a, b) => a.map.path.localeCompare(b.map.path));
  const chip = (k: string) => html`<span class="badge plain" title="${k}">${labels.get(k) ?? keyMeaning(k)}</span> `;
  const limits = [...(policy.default.rate_limits ?? []), ...(policy.forms ?? []).flatMap((f) => f.rate_limits ?? [])];
  return html`<table class="small"><thead><tr><th>Page</th><th>Agents</th><th>The person confirms</th><th>Agents may not</th></tr></thead><tbody>${rows.map(
    (r) => html`<tr><td>${pageName(r.map, r.map.path)}<br><code>${r.map.path}</code></td><td>${ruleWords(r.lane ? 'allow' : 'forbid')}</td>
<td>${r.confirm.map(chip)}</td>
<td>${r.forbid.map(chip)}</td></tr>`,
  )}</tbody></table>
${limits.length ? html`<p class="small">${limits.map((l) => limitWords(l, labels)).join(' ')}</p>` : ''}
${policy.agents?.block?.length ? html`<p class="small">Blocked agents: ${policy.agents.block.map((a) => html`<span class="mono">${shortAgent(a)}</span> `)}</p>` : ''}
${policy.agents?.hosted === 'block' ? html`<p class="small">Hosted agents (through a hosted Usher connection) are blocked.</p>` : ''}
${policy.retention?.session_days ? html`<p class="small">Sessions kept ${policy.retention.session_days} days.</p>` : ''}`;
}

function draftCard(draft: RulesDraft, maps: import('@usher/core').UsherMap[]): Raw {
  return html`<div class="card notice">
<p><b>Proposed from:</b> “${draft.text}”</p>
<p class="small">${draft.summary} <span class="muted">(${draft.model}, ${when(draft.created_at)})</span></p>
${policySummary(draft.policy, maps)}
<details><summary>Policy JSON</summary><pre>${JSON.stringify(draft.policy, null, 2)}</pre></details>
<form class="inline" method="post" action="/dashboard/rules/${draft.id}/confirm"><button type="submit">Confirm and apply</button></form>
</div>`;
}
