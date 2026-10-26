import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { scanScript, pickForm, validateLabels, type ChatFn, type Scan, type UsherMap } from '@usher/core';
import { readFixture, replayAny, type LabelFixture } from '../../core/test/replay.ts';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { carryLabels, robotsAllows, seed, seedMaps, startRegistry, type KeeperCheck, type RunningRegistry } from '../src/index.ts';
import { registerSite, type SiteKeys } from './sites.ts';
import { testStorage } from './storage-helper.ts';

const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
const labels = await Promise.all((['a', 'b'] as const).flatMap((l) => (['driver', 'vehicle', 'cover'] as const).map((s) => readFixture(l, s))));
const triage = JSON.parse(await readFile(new URL('./fixtures/triage/driver-a-b.json', import.meta.url), 'utf8')) as LabelFixture;

let dir: string;
let running: RunningRegistry;
let site: MockSite;
let keys: SiteKeys;
let calls: string[] = [];
const counted = (name: string, chat: ChatFn): ChatFn => async (r) => (calls.push(name), chat(r));
let robots = '';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-keeper-'));
  running = await startRegistry({
    storage: await testStorage(dir),
    siteScript,
    web: { allowPrivate: true },
    keeper: {
      compiler: { chat: counted('spark', replayAny(labels)), model: 'muse-spark-1.3' },
      triage: { chat: counted('open', replayAny([triage])), model: triage.model },
      fetch: (async () => new Response(robots)) as typeof fetch,
    },
  });
  site = await startMockSite({ registry: running.url, register: async (o) => (keys = await registerSite(running, o)).site_key });
  await seed(running.registry, 'mock-site', site.url);
});
after(async () => {
  await site.stop();
  await running.close();
  await rm(dir, { recursive: true });
});

test('robots.txt: our agent, then *, longest rule wins', () => {
  const txt = 'User-agent: *\nDisallow: /private\nAllow: /private/form\n\nUser-agent: UsherKeeper\nDisallow: /quote/secret\n';
  assert.equal(robotsAllows(txt, '/quote/driver'), true);
  assert.equal(robotsAllows(txt, '/quote/secret'), false);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /private\nAllow: /private/form', '/private/form'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /', '/anything'), false);
  assert.equal(robotsAllows('', '/anything'), true);
});

test('cosmetic changes carry labels over by control and label; reworded ones do not', async () => {
  const [driver] = (await seedMaps('mock-site')) as [UsherMap];
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${site.url}/quote/driver`);
  const a: Scan = await page.evaluate(scanScript());
  await site.setLayout('b');
  await page.reload();
  const b: Scan = await page.evaluate(scanScript());
  await site.setLayout('a');
  await browser.close();
  const same = carryLabels(driver, pickForm(a));
  assert.ok(same);
  assert.ok(validateLabels(same, pickForm(a).elements).ok);
  assert.equal(carryLabels(driver, pickForm(b)), null, 'Surname is not Last name: needs the model');
});

test('keeper: an unchanged form costs nothing; a form behind earlier steps is left to agents; robots.txt is obeyed', async () => {
  calls = [];
  const unchanged = await running.keeper!.check(site.url, '/quote/driver');
  assert.equal(unchanged.outcome, 'unchanged');
  assert.deepEqual(calls, []);
  assert.equal((await running.keeper!.check(site.url, '/quote/vehicle')).outcome, 'unreachable');
  robots = 'User-agent: *\nDisallow: /quote/';
  assert.equal((await running.keeper!.check(site.url, '/quote/driver')).outcome, 'robots');
  robots = '';
  // It identified itself: a knock as its own agent, in the site's log.
  const sessions = await running.registry.storage.listSessions(site.url);
  assert.ok(sessions.some((s) => s.intent === 'registry.keeper'));
});

test('keeper: layout B is triaged by Spark Open, recompiled by Muse Spark, and becomes current', async () => {
  calls = [];
  await site.setLayout('b');
  try {
    const result: KeeperCheck = await running.keeper!.check(site.url, '/quote/driver');
    assert.equal(result.outcome, 'rebuilt', result.detail);
    assert.deepEqual(calls, ['open', 'spark'], 'triage first, then the recompile');
    assert.equal(result.review, false, 'nothing consequential changed');
    assert.match(result.detail, /reword/i);
    const current = (await running.registry.storage.mapsForOrigin(site.url)).filter((r) => r.map.path === '/quote/driver').sort((x, y) => y.added_at.localeCompare(x.added_at));
    assert.equal(current[0]!.digest, result.to);
    assert.equal(current[0]!.map.actions.find((a) => a.key === 'nav.next')!.leads_to, '/quote/vehicle', 'the edge is kept');
    assert.deepEqual(current[1]!.replaced?.by, result.to, 'the old version is kept, marked replaced');
    const lookup = await (await fetch(`${running.url}/maps/current?origin=${encodeURIComponent(site.url)}&path=/quote/driver`)).json();
    assert.equal(lookup.digest, result.to);

    const login = await fetch(`${running.url}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: site.url, secret: keys.secret_key }) });
    const page = await (await fetch(`${running.url}/dashboard`, { headers: { Cookie: login.headers.get('set-cookie')!.split(';')[0]! } })).text();
    assert.match(page, /rebuilt at/);
    assert.match(page, /2 versions/);
  } finally {
    await site.setLayout('a');
  }
});

test('a drift report from a person\'s page load triggers the keeper', async () => {
  // Back to layout A: the current map is B's, so A's page is now the change.
  calls = [];
  const since = new Date().toISOString();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${site.url}/quote/driver`);
  await page.evaluate(() => (window as unknown as { usher: { ready: Promise<void> } }).usher.ready);
  await browser.close();
  let check: KeeperCheck | undefined;
  for (let i = 0; i < 100 && !(check && check.checked_at > since && check.outcome === 'restored'); i++) {
    await new Promise((r) => setTimeout(r, 100));
    check = await running.registry.storage.getCached<KeeperCheck>('keeper-check', `${site.url}|/quote/driver`);
  }
  assert.equal(check?.outcome, 'restored');
  assert.deepEqual(calls, [], 'an earlier version is restored without any model');
  const current = (await running.registry.storage.mapsForOrigin(site.url)).filter((r) => r.map.path === '/quote/driver').sort((x, y) => y.added_at.localeCompare(x.added_at))[0]!;
  assert.equal(current.digest, (await seedMaps('mock-site'))[0]!.fingerprint.digest, 'A\'s map is current again, clean');
  assert.equal(current.drift, undefined);
  assert.equal(current.replaced, undefined);
});
