// /admin/sites: with the admin key, every site, and any site's dashboard opened with its owner's
// powers. The admin's sign-in is short, every page says it is the admin, and every change is logged
// and shown to the owner.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UsherMap, UsherPolicy } from '@usher/core';
import { startRegistry, type RunningRegistry } from '../src/index.ts';
import { registerSite, type SiteKeys } from './sites.ts';
import { testStorage } from './storage-helper.ts';

const ADMIN = 'an-admin-key-of-at-least-32-characters';
let dir: string;
let running: RunningRegistry;
let claimed: SiteKeys;
let unclaimed: SiteKeys;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-admin-sites-'));
  running = await startRegistry({ storage: await testStorage(dir), siteScript: fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url)), web: { allowPrivate: true, adminKey: ADMIN } });
  claimed = await registerSite(running, 'http://localhost:4181');
  unclaimed = await registerSite(running, 'http://localhost:4182', { claim: false });
});
after(async () => {
  await running.close();
  await rm(dir, { recursive: true });
});

async function openAs(origin: string): Promise<{ cookie: string; header: string }> {
  const res = await fetch(`${running.url}/admin/sites/open`, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${ADMIN}` }, body: new URLSearchParams({ origin }) });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/dashboard');
  const header = res.headers.get('set-cookie')!;
  return { cookie: header.split(';')[0]!, header };
}

test('/admin/sites needs the admin key and lists every site, proved or not', async () => {
  const signedOut = await fetch(`${running.url}/admin/sites`);
  assert.equal(signedOut.status, 401, 'the sign-in form');
  assert.doesNotMatch(await signedOut.text(), /localhost:4181/);
  const text = await (await fetch(`${running.url}/admin/sites`, { headers: { Authorization: `Bearer ${ADMIN}` } })).text();
  assert.match(text, /<h1>All sites<\/h1>/);
  for (const origin of [claimed.origin, unclaimed.origin]) assert.ok(text.includes(origin), origin);
  assert.match(text, /not proved/);
  assert.equal((text.match(/Open as owner/g) ?? []).length, 2);
});

test('opening a site needs the admin key, and the sign-in lasts two hours', async () => {
  const refused = await fetch(`${running.url}/admin/sites/open`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: claimed.origin }) });
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get('set-cookie'), null);
  const unknown = await fetch(`${running.url}/admin/sites/open`, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${ADMIN}` }, body: new URLSearchParams({ origin: 'https://nobody.example' }) });
  assert.equal(unknown.status, 404);
  const { header } = await openAs(claimed.origin);
  assert.match(header, /Max-Age=7200/);
});

test('the admin sees the owner\'s dashboard with a banner, even before the site has proved its origin', async () => {
  const { cookie } = await openAs(claimed.origin);
  const text = await (await fetch(`${running.url}/dashboard`, { headers: { Cookie: cookie } })).text();
  assert.match(text, /Signed in as Usher's admin/);
  assert.match(text, /agent sessions/);
  const other = await openAs(unclaimed.origin);
  const page = await (await fetch(`${running.url}/dashboard`, { headers: { Cookie: other.cookie } })).text();
  assert.match(page, /agent sessions/, 'the dashboard, not the claim page');
  // An owner of an unproved site still sees only what's missing.
  const login = await fetch(`${running.url}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: unclaimed.origin, secret: unclaimed.secret_key }) });
  const owner = login.headers.get('set-cookie')!.split(';')[0]!;
  const claim = await (await fetch(`${running.url}/dashboard`, { headers: { Cookie: owner } })).text();
  assert.doesNotMatch(claim, /agent sessions/);
  assert.doesNotMatch(claim, /Signed in as Usher's admin/);
});

test('the admin\'s changes are logged and shown to the owner, by action only', async () => {
  const { cookie } = await openAs(claimed.origin);
  const res = await fetch(`${running.url}/dashboard/rules`, { method: 'POST', headers: { Cookie: cookie }, body: new URLSearchParams({ text: 'agents may never tick marketing consent' }) });
  assert.ok(res.status === 200 || res.status === 422);
  const login = await fetch(`${running.url}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: claimed.origin, secret: claimed.secret_key }) });
  const owner = login.headers.get('set-cookie')!.split(';')[0]!;
  const text = await (await fetch(`${running.url}/dashboard`, { headers: { Cookie: owner } })).text();
  assert.match(text, /Changes by Usher's admin/);
  assert.match(text, /<code>POST \/dashboard\/rules<\/code>/);
  assert.match(text, /<code>opened the dashboard<\/code>/);
  assert.doesNotMatch(text, /marketing consent/, 'what was done, never what was typed');
  assert.doesNotMatch(text, /Signed in as Usher's admin/, 'the owner\'s own sign-in has no banner');
});

test('purge: the admin types the origin, and every record of that site goes; other sites keep theirs', async () => {
  const r = running.registry;
  const storage = r.storage;
  const gone = 'http://purge-me.localhost:4190';
  const other = claimed.origin;
  const map = (origin: string) => ({ ...(JSON.parse(readFileSync(new URL('../../../spec/examples/quote-driver.map.json', import.meta.url), 'utf8')) as UsherMap), origin });
  const policy = JSON.parse(readFileSync(new URL('../../../spec/examples/policy/quote.policy.json', import.meta.url), 'utf8')) as UsherPolicy;
  for (const origin of [gone, other]) {
    await r.addMap(map(origin));
    await storage.putSession({ id: `s_${origin === gone ? 'gone' : 'other'}0123456789`, origin, agent: 'a'.repeat(43), intent: 'quote.car_insurance', created_at: new Date().toISOString(), events: [{ ts: new Date().toISOString(), source: 'agent', action: 'knock' }] });
    await storage.appendLog('matches', { origin, score: 1 });
    await storage.putCached('site-app', origin, { enabled: true });
  }
  await registerSite(running, gone);
  await storage.putPolicy({ policy: { ...policy, origin: gone }, confirmed_at: new Date().toISOString() });
  await storage.putDraft({ id: 'r_purge01', origin: gone, text: 'Be careful.', policy: { ...policy, origin: gone }, summary: '', model: 'muse-spark-1.3', created_at: new Date().toISOString(), status: 'pending' });
  // Records that name the site without being keyed by it, and the shared lists it's in.
  await storage.appendLog('interest', { site: gone, at: new Date().toISOString() });
  await storage.putCached('viewer-labels', 'sha256:abc', { map: { origin: gone } });
  await r.setListed(gone, { name: 'Purge Me', journeys: [] });
  await r.setListed(other, { name: 'Keep Me', journeys: [] });
  await storage.putCached('plan-asks', `${gone}|`, { origin: gone, intent: null, asks: 1, last: '' });
  await storage.putCached('plan-asks', 'index', [`${gone}|`, `${other}|`]);

  const purge = (form: Record<string, string>) => fetch(`${running.url}/admin/sites/purge`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}` }, body: new URLSearchParams(form) });
  assert.equal((await fetch(`${running.url}/admin/sites/purge`, { method: 'POST', body: new URLSearchParams({ origin: gone, confirm: gone }) })).status, 401, 'the admin only');
  assert.equal((await purge({ origin: gone, confirm: 'http://purge-me.localhost' })).status, 422, 'the origin typed exactly');
  assert.ok((await storage.mapsForOrigin(gone)).length);
  const done = await purge({ origin: gone, confirm: gone });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Purged http:\/\/purge-me\.localhost:4190: \d+ records deleted/);

  assert.deepEqual(await storage.mapsForOrigin(gone), []);
  assert.equal(await storage.getSite(gone), undefined);
  assert.equal(await storage.getPolicy(gone), undefined);
  assert.deepEqual(await storage.listDrafts(gone), []);
  assert.deepEqual(await storage.listSessions(gone), []);
  assert.equal(await storage.getSession('s_gone0123456789'), undefined);
  for (const name of ['matches', 'interest'] as const) assert.ok(!JSON.stringify(await storage.readLog(name)).includes(gone), name);
  assert.equal(await storage.getCached('site-app', gone), undefined);
  assert.equal(await storage.getCached('viewer-labels', 'sha256:abc'), undefined);
  assert.equal(await storage.getCached('plan-asks', `${gone}|`), undefined);
  assert.deepEqual(await storage.getCached('plan-asks', 'index'), [`${other}|`]);
  assert.deepEqual((await r.listedSites()).map((l) => l.origin), [other]);
  if (!process.env.DATABASE_URL) assert.ok(!(await everything(dir)).includes(gone), 'not a byte of it on disk');

  // The other site keeps everything.
  assert.equal((await storage.mapsForOrigin(other)).length, 1);
  assert.equal((await storage.listSessions(other)).length, 1);
  assert.ok(JSON.stringify(await storage.readLog('matches')).includes(other));
  assert.deepEqual(await storage.getCached('site-app', other), { enabled: true });
  assert.ok(await storage.getSite(other));
});

/** Every file under a directory, as text. */
async function everything(path: string): Promise<string> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  const parts = await Promise.all(entries.map((e) => (e.isDirectory() ? everything(join(path, e.name)) : readFile(join(path, e.name), 'utf8').then((t) => `${e.name}\n${t}`))));
  return parts.join('\n');
}
