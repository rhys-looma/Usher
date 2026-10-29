// Mapped sites that haven't joined, listed by Usher's admin for hosted Usher (/admin/sites): the
// listing, publishing the maps agents built there, finding the site by name, and what ChatGPT is told.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteList } from '../../mcp/src/hosted.ts';
import { seedMaps, startRegistry, visibleTo, type RunningRegistry } from '../src/index.ts';
import { testStorage } from './storage-helper.ts';

const ADMIN = 'an-admin-key-of-at-least-32-characters';
const ORIGIN = 'https://www.insurer.example';
const admin = { Authorization: `Bearer ${ADMIN}` };
let dir: string;
let running: RunningRegistry;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-listed-'));
  running = await startRegistry({ storage: await testStorage(dir), siteScript: fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url)), web: { allowPrivate: true, adminKey: ADMIN } });
  // A hosted fill mapped three pages here; each map is private to the connection's agent.
  for (const map of (await seedMaps('mock-site')).filter((m) => m.path.startsWith('/health/'))) {
    await running.registry.storage.putMap({ digest: map.fingerprint.digest, map: { ...map, origin: ORIGIN }, added_at: new Date().toISOString(), submitted_by: 'hosted-agent-1' });
  }
});
after(async () => {
  await running.close();
  await rm(dir, { recursive: true });
});

test('a mapped site that hasn\'t joined is listed on /admin/sites, and hosted Usher refuses it until listed', async () => {
  const text = await (await fetch(`${running.url}/admin/sites`, { headers: admin })).text();
  assert.match(text, /Mapped, not joined/);
  assert.ok(text.includes(ORIGIN));
  assert.match(text, /3 maps, 3 private/);
  assert.equal(await running.registry.joined(ORIGIN), false);
  assert.equal((await running.registry.resolveTask('Insurer', 'health insurance')).status, 'not_joined');
});

test('listing it (and publishing its agents\' maps) opens it to hosted Usher, by name, flagged as not joined', async () => {
  assert.equal((await fetch(`${running.url}/admin/listed`, { method: 'POST', body: new URLSearchParams({ origin: ORIGIN, name: 'Insurer' }) })).status, 401);
  const bad = await fetch(`${running.url}/admin/listed`, { method: 'POST', headers: admin, body: new URLSearchParams({ origin: ORIGIN, name: 'Insurer', start: 'https://elsewhere.example/x', intent: 'quote.life_insurance' }) });
  assert.equal(bad.status, 422);
  const res = await fetch(`${running.url}/admin/listed`, { method: 'POST', headers: admin, body: new URLSearchParams({ origin: ORIGIN, name: 'Insurer', publish: '1' }) });
  assert.match(await res.text(), /Insurer is open to hosted Usher\. Published 3 maps/);
  assert.equal(await running.registry.joined(ORIGIN), true);
  assert.ok((await running.registry.storage.mapsForOrigin(ORIGIN)).every((r) => visibleTo(r) && r.verification?.by === 'admin'));
  const resolved = await running.registry.resolveTask('Insurer', 'health insurance quote');
  assert.equal(resolved.status, 'resolved');
  assert.ok('url' in resolved && resolved.url.startsWith(`${ORIGIN}/health/`));
  const site = (await running.registry.joinedSites()).find((s) => s.origin === ORIGIN)!;
  assert.equal(site.listed, true);
  assert.match(siteList([site]), /^- Insurer \(www\.insurer\.example\): .*\(mapped by Usher; the site itself hasn't joined\)\.$/);
});

test('a journey the admin names works before any public map, and closing it refuses again', async () => {
  const other = 'https://life.example';
  await fetch(`${running.url}/admin/listed`, { method: 'POST', headers: admin, body: new URLSearchParams({ origin: other, name: 'Life Co', start: `${other}/quote/start`, intent: 'quote.life_insurance' }) });
  const resolved = await running.registry.resolveTask('Life Co', 'life insurance');
  assert.deepEqual('url' in resolved && [resolved.url, resolved.intent], [`${other}/quote/start`, 'quote.life_insurance']);
  await fetch(`${running.url}/admin/listed/remove`, { method: 'POST', headers: admin, body: new URLSearchParams({ origin: other }) });
  assert.equal(await running.registry.joined(other), false);
  assert.equal((await running.registry.resolveTask('Life Co', 'life insurance')).status, 'not_joined');
});
