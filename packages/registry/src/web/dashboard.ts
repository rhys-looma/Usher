// The site dashboard (LU-37): forms and maps with drift, the rules editor, agent sessions, blocked
// attempts and explanations, for one origin only. Signed in with the site's secret key for now
// (claiming a domain by DNS or a well-known file is a later ticket).

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { effectiveRules, toBase64Url } from '@usher/core';
import { claimInstructions, type Registry } from '../registry.ts';
import type { MapRecord, RulesDraft, Session } from '../storage.ts';
import { html, page, ruleBadge, when, type Raw } from './html.ts';

/** How the agent proved who it is: both are checked signatures; Web Bot Auth is the web standard. */
function identityBadge(session: Session | undefined): Raw {
  const id = session?.identity;
  if (id?.method === 'web-bot-auth') {
    const where = id.signature_agent ? new URL(id.signature_agent).host : 'key in the knock';
    return html`<span class="badge rule-allow" title="HTTP Message Signatures, tag web-bot-auth">verified identity</span> <span class="small muted">Web Bot Auth · ${where}</span>`;
  }
  return html`<span class="badge plain" title="Ed25519 signature over the knock">signed knock</span>`;
}

const COOKIE = 'usher_site';
const SESSION_HOURS = 12;

export interface BlockedEntry {
  ts: string;
  origin: string;
  path: string;
  reason: string;
  source: 'registry' | 'site';
  agent?: string;
  action?: string;
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

export function shortAgent(id: string | undefined): string {
  return id ? (id.length > 16 ? `${id.slice(0, 10)}…` : id) : 'unknown';
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
    const raw = /(?:^|;\s*)usher_site=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!raw) return null;
    const [payload, mac] = raw.split('.');
    if (!payload || !mac) return null;
    const expected = this.sign(payload);
    if (expected.length !== mac.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
    try {
      const { origin, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { origin: string; exp: number };
      return exp > Date.now() ? origin : null;
    } catch {
      return null;
    }
  }

  private setCookie(res: ServerResponse, origin: string | null): void {
    // Secure whenever the registry is served over https, as it is in production.
    const secure = this.registry.url.startsWith('https://') ? '; Secure' : '';
    if (!origin) return void res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    const payload = Buffer.from(JSON.stringify({ origin, exp: Date.now() + SESSION_HOURS * 3_600_000 })).toString('base64url');
    res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${this.sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${secure}`);
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
${error ? html`<div class="card error">${error}</div>` : ''}
<form class="card" method="post" action="/dashboard/login">
  <p><label>Site origin<br><input type="text" name="origin" required placeholder="https://quote.example"></label></p>
  <p><label>Secret key<br><input type="password" name="secret" required placeholder="uss_…" autocomplete="off"></label></p>
  <button type="submit">Sign in</button>
</form>
<p class="small muted">No keys yet? <a href="/sites/new">Get your keys</a>. Lost your secret key? <a href="/sites/lost">Get a new one</a>.</p>`,
    );
  }

  async overview(origin: string, notice?: Raw): Promise<string> {
    const storage = this.registry.storage;
    const [records, sessions, policy, drafts, blockedAll, explanations] = await Promise.all([
      storage.mapsForOrigin(origin),
      storage.listSessions(origin),
      storage.getPolicy(origin),
      storage.listDrafts(origin),
      storage.readLog('blocked') as Promise<BlockedEntry[]>,
      this.hooks.explanations?.(origin) ?? Promise.resolve([]),
    ]);
    const blocked = blockedAll.filter((b) => b.origin === origin).reverse();
    const byAgent = new Map<string, Session[]>();
    for (const s of sessions) byAgent.set(s.agent, [...(byAgent.get(s.agent) ?? []), s]);
    const pending = drafts.filter((d) => d.status === 'pending');
    // One row per form: its current (newest) version, with what happened to the ones before.
    const byPath = new Map<string, MapRecord[]>();
    for (const r of records) byPath.set(r.map.path, [...(byPath.get(r.map.path) ?? []), r].sort((a, b) => b.added_at.localeCompare(a.added_at)));
    const forms = [...byPath.values()].map((versions) => ({ current: versions[0]!, earlier: versions.slice(1) })).sort((a, b) => a.current.map.path.localeCompare(b.current.map.path));
    const drifted = forms.filter((f) => f.current.drift).length;
    const checks = new Map(
      await Promise.all(forms.map(async (f) => [f.current.map.path, await storage.getCached<KeeperCheckView>('keeper-check', `${origin}|${f.current.map.path}`)] as const)),
    );

    return page(
      `Dashboard · ${origin}`,
      html`<form method="post" action="/dashboard/logout" style="float:right"><button class="secondary">Sign out</button></form>
<h1>${origin}</h1>
<p class="lede">Agents on your forms: who knocked, what they did, what was refused, and the rules they follow.</p>
${notice ?? ''}
<div class="grid">
  <div class="card stat"><b>${records.length}</b><span>forms mapped${drifted ? html`, <span class="badge rule-confirm">${drifted} drifted</span>` : ''}</span></div>
  <div class="card stat"><b>${sessions.length}</b><span>agent sessions</span></div>
  <div class="card stat"><b>${byAgent.size}</b><span>agents seen</span></div>
  <div class="card stat"><b>${blocked.length}</b><span>blocked attempts</span></div>
</div>

<h2 id="explanations">What agents are doing</h2>
<div class="card">${
        explanations.length
          ? html`${explanations.map((e) => html`<h3><code>${e.path}</code> <span class="muted small">${e.sessions} session${e.sessions === 1 ? '' : 's'} · ${e.model} · ${when(e.created_at)}</span></h3><p>${e.text}</p>`)}`
          : html`<p class="muted">No explanations yet.${this.hooks.explain ? ' Generate them once agents have used your forms.' : ''}</p>`
      }
${this.hooks.explain ? html`<form method="post" action="/dashboard/explain"><button class="secondary">Explain recent sessions</button></form>` : ''}</div>

<h2 id="forms">Forms and maps</h2>
<div class="card"><table>
<thead><tr><th>Form</th><th>Purpose</th><th>Elements</th><th>Map</th><th>Status</th><th>Keeper</th></tr></thead>
<tbody>${forms.length ? forms.map(({ current: r, earlier }) => {
        const rebuilt = earlier.find((e) => e.replaced?.by === r.digest);
        const check = checks.get(r.map.path);
        return html`<tr><td><code>${r.map.path}</code></td><td>${r.map.form.purpose}</td><td>${r.map.fields.length} fields, ${r.map.actions.length} actions${earlier.length ? html`<br><span class="small muted">${earlier.length + 1} versions</span>` : ''}</td>
<td class="small">${r.submitted_by ? html`shared by agent <span class="mono">${shortAgent(r.submitted_by)}</span>` : r.map.provenance.compiler ?? r.map.provenance.source}<br><a href="/dashboard/maps/${encodeURIComponent(r.digest)}">view map</a></td>
<td>${r.drift ? html`<span class="badge rule-confirm">drifted</span><br><span class="small muted">similarity ${r.drift.score}, ${when(r.drift.at)}</span>` : rebuilt ? html`<span class="badge rule-allow">current</span><br><span class="small muted">changed at ${when(rebuilt.drift?.at ?? rebuilt.replaced!.at)}, rebuilt at ${when(rebuilt.replaced!.at)}</span>` : html`<span class="badge rule-allow">current</span>`}</td>
<td class="small">${check ? html`${check.outcome}${check.review ? html` <span class="badge rule-confirm">review</span>` : ''}<br><span class="muted">${when(check.checked_at)}</span>` : html`<span class="muted">not checked</span>`}</td></tr>`;
      }) : html`<tr><td colspan="6" class="muted">No maps yet. They appear when Usher reads your forms or an agent shares one.</td></tr>`}</tbody></table></div>

<h2 id="rules">Rules</h2>
<div class="card">${
        policy
          ? html`${policy.text ? html`<p><b>Your rules:</b> “${policy.text}”</p>` : ''}<p class="small muted">Applied ${when(policy.confirmed_at)}.</p>${policySummary(policy.policy, records.map((r) => r.map))}
<details><summary>Policy JSON</summary><pre>${JSON.stringify(policy.policy, null, 2)}</pre></details>`
          : html`<p class="muted">No rules yet: agents may use your forms, and each element's risk decides what needs the user (consequential actions need their confirmation; declarations and payments are theirs alone).</p>`
      }</div>
${pending.map((d) => draftCard(d, records.map((r) => r.map)))}
<form class="card" method="post" action="/dashboard/rules">
  <p><label for="rules-text"><b>Write your rules in plain English.</b> Muse Spark turns them into a policy for you to check before anything changes.</label></p>
  <textarea id="rules-text" name="text" required placeholder="Agents can fill in quotes, but a person confirms the submit, and at most five an hour."></textarea>
  <p><button type="submit">Propose policy</button></p>
</form>

<h2 id="sessions">Agent sessions</h2>
<div class="card"><table>
<thead><tr><th>Agent</th><th>Identity</th><th>Sessions</th><th>Last seen</th><th>Recent</th></tr></thead>
<tbody>${byAgent.size ? [...byAgent].map(
        ([agent, list]) => html`<tr><td class="mono">${shortAgent(agent)}</td><td>${identityBadge(list[0])}</td><td>${list.length}</td><td>${when(list[0]?.created_at)}</td>
<td>${list.slice(0, 5).map((s) => html`<a href="/dashboard/sessions/${s.id}">${s.events.length} events</a> `)}</td></tr>`,
      ) : html`<tr><td colspan="5" class="muted">No agent sessions yet.</td></tr>`}</tbody></table></div>

<h2 id="blocked">Blocked attempts</h2>
<div class="card"><table>
<thead><tr><th>When</th><th>Where</th><th>Why</th><th>Agent</th><th>Refused by</th></tr></thead>
<tbody>${blocked.length ? blocked.slice(0, 50).map(
        (b) => html`<tr><td class="small">${when(b.ts)}</td><td><code>${b.path}</code>${b.action ? html` <span class="small muted">${b.action}</span>` : ''}</td><td>${reasonText(b.reason)}</td><td class="mono small">${shortAgent(b.agent)}</td><td class="small">${b.source === 'site' ? 'your server' : 'Usher'}</td></tr>`,
      ) : html`<tr><td colspan="5" class="muted">Nothing refused yet.</td></tr>`}</tbody></table></div>`,
    );
  }

  async sessionPage(origin: string, sid: string): Promise<string | null> {
    const session = await this.registry.storage.getSession(sid);
    if (!session || session.origin !== origin) return null;
    const explained = await this.registry.storage.getCached<ExplanationView>('session-explanations', sid);
    const events = [...session.events].sort((a, b) => a.ts.localeCompare(b.ts));
    return page(
      'Agent session',
      html`<p class="muted small"><a href="/dashboard#sessions">Dashboard</a> · session ${session.id}</p>
<h1>Agent session</h1>
<p class="lede">Agent <span class="mono">${session.agent}</span> ${identityBadge(session)} · intent <code>${session.intent}</code> · started ${when(session.created_at)}. Events name what was done by meaning, never what was typed.</p>
${this.hooks.explain ? html`<div class="card notice">${explained ? html`<p>${explained.text}</p><p class="small muted">${explained.model} · ${when(explained.created_at)}</p>` : html`<p class="muted">Not explained yet.</p>`}
<form method="post" action="/dashboard/sessions/${session.id}/explain"><button class="secondary">${explained ? 'Explain again' : 'Explain this session'}</button></form></div>` : ''}
<div class="card"><ol class="timeline">${events.map(
        (e) => html`<li><span class="small">${e.ts.slice(11, 19)}</span><span class="src small">${e.source}</span><span><b>${e.action}</b>${e.key ? html` <code>${e.key}</code>` : ''}${e.path ? html` <span class="muted small">on ${e.path}</span>` : ''}${e.detail ? html` <span class="muted small">${detailText(e.detail)}</span>` : ''}</span></li>`,
      )}</ol></div>`,
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

function policySummary(policy: import('@usher/core').UsherPolicy, maps: import('@usher/core').UsherMap[]): Raw {
  const rows = maps
    .map((m) => ({ path: m.path, rules: effectiveRules(policy, m, m.path) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const limits = [...(policy.default.rate_limits ?? []), ...(policy.forms ?? []).flatMap((f) => f.rate_limits ?? [])];
  return html`<table class="small"><thead><tr><th>Form</th><th>Agents</th><th>Needs the user's confirmation</th><th>Agents may not</th></tr></thead><tbody>${rows.map(
    (r) => html`<tr><td><code>${r.path}</code></td><td>${r.rules.agent_lane ? ruleBadge('allow') : ruleBadge('forbid')}</td>
<td>${Object.entries(r.rules.actions).filter(([, v]) => v === 'confirm').map(([k]) => html`<code>${k}</code> `)}</td>
<td>${Object.entries(r.rules.actions).filter(([, v]) => v === 'forbid').map(([k]) => html`<code>${k}</code> `)}</td></tr>`,
  )}</tbody></table>
${limits.length ? html`<p class="small">Limits: ${limits.map((l) => html`at most ${l.max} <code>${l.action}</code> per ${l.per} per ${l.window}; `)}</p>` : ''}
${policy.agents?.block?.length ? html`<p class="small">Blocked agents: ${policy.agents.block.map((a) => html`<span class="mono">${shortAgent(a)}</span> `)}</p>` : ''}
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
