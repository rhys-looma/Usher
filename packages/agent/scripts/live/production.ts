// What the live demo runner reads and changes in production: the public registry and the
// Brightwater demo site. Addresses come from @usher-run/mcp's manifest (or USHER_REGISTRY_URL,
// BRIGHTWATER_URL); the demo site's admin key from USHER_ADMIN_KEY, else AWS Secrets Manager
// (usher/USHER_ADMIN_KEY). The key is only ever sent to the site's own admin form, never printed.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { UsherMap } from '@usher/core';

const root = new URL('../../../../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('packages/mcp/package.json', root), 'utf8')) as { usher: { defaultRegistry: string; demoForm: string } };

export const REGISTRY = (process.env.USHER_REGISTRY_URL ?? manifest.usher.defaultRegistry).replace(/\/$/, '');
export const SITE = new URL(process.env.BRIGHTWATER_URL ?? manifest.usher.demoForm).origin;
export const DRIVER = `${SITE}/quote/driver`;
export const PATHS = ['/quote/driver', '/quote/vehicle', '/quote/cover'] as const;

let adminKey: string | undefined;
async function admin(): Promise<string> {
  if (adminKey) return adminKey;
  if (process.env.USHER_ADMIN_KEY) return (adminKey = process.env.USHER_ADMIN_KEY);
  const { stdout } = await promisify(execFile)('aws', ['secretsmanager', 'get-secret-value', '--secret-id', 'usher/USHER_ADMIN_KEY', '--query', 'SecretString', '--output', 'text', '--region', process.env.AWS_REGION ?? 'eu-west-2']);
  return (adminKey = stdout.trim());
}

export async function layout(): Promise<'a' | 'b'> {
  return ((await (await fetch(`${SITE}/healthz`, { cache: 'no-store' })).json()) as { layout: 'a' | 'b' }).layout;
}

/** Switches the demo site's form layout (its /__admin form). */
export async function setLayout(variant: 'a' | 'b'): Promise<void> {
  const res = await fetch(`${SITE}/__admin/variant`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ key: await admin(), variant }) });
  if (res.status !== 302 && res.status !== 303) throw new Error(`Switching to layout ${variant.toUpperCase()} failed: HTTP ${res.status}.`);
}

/** The registry's current map digest for a path on the demo site. */
export async function currentDigest(path: string): Promise<string | null> {
  const res = await fetch(`${REGISTRY}/maps/current?origin=${encodeURIComponent(SITE)}&path=${encodeURIComponent(path)}`, { cache: 'no-store' });
  return ((await res.json()) as { digest: string | null }).digest;
}

export async function mapByDigest(digest: string): Promise<UsherMap> {
  const res = await fetch(`${REGISTRY}/maps/${digest}?origin=${encodeURIComponent(SITE)}`);
  if (!res.ok) throw new Error(`No map ${digest}: HTTP ${res.status}.`);
  return ((await res.json()) as { map: UsherMap }).map;
}

/** The rules the registry gives for a map (the public lookup the site script makes). */
export async function rulesFor(map: UsherMap): Promise<{ actions: Record<string, 'allow' | 'confirm' | 'forbid'> }> {
  const res = await fetch(`${REGISTRY}/maps/lookup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: SITE, path: map.path, fingerprint: map.fingerprint }) });
  return ((await res.json()) as { rules: { actions: Record<string, 'allow' | 'confirm' | 'forbid'> } }).rules;
}

/** Waits until the current map for a path is not `before` (the keeper rebuilt it); null on timeout. */
export async function waitForNewMap(path: string, before: string | null, timeoutMs: number): Promise<string | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const now = await currentDigest(path);
    if (now && now !== before) return now;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

export interface Dashboard {
  sessions: string[];
  blocked: number;
  explanations: number;
}

/** The public demo dashboard, as anyone sees it. */
export async function dashboard(): Promise<Dashboard> {
  const text = await (await fetch(`${REGISTRY}/demo/dashboard`, { cache: 'no-store' })).text();
  const sessions = [...new Set([...text.matchAll(/href="\/demo\/dashboard\/sessions\/(s_[A-Za-z0-9_-]+)"/g)].map((m) => m[1]!))];
  const blockedTable = /id="blocked"[\s\S]*?<\/table>/.exec(text)?.[0] ?? '';
  const blocked = (blockedTable.match(/<tr><td class="small">/g) ?? []).length;
  const explanations = (/id="explanations"[\s\S]*?<h2/.exec(text)?.[0].match(/<h3><code>/g) ?? []).length;
  return { sessions, blocked, explanations };
}

/** What the keeper last did to a form's map, as the dashboard shows it (rebuilt, restored, unchanged, ...). */
export async function keeperOutcome(path: string): Promise<string> {
  const text = await (await fetch(`${REGISTRY}/demo/dashboard`, { cache: 'no-store' })).text();
  const row = new RegExp(`<tr><td><code>${path.replace(/\//g, '\\/')}</code>[\\s\\S]*?</tr>`).exec(text)?.[0] ?? '';
  return [...row.matchAll(/<td class="small">([^<]*)/g)].at(-1)?.[1]?.trim() || 'unknown';
}

export interface TimelineEvent {
  time: string;
  source: string;
  action: string;
  key?: string;
  detail: string;
}

/** A session's timeline from its public demo page: by meaning, never values. */
export async function timeline(sid: string): Promise<{ agent: string; events: TimelineEvent[] }> {
  const text = await (await fetch(`${REGISTRY}/demo/dashboard/sessions/${sid}`, { cache: 'no-store' })).text();
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const agent = strip(/Agent <span class="mono">([^<]+)<\/span>/.exec(text)?.[1] ?? 'unknown');
  const events = [...text.matchAll(/<li><span class="small">([^<]+)<\/span><span class="src small">([^<]+)<\/span><span><b>([^<]+)<\/b>([\s\S]*?)<\/span><\/li>/g)].map((m) => {
    const key = /<code>([^<]+)<\/code>/.exec(m[4]!)?.[1];
    return { time: m[1]!, source: m[2]!, action: m[3]!, ...(key && { key }), detail: strip(m[4]!) };
  });
  return { agent, events };
}
