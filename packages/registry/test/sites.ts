import type { RunningRegistry } from '../src/index.ts';

export interface SiteKeys {
  origin: string;
  site_key: string;
  secret_key: string;
}

/**
 * Registers an origin with a running registry and returns its keys. Test origins are local, so the
 * claim is made the development way unless the test wants to prove it itself.
 */
export async function registerSite(registry: RunningRegistry, origin: string, options: { claim?: boolean } = {}): Promise<SiteKeys> {
  const res = await fetch(`${registry.url}/sites`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin }) });
  if (res.status !== 201) throw new Error(`register ${origin}: ${res.status}`);
  const keys = (await res.json()) as SiteKeys;
  if (options.claim !== false) await registry.registry.claimForDevelopment(origin);
  return keys;
}

/** Reads a session with the site's secret key. */
export async function readSession(registry: RunningRegistry, sid: string, secret: string) {
  const res = await fetch(`${registry.url}/sessions/${sid}`, { headers: { Authorization: `Bearer ${secret}` } });
  if (!res.ok) throw new Error(`session ${sid}: ${res.status}`);
  return res.json();
}
