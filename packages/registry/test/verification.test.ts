// The verification ladder for maps agents share. An agent's map is stored unverified and served
// only to that agent. It becomes verified, and public, when a second agent's own map of the same
// structure has the same keys and that agent completes a run, or when the keeper rebuilds the form
// and gets the same map. A wrong or hostile map never reaches another identity.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAgentIdentity, type UsherMap } from '@usher/core';
import { readFixture, replayAny } from '../../core/test/replay.ts';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { RegistryClient, seedMaps, startRegistry, type RunningRegistry } from '../src/index.ts';
import { registerSite } from './sites.ts';
import { testStorage } from './storage-helper.ts';

const agent = async (registry: RunningRegistry) => new RegistryClient(registry.url, (await generateAgentIdentity()).identity);
// An established identity: it has completed a run on another site before.
const establish = async (client: RegistryClient, origin = 'http://elsewhere.example') => {
  const knock = await client.knock({ url: `${origin}/contact`, intent: 'contact.message' });
  await client.reportRun({ session: knock.session, url: `${origin}/contact`, outcome: 'completed' });
};
const asAgentMap = (m: UsherMap, origin: string): UsherMap => ({ ...m, origin, provenance: { source: 'agent', compiler: 'muse-spark-1.3', created_at: new Date().toISOString(), verified: false } });
// A hostile map: the same structure, with the name and email keys swapped (a user's email would go
// into the name box).
const poison = (m: UsherMap): UsherMap => ({ ...m, fields: m.fields.map((f) => (f.key === 'person.first_name' ? { ...f, key: 'contact.email' } : f.key === 'contact.email' ? { ...f, key: 'person.first_name' } : f)) });

let dir: string;
let registry: RunningRegistry;
let driver: UsherMap;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-verify-'));
  registry = await startRegistry({ storage: await testStorage(join(dir, 'a')), submitLimit: 5, web: {} });
  driver = (await seedMaps('mock-site')).find((m) => m.path === '/quote/driver')!;
});
after(async () => {
  await registry.close();
  await rm(dir, { recursive: true });
});

test('isolation: an agent\'s map is served to that agent only, by every route', async () => {
  const origin = 'http://localhost:4210';
  const map = asAgentMap(driver, origin);
  const [a, b] = [await agent(registry), await agent(registry)];
  assert.deepEqual(await a.submitMap(map), { digest: map.fingerprint.digest, stored: true, verified: false });
  assert.equal((await a.knock({ url: `${origin}/quote/driver`, fingerprint: map.fingerprint, intent: 'quote.car_insurance' })).match.kind, 'exact', 'its own agent');
  const other = await b.knock({ url: `${origin}/quote/driver`, fingerprint: map.fingerprint, intent: 'quote.car_insurance' });
  assert.equal(other.match.kind, 'none', 'another identity');
  assert.equal(other.map, null);
  assert.equal((await b.lookup(origin, '/quote/driver', map.fingerprint)).match.kind, 'none');
  assert.equal((await fetch(`${registry.url}/maps/${map.fingerprint.digest}?origin=${encodeURIComponent(origin)}`)).status, 404);
  assert.equal((await fetch(`${registry.url}/maps/view?origin=${encodeURIComponent(origin)}&digest=${map.fingerprint.digest}`)).status, 404);
  assert.equal((await (await fetch(`${registry.url}/maps/current?origin=${encodeURIComponent(origin)}&path=/quote/driver`)).json()).digest, null, 'the site script sees no map');
});

test('two agents: a second identity\'s matching map and a completed run verify it, and then everyone gets it', async () => {
  const origin = 'http://localhost:4211';
  const map = asAgentMap(driver, origin);
  const [a, b, c] = [await agent(registry), await agent(registry), await agent(registry)];
  await establish(b);
  await a.submitMap(map);
  const knock = await b.knock({ url: `${origin}/quote/driver`, fingerprint: map.fingerprint, intent: 'quote.car_insurance' });
  assert.equal(knock.match.kind, 'none');
  assert.deepEqual(await b.submitMap(map), { digest: map.fingerprint.digest, stored: false, agreed: true }, 'B built the same map on its own');
  assert.equal((await c.knock({ url: `${origin}/quote/driver`, fingerprint: map.fingerprint, intent: 'quote.car_insurance' })).match.kind, 'none', 'agreement alone is not enough');
  await b.reportRun({ session: knock.session, url: `${origin}/quote/driver`, outcome: 'completed' });
  const record = (await registry.registry.storage.getMap(origin, map.fingerprint.digest))!;
  assert.equal(record.verification?.by, 'agent');
  assert.ok(record.verification?.at);
  assert.equal(record.map.provenance.verified, true);
  assert.equal((await c.knock({ url: `${origin}/quote/driver`, fingerprint: map.fingerprint, intent: 'quote.car_insurance' })).match.kind, 'exact', 'now public');
  assert.match(await (await fetch(`${registry.url}/maps/view?origin=${encodeURIComponent(origin)}&digest=${map.fingerprint.digest}`)).text(), /Verified .* by a second agent/);
});

test('a brand-new identity can\'t confirm a map: two fresh keys can\'t agree with themselves', async () => {
  const origin = 'http://localhost:4214';
  const map = asAgentMap(driver, origin);
  const [a, fresh] = [await agent(registry), await agent(registry)];
  await a.submitMap(map);
  const knock = await fresh.knock({ url: `${origin}/quote/driver`, fingerprint: map.fingerprint, intent: 'quote.car_insurance' });
  assert.deepEqual(await fresh.submitMap(map), { digest: map.fingerprint.digest, stored: false, agreed: true });
  await fresh.reportRun({ session: knock.session, url: `${origin}/quote/driver`, outcome: 'completed' });
  assert.equal((await registry.registry.storage.getMap(origin, map.fingerprint.digest))!.verification, undefined, 'agreed, but not established');
  // Once it has completed a run elsewhere, its next completed run here confirms the map.
  await establish(fresh);
  const again = await fresh.knock({ url: `${origin}/quote/driver`, fingerprint: map.fingerprint, intent: 'quote.car_insurance' });
  await fresh.reportRun({ session: again.session, url: `${origin}/quote/driver`, outcome: 'completed' });
  assert.equal((await registry.registry.storage.getMap(origin, map.fingerprint.digest))!.verification?.by, 'agent');
});

test('where the keeper visits, agents\' agreement never verifies a map: the keeper decides', async () => {
  const origin = 'http://localhost:4215';
  registry.registry.keeperVisits = (o) => o === origin;
  try {
    const map = asAgentMap(driver, origin);
    const [a, b] = [await agent(registry), await agent(registry)];
    await establish(b);
    await a.submitMap(map);
    const knock = await b.knock({ url: `${origin}/quote/driver`, fingerprint: map.fingerprint, intent: 'quote.car_insurance' });
    await b.submitMap(map);
    await b.reportRun({ session: knock.session, url: `${origin}/quote/driver`, outcome: 'completed' });
    assert.equal((await registry.registry.storage.getMap(origin, map.fingerprint.digest))!.verification, undefined);
  } finally {
    registry.registry.keeperVisits = undefined;
  }
});

test('an agent can\'t verify its own map, even with a run', async () => {
  const origin = 'http://localhost:4212';
  const map = asAgentMap(driver, origin);
  const a = await agent(registry);
  await a.submitMap(map);
  const knock = await a.knock({ url: `${origin}/quote/driver`, fingerprint: map.fingerprint, intent: 'quote.car_insurance' });
  await a.submitMap(map);
  await a.reportRun({ session: knock.session, url: `${origin}/quote/driver`, outcome: 'completed' });
  assert.equal((await registry.registry.storage.getMap(origin, map.fingerprint.digest))!.verification, undefined);
});

test('a poisoned map from one identity never reaches another, and an honest disagreement never verifies it', async () => {
  const origin = 'http://localhost:4213';
  const honest = asAgentMap(driver, origin);
  const bad = poison(honest);
  assert.equal(bad.fingerprint.digest, honest.fingerprint.digest, 'same structure');
  const [mallory, b, c] = [await agent(registry), await agent(registry), await agent(registry)];
  await establish(b);
  await mallory.submitMap(bad);
  const knock = await b.knock({ url: `${origin}/quote/driver`, fingerprint: honest.fingerprint, intent: 'quote.car_insurance' });
  assert.equal(knock.map, null, 'B never sees it');
  assert.deepEqual(await b.submitMap(honest), { digest: honest.fingerprint.digest, stored: false, agreed: false });
  await b.reportRun({ session: knock.session, url: `${origin}/quote/driver`, outcome: 'completed' });
  const record = (await registry.registry.storage.getMap(origin, honest.fingerprint.digest))!;
  assert.equal(record.verification, undefined, 'still unverified');
  assert.equal(record.disagreements, 1);
  for (const other of [b, c]) {
    const seen = await other.knock({ url: `${origin}/quote/driver`, fingerprint: honest.fingerprint, intent: 'quote.car_insurance' });
    assert.equal(seen.map, null, 'never served to another identity');
  }
});

test('submissions are rate limited per identity', async () => {
  const a = await agent(registry);
  const maps = (await seedMaps('mock-site')).map((m, i) => asAgentMap(m, `http://localhost:${4220 + i}`));
  for (const m of maps.slice(0, 3)) await a.submitMap(m);
  for (const m of maps.slice(0, 2)) await a.submitMap({ ...m, origin: m.origin.replace('42', '43') });
  await assert.rejects(() => a.submitMap({ ...maps[0]!, origin: 'http://localhost:4399' }), /rate_limited/);
  const b = await agent(registry);
  assert.equal((await b.submitMap({ ...maps[0]!, origin: 'http://localhost:4398' })).stored, true, 'another identity is not held back');
});

// The keeper: rebuilds the live form and compares, on the mock site.
let kdir: string;
let keeperRegistry: RunningRegistry;
let site: MockSite;
const labels = await Promise.all((['driver', 'vehicle', 'cover'] as const).map((s) => readFixture('a', s)));
test('the keeper verifies an agent\'s map when its own rebuild matches, and replaces one it disagrees with', async (t) => {
  kdir = await mkdtemp(join(tmpdir(), 'usher-verify-keeper-'));
  keeperRegistry = await startRegistry({ storage: await testStorage(kdir), keeper: { compiler: { chat: replayAny(labels), model: 'muse-spark-1.3' } } });
  site = await startMockSite({ registry: keeperRegistry.url, register: async (o) => (await registerSite(keeperRegistry, o)).site_key });
  t.after(async () => {
    await site.stop();
    await keeperRegistry.close();
    await rm(kdir, { recursive: true });
  });
  const a = await agent(keeperRegistry);
  const map = asAgentMap(driver, site.url);
  await a.submitMap(map);
  const verified = await keeperRegistry.keeper!.verifyAgentMap((await keeperRegistry.registry.storage.getMap(site.url, map.fingerprint.digest))!);
  assert.equal(verified, 'verified');
  const record = (await keeperRegistry.registry.storage.getMap(site.url, map.fingerprint.digest))!;
  assert.equal(record.verification?.by, 'keeper');
  assert.equal(record.map.provenance.verified, true);

  // A poisoned map on a site the keeper visits: the keeper's own map takes its place.
  const b = await agent(keeperRegistry);
  await keeperRegistry.registry.storage.putMap({ digest: map.fingerprint.digest, map: poison(map), added_at: new Date().toISOString(), submitted_by: 'mallory' });
  assert.equal(await keeperRegistry.keeper!.verifyAgentMap((await keeperRegistry.registry.storage.getMap(site.url, map.fingerprint.digest))!), 'differs');
  const replaced = (await keeperRegistry.registry.storage.getMap(site.url, map.fingerprint.digest))!;
  assert.equal(replaced.submitted_by, undefined);
  assert.equal(replaced.verification?.by, 'keeper');
  assert.equal(replaced.map.fields.find((f) => f.label.match(/first name/i))?.key, 'person.first_name', 'the honest keys');
  assert.equal((await b.knock({ url: `${site.url}/quote/driver`, fingerprint: map.fingerprint, intent: 'quote.car_insurance' })).map?.fields.find((f) => /email/i.test(f.label))?.key, 'contact.email');
});
