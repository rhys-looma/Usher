// The learning loop pages: /learning in public, /dashboard/learning for a signed-in owner. Four
// counters (two live from storage), the loop with each step linked, the reusable paragraph.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRegistry, type RunningRegistry } from '../src/index.ts';
import { LOOP_PARAGRAPH } from '../src/web/learning.ts';
import { registerSite, type SiteKeys } from './sites.ts';
import { testStorage } from './storage-helper.ts';

let dir: string;
let running: RunningRegistry;
let keys: SiteKeys;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-learning-'));
  running = await startRegistry({ storage: await testStorage(dir), siteScript: fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url)), web: { allowPrivate: true } });
  keys = await registerSite(running, 'http://localhost:4177');
  await running.registry.storage.appendLog('corrections', { ts: new Date().toISOString(), task: 'correction', owner_verified: true, origin: keys.origin, owner: { key: 'custom.forename', risk: 'safe' } });
  await running.registry.storage.appendLog('corrections', { ts: new Date().toISOString(), task: 'correction', owner_verified: true, origin: 'https://other.example', owner: { key: 'person.smoker', risk: 'needs_user' } });
});
after(async () => {
  await running.close();
  await rm(dir, { recursive: true });
});

test('/learning: four counters, the loop with every step linked, and the paragraph', async () => {
  const res = await fetch(`${running.url}/learning`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text.match(/class="counter"/g)?.length, 4);
  assert.match(text, /<b>2<\/b><span>corrections by site owners/);
  assert.match(text, /<svg class="loop"[^>]*role="img"/);
  for (const href of ['/viewer', '/demo/walkthrough', '#steps']) assert.ok(text.includes(`href="${href}"`), href);
  assert.ok(text.includes(LOOP_PARAGRAPH.slice(0, 60)));
  assert.match(text, /<ol class="steps-text">/, 'the loop as text too');
  assert.ok(!text.includes('custom.forename'), 'counts only, no labels');
});

test('/dashboard/learning: the owner\'s own corrections, behind sign-in', async () => {
  assert.notEqual((await fetch(`${running.url}/dashboard/learning`, { redirect: 'manual' })).status, 200);
  const login = await fetch(`${running.url}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: keys.origin, secret: keys.secret_key }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const text = await (await fetch(`${running.url}/dashboard/learning`, { headers: { Cookie: cookie } })).text();
  assert.match(text, /Teaching the mapper/);
  assert.match(text, /<b>1<\/b><span>corrections you have made/);
  assert.ok(text.includes('href="/dashboard/walkthrough"'));
});
