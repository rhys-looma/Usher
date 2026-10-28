import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { fingerprint, generateAgentIdentity, scanScript, type Scan } from '@usher/core';
import { RegistryClient, seed, startRegistry, type KnockResponse, type RunningRegistry, type Session } from '@usher/registry';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { registerSite, type SiteKeys } from '../../registry/test/sites.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';

const siteScript = fileURLToPath(new URL('../dist/usher.js', import.meta.url));
let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let browser: Browser;
let client: RegistryClient;
let keys: SiteKeys;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-site-script-'));
  registry = await startRegistry({ storage: await testStorage(dir), siteScript });
  site = await startMockSite({
    registry: registry.url,
    register: async (origin) => {
      keys = await registerSite(registry, origin);
      return keys.site_key;
    },
  });
  await seed(registry.registry, 'mock-site', site.url);
  browser = await chromium.launch();
  client = new RegistryClient(registry.url, (await generateAgentIdentity()).identity);
});
after(async () => {
  await browser.close();
  await site.stop();
  await registry.close();
  await rm(dir, { recursive: true });
});

const answers = {
  driver: { title: 'mr', first_name: 'Sam', last_name: 'Taylor', dob: '1988-04-02', email: 'sam@example.com', postcode: 'WR14 1AA', address_line1: '1 High Street', occupation: 'teacher', employment_status: 'employed', has_claims: 'no' },
  vehicle: { registration: 'AB12CDE', make: 'Ford', model: 'Fiesta', year: '2018', annual_mileage: '8000', use: 'social-and-commuting', overnight: 'driveway', modified: 'no' },
};

/** A fresh page on a step, with the earlier steps submitted as a person would (no token). */
async function open(step: 'driver' | 'vehicle' | 'cover'): Promise<Page> {
  const context = await browser.newContext();
  for (const earlier of (['driver', 'vehicle'] as const).slice(0, ['driver', 'vehicle', 'cover'].indexOf(step))) {
    await context.request.post(`${site.url}/quote/${earlier}`, { form: answers[earlier] });
  }
  const page = await context.newPage();
  await page.goto(`${site.url}/quote/${step}`);
  await page.evaluate(() => window.usher.ready);
  return page;
}

async function knockFor(page: Page, confirmed?: string[]): Promise<KnockResponse> {
  const scan: Scan = await page.evaluate(scanScript());
  const fp = await fingerprint(scan.forms[0]!.elements);
  return client.knock({ url: page.url(), fingerprint: fp, ...(confirmed && { confirmed }) });
}

const getSession = async (sid: string): Promise<Session> =>
  (await fetch(`${registry.url}/sessions/${sid}`, { headers: { Authorization: `Bearer ${keys.secret_key}` } })).json() as Promise<Session>;

async function waitForEvents(sid: string, count: number): Promise<Session> {
  for (let i = 0; i < 50; i++) {
    const session = await getSession(sid);
    if (session.events.length >= count) return session;
    await new Promise((r) => setTimeout(r, 50));
  }
  return getSession(sid);
}

test('every form carries the knock notice and starts locked; nothing a person sees changes', async () => {
  const page = await open('driver');
  const form = page.locator('form[method="post"]');
  assert.equal(await form.getAttribute('data-usher-knock'), `${registry.url}/knock`);
  assert.equal(await form.getAttribute('data-usher-state'), 'locked');
  const note = page.getByRole('note');
  assert.ok(((await note.textContent()) ?? '').includes(`knock at ${registry.url}/knock`));
  const box = await note.boundingBox();
  assert.ok(box && box.width <= 1 && box.height <= 1, 'visually hidden');
  const state = await page.evaluate(() => window.usher.state());
  assert.deepEqual([state.state, state.bound, state.drifted, state.match], ['locked', false, false, null]);
  await page.context().close();
});

test('people\'s page loads send nothing about them: one cached map check an hour, no lookups or drift beacons', async () => {
  const context = await browser.newContext();
  const calls: string[] = [];
  context.on('request', (r) => {
    if (r.url().startsWith(registry.url)) calls.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  const page = await context.newPage();
  for (let i = 0; i < 3; i++) {
    await page.goto(`${site.url}/quote/driver`);
    await page.evaluate(() => window.usher.ready);
  }
  assert.deepEqual(calls.filter((c) => !c.endsWith('/usher.js')), ['GET /maps/current'], 'checked once, then cached');
  await context.close();
});

test('page loads without a bound token are never logged', async () => {
  const page = await open('driver');
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith(registry.url)) calls.push(new URL(r.url()).pathname);
  });
  await page.getByLabel('First name').fill('Sam');
  await page.getByLabel('Title').selectOption('mr');
  await page.getByRole('group', { name: 'Have you made any claims in the last 5 years?' }).getByLabel('No').check();
  await page.waitForTimeout(200);
  assert.deepEqual(calls, []);
  await page.context().close();
  // Only knocks create sessions.
  assert.equal((await registry.registry.storage.listSessions(site.url)).length, 0);
});

test('bind: bad and foreign tokens are refused; a good one unlocks and logs by semantic key, never values', async () => {
  const page = await open('driver');
  assert.deepEqual(await page.evaluate(() => window.usher.bind('not-a-token')), { ok: false, error: 'malformed' });
  const foreign = await client.knock({ url: 'http://localhost:1/quote/driver', intent: 'quote.car_insurance' });
  assert.deepEqual(await page.evaluate((t) => window.usher.bind(t), foreign.token), { ok: false, error: 'wrong_origin' });

  const knock = await knockFor(page);
  assert.equal(knock.match.kind, 'exact');
  const bound = await page.evaluate((t) => window.usher.bind(t), knock.token);
  assert.deepEqual(bound, { ok: true, session: knock.session });
  assert.equal(await page.locator('form[method="post"]').getAttribute('data-usher-state'), 'unlocked');

  await page.getByLabel('First name').fill('Zqtypedname');
  await page.getByLabel('Title').selectOption('dr');
  await page.getByRole('group', { name: 'Have you made any claims in the last 5 years?' }).getByLabel('No').check();
  const session = await waitForEvents(knock.session, 4);
  assert.deepEqual(
    session.events.map((e) => [e.source, e.action, e.key ?? null]),
    [
      ['registry', 'knock', null],
      ['site', 'fill', 'person.first_name'],
      ['site', 'select', 'person.title'],
      ['site', 'choose', 'person.claims.has_any'],
    ],
  );
  const json = JSON.stringify(session);
  assert.ok(!json.includes('Zqtypedname') && !json.includes('"dr"'), 'no values in the log');
  await page.context().close();
});

test('postMessage binding works too', async () => {
  const page = await open('vehicle');
  const knock = await knockFor(page);
  const reply = await page.evaluate(
    (token) =>
      new Promise((resolve) => {
        window.addEventListener('message', (e) => e.data?.type === 'usher:bound' && resolve(e.data));
        window.postMessage({ type: 'usher:bind', token }, location.origin);
      }),
    knock.token,
  );
  assert.deepEqual(reply, { type: 'usher:bound', ok: true, session: knock.session });
  await page.context().close();
});

test('rules: the consequential submit is held until the agent confirms; the server accepts the bound token', async () => {
  const page = await open('cover');
  // The agent's user has confirmed the quote request, so the knock says so and the server accepts it.
  const knock = await knockFor(page, ['form.submit']);
  await page.evaluate((t) => window.usher.bind(t), knock.token);
  await page.getByLabel('Cover start date').fill('2026-11-15');
  await page.getByRole('group', { name: 'Level of cover' }).getByLabel('Comprehensive').check();
  await page.getByLabel('Voluntary excess').selectOption('250');
  await page.getByLabel('Years of no-claims discount').selectOption('5');
  await page.getByRole('group', { name: 'How would you like to pay?' }).getByLabel('Monthly').check();
  await page.evaluate(() => window.usher.handoff('consent.declaration'));
  await page.getByLabel('I confirm the information I have given is true and complete').check();

  await page.getByRole('button', { name: 'Get my quote' }).click();
  await page.waitForTimeout(200);
  assert.match(page.url(), /\/quote\/cover$/, 'held, not submitted');
  assert.equal((await page.evaluate(() => window.usher.state())).state, 'awaiting_confirmation');

  assert.equal(await page.evaluate(() => window.usher.confirm()), true);
  await Promise.all([page.waitForURL(/\/quote\/result$/), page.getByRole('button', { name: 'Get my quote' }).click()]);
  assert.match(await page.locator('.price').textContent() ?? '', /£/);

  const session = await waitForEvents(knock.session, 11);
  const actions = session.events.map((e) => `${e.action}${e.key ? ` ${e.key}` : ''}`);
  assert.deepEqual(actions.slice(-5), ['handoff consent.declaration', 'check consent.declaration', 'held form.submit', 'confirm form.submit', 'submit form.submit']);
  await page.context().close();
});

test('drift: in layout B the script compares locally, reports once per change, and the registry marks the maps', async () => {
  await site.setLayout('b');
  try {
    const drifted: Record<string, boolean> = {};
    for (const step of ['driver', 'vehicle', 'cover'] as const) {
      const page = await open(step);
      drifted[step] = (await page.evaluate(() => window.usher.state())).drifted;
      // A reload in the same browser does not report again.
      await page.reload();
      await page.evaluate(() => window.usher.ready);
      await page.waitForTimeout(100);
      await page.context().close();
    }
    const drift = (await registry.registry.storage.readLog('drift')) as { path: string; score: number }[];
    assert.deepEqual(drift.map((d) => d.path), ['/quote/driver', '/quote/vehicle', '/quote/cover']);
    // The car journey's maps, the pages opened here; the health journey's are untouched.
    for (const record of (await registry.registry.storage.mapsForOrigin(site.url)).filter((r) => r.map.path.startsWith('/quote/'))) assert.ok(record.drift, `${record.map.path} marked drifted`);
    const scores = Object.fromEntries(drift.map((d) => [d.path, d.score]));
    console.log(`drift (layout B vs seeded layout A): scores ${JSON.stringify(scores)}`);
    assert.deepEqual(drifted, { driver: true, vehicle: true, cover: true });
  } finally {
    await site.setLayout('a');
  }
});

test('a forbidden action stays blocked in the page, even after the agent confirms', async () => {
  await registry.registry.storage.putPolicy({
    policy: { usher_policy: '0.1', origin: site.url, default: {}, forms: [{ match: { path: '/quote/vehicle' }, actions: { 'nav.next': 'forbid' } }] },
    confirmed_at: new Date().toISOString(),
  });
  try {
    const page = await open('vehicle');
    const knock = await knockFor(page);
    assert.equal(knock.rules.actions['nav.next'], 'forbid');
    await page.evaluate((t) => window.usher.bind(t), knock.token);
    await page.evaluate(() => window.usher.confirm('nav.next'));
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForTimeout(200);
    assert.match(page.url(), /\/quote\/vehicle$/, 'not submitted');
    await page.context().close();
  } finally {
    await registry.registry.storage.putPolicy({ policy: { usher_policy: '0.1', origin: site.url, default: {} }, confirmed_at: new Date().toISOString() });
  }
});
