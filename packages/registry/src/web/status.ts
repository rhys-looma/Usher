// /status, for whoever runs the registry (behind USHER_ADMIN_KEY): what is running, how long for,
// on which store, model spend today against the cap, the keeper's last pass, and the last 24 hours
// of agent sessions and blocked attempts. JSON for monitors, a page for people.

import type { KeeperRun } from '../keeper.ts';
import type { Registry } from '../registry.ts';
import { html, page } from './html.ts';

export interface StatusSources {
  /** The running image's git SHA (USHER_VERSION, baked in at build), or "dev". */
  version: string;
  started: Date;
  /** Today's model spend (UTC) and the daily cap. */
  spend?: { today: () => Promise<number>; cap: number };
}

export interface Status {
  version: string;
  uptime_s: number;
  store: string;
  healthy: boolean;
  spend_today_usd: number | null;
  spend_cap_usd: number | null;
  keeper_last_run: KeeperRun | null;
  sessions_24h: number;
  blocked_24h: number;
}

export async function statusReport(registry: Registry, sources: StatusSources, now = new Date()): Promise<Status> {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const health = await registry.health();
  const blocked = (await registry.storage.readLog('blocked')) as { ts?: string }[];
  return {
    version: sources.version,
    uptime_s: Math.round((now.getTime() - sources.started.getTime()) / 1000),
    store: health.storage,
    healthy: health.ok,
    spend_today_usd: sources.spend ? Math.round((await sources.spend.today()) * 1e4) / 1e4 : null,
    spend_cap_usd: sources.spend?.cap ?? null,
    keeper_last_run: (await registry.storage.getCached<KeeperRun>('keeper-run', 'last')) ?? null,
    sessions_24h: await registry.storage.countSessionsSince(since),
    blocked_24h: blocked.filter((b) => (b.ts ?? '') >= since).length,
  };
}

function duration(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${seconds % 60}s`;
}

export function statusPage(s: Status): string {
  const run = s.keeper_last_run;
  const rows: [string, string][] = [
    ['Version', s.version],
    ['Up for', duration(s.uptime_s)],
    ['Store', `${s.store}${s.healthy ? '' : ' (not answering)'}`],
    ['Model spend today', s.spend_today_usd === null ? 'no models configured' : `$${s.spend_today_usd.toFixed(4)} of $${s.spend_cap_usd?.toFixed(2)} (UTC day)`],
    ['Keeper, last run', run ? `${run.at.replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC')}: ${run.forms} forms (${Object.entries(run.outcomes).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}), $${run.cost_usd.toFixed(4)}` : 'not run yet'],
    ['Agent sessions, last 24 h', String(s.sessions_24h)],
    ['Blocked attempts, last 24 h', String(s.blocked_24h)],
  ];
  return page('Status', html`<h1>Status</h1><p class="lede">This registry, now. As JSON: <code>Accept: application/json</code>.</p>
<div class="card"><table><tbody>${rows.map(([k, v]) => html`<tr><th>${k}</th><td>${v}</td></tr>`)}</tbody></table></div>
<p class="small muted"><a href="/admin">Interest list</a></p>`);
}
