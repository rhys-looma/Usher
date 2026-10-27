// /status: behind the admin key (cookie or bearer), as JSON or a page, with the version, uptime,
// store, spend against the cap, the keeper's last run and the last 24 hours of sessions and
// blocked attempts. The picker refresh loads nothing once the day's budget is spent.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Viewer, startRegistry, type RunningRegistry } from '../src/index.ts';
import { testStorage } from './storage-helper.ts';

const ADMIN = 'status-test-admin-key-0000000000000';
let dir: string;
let registry: RunningRegistry;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-status-'));
  registry = await startRegistry({ storage: await testStorage(dir), web: { adminKey: ADMIN, status: { version: 'abc123def456', spend: { today: async () => 0.4321, cap: 5 } } } });
});
after(async () => {
  await registry.close();
  await rm(dir, { recursive: true });
});

test('/status needs the admin key', async () => {
  assert.equal((await fetch(`${registry.url}/status`, { headers: { Accept: 'application/json' } })).status, 401);
  assert.equal((await fetch(`${registry.url}/status`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const page = await fetch(`${registry.url}/status`);
  assert.equal(page.status, 401);
  assert.match(await page.text(), /Admin key/);
});

test('/status reports the version, store, spend, keeper run, and the last 24 hours', async () => {
  const storage = registry.registry.storage;
  const now = new Date();
  await storage.putSession({ id: 's_status_recent', origin: 'https://a.example', agent: 'a', intent: 'x', created_at: now.toISOString(), events: [] });
  await storage.putSession({ id: 's_status_old', origin: 'https://a.example', agent: 'a', intent: 'x', created_at: new Date(now.getTime() - 2 * 86_400_000).toISOString(), events: [] });
  await storage.appendLog('blocked', { ts: now.toISOString(), origin: 'https://a.example', path: '/', reason: 'missing' });
  await storage.appendLog('blocked', { ts: new Date(now.getTime() - 3 * 86_400_000).toISOString(), origin: 'https://a.example', path: '/', reason: 'missing' });
  await storage.putCached('keeper-run', 'last', { at: now.toISOString(), forms: 3, outcomes: { unchanged: 3 }, cost_usd: 0 });

  const res = await fetch(`${registry.url}/status`, { headers: { Authorization: `Bearer ${ADMIN}`, Accept: 'application/json' } });
  assert.equal(res.status, 200);
  const status = await res.json();
  assert.equal(status.version, 'abc123def456');
  assert.ok(status.uptime_s >= 0);
  assert.ok(['file', 'postgres'].includes(status.store));
  assert.deepEqual([status.spend_today_usd, status.spend_cap_usd], [0.4321, 5]);
  assert.deepEqual(status.keeper_last_run.outcomes, { unchanged: 3 });
  assert.equal(status.sessions_24h, 1);
  assert.equal(status.blocked_24h, 1);

  const page = await (await fetch(`${registry.url}/status`, { headers: { Authorization: `Bearer ${ADMIN}` } })).text();
  assert.match(page, /\$0\.4321 of \$5\.00/);
  assert.match(page, /3 forms \(3 unchanged\)/);
});

test('the picker refresh loads nothing once the day\'s budget is spent', async () => {
  const viewer = new Viewer({ storage: registry.registry.storage, chat: async () => { throw new Error('no model call expected'); }, model: 'muse-spark-1.3', forms: [{ id: 'x', name: 'X', about: 'x', url: 'https://x.example/' }], overBudget: async () => true });
  assert.deepEqual(await viewer.refreshPicker(), [{ id: '*', ok: false, detail: "today's model budget is used up" }]);
  await viewer.close();
});
