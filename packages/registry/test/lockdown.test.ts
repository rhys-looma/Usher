// What is closed until it can be opened safely: agents' shared maps, the keeper outside its list,
// and how often one address can register sites, check claims, send the interest form or sign in.
// In-memory limits stay bounded.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keeper, RateLimiter, startRegistry, type RunningRegistry } from '../src/index.ts';
import { testStorage } from './storage-helper.ts';

let dir: string;
let registry: RunningRegistry;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-lockdown-'));
  registry = await startRegistry({ storage: await testStorage(dir), web: {}, acceptMaps: false, hourly: { signup: 2, interest: 1, login: 2 } });
});
after(async () => {
  await registry.close();
  await rm(dir, { recursive: true });
});

test('agents\' maps are refused when the registry does not accept them', async () => {
  const reply = await registry.registry.submitMap({ map: {} });
  assert.equal(reply.status, 403);
  assert.equal((reply.body as { error: string }).error, 'maps_closed');
});

test('per hour: registering and claim checks, the interest form, sign-in', async () => {
  const post = (path: string, body: string, type = 'application/x-www-form-urlencoded') => fetch(`${registry.url}${path}`, { method: 'POST', body, headers: { 'Content-Type': type }, redirect: 'manual' });
  assert.notEqual((await post('/sites', '{"origin":"https://a.example"}', 'application/json')).status, 429);
  assert.notEqual((await post('/sites/new', 'origin=https://b.example')).status, 429);
  assert.equal((await post('/sites/lost', 'origin=https://a.example')).status, 429, 'signup and claim checks share one allowance');
  assert.notEqual((await post('/interest', 'site=https://c.example&email=a@c.example')).status, 429);
  assert.equal((await post('/interest', 'site=https://c.example&email=a@c.example')).status, 429);
  for (const expected of [false, false, true]) assert.equal((await post('/dashboard/login', 'origin=https://a.example&secret=uss_x')).status === 429, expected);
});

test('the keeper opens only listed origins', async () => {
  const keeper = new Keeper(registry.registry, { origins: ['https://listed.example'] });
  const check = await keeper.check('https://other.example', '/form');
  assert.equal(check.outcome, 'paused');
  assert.deepEqual(await keeper.runAll(), []);
  await keeper.close();
});

test('rate limiter memory stays bounded when callers rotate addresses', () => {
  let now = 0;
  const limiter = new RateLimiter(5, 60_000, () => now, 1_000);
  for (let i = 0; i < 10_000; i++) {
    now += 1;
    limiter.allow(`client-${i}`);
  }
  assert.ok((limiter as unknown as { hits: Map<string, number[]> }).hits.size <= 1_000);
  // A recent caller is still limited.
  for (let i = 0; i < 5; i++) limiter.allow('steady');
  assert.equal(limiter.allow('steady'), false);
});

test('sessions for sites nobody registered are deleted after the default retention', async () => {
  const storage = registry.registry.storage;
  const old = new Date(Date.now() - 91 * 86_400_000).toISOString();
  await storage.putSession({ id: 's_orphan_old', origin: 'https://nobody.example', agent: 'a', intent: 'x', created_at: old, events: [] });
  await storage.putSession({ id: 's_orphan_new', origin: 'https://nobody.example', agent: 'a', intent: 'x', created_at: new Date().toISOString(), events: [] });
  await registry.registry.registerSite({ origin: 'https://owned.example' });
  await storage.putSession({ id: 's_owned_old', origin: 'https://owned.example', agent: 'a', intent: 'x', created_at: old, events: [] });
  assert.equal(await registry.registry.pruneUnregisteredSessions(), 1);
  assert.equal(await storage.getSession('s_orphan_old'), undefined);
  assert.ok(await storage.getSession('s_orphan_new'));
  assert.ok(await storage.getSession('s_owned_old'), 'registered sites follow their own retention');
});
