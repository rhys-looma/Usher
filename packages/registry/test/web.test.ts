import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { fingerprint, generateAgentIdentity, scanScript, type Scan } from '@usher/core';
import { readFixture, replayAny, type LabelFixture } from '../../core/test/replay.ts';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { RegistryClient, Viewer, seed, startRegistry, type RunningRegistry } from '../src/index.ts';
import { registerSite, type SiteKeys } from './sites.ts';
import { testStorage } from './storage-helper.ts';

const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
const labels = await Promise.all((['driver', 'vehicle', 'cover'] as const).map((s) => readFixture('a', s)));
const rules = await Promise.all([1, 2, 3].map(async (i) => JSON.parse(await readFile(new URL(`./fixtures/rules/${i}.json`, import.meta.url), 'utf8')) as LabelFixture & { text: string }));

let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let plainSite: MockSite;
let keys: SiteKeys;
let browser: Browser;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-web-'));
  registry = await startRegistry({ storage: await testStorage(dir), siteScript, chat: replayAny([...labels, ...rules]), model: 'muse-spark-1.3', web: { allowPrivate: true, viewer: 'open' } });
  site = await startMockSite({
    registry: registry.url,
    register: async (origin) => {
      keys = await registerSite(registry, origin);
      return keys.site_key;
    },
  });
  // The same site without Usher, as the recorded labels saw it.
  plainSite = await startMockSite();
  await seed(registry.registry, 'mock-site', site.url);
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await Promise.all([site.stop(), plainSite.stop()]);
  await registry.close();
  await rm(dir, { recursive: true });
});

const viewer = async (url: string) => {
  const res = await fetch(`${registry.url}/viewer`, { method: 'POST', body: new URLSearchParams({ url }) });
  return { status: res.status, text: await res.text() };
};

test('home and viewer pages render', async () => {
  const home = await fetch(`${registry.url}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<h2>What happens in between<\/h2>.*Knock<\/h3>.*Map, not values<\/h3>.*On the record<\/h3>/s);
  assert.match(await (await fetch(`${registry.url}/viewer`)).text(), /Build the map/);
});

test('map viewer: a real form becomes a readable map, then comes from the cache', async () => {
  const first = await viewer(`${plainSite.url}/quote/driver`);
  assert.equal(first.status, 200, first.text.slice(0, 300));
  for (const part of ['nsurance quote: driver details', 'person.dob', 'person.claims.has_any', 'risk-safe', 'when <code>person.claims.has_any</code> equals <code>yes</code>', 'nav.next', 'sha256:13c445c2', 'compiled by muse-spark-1.3', '173 options']) {
    assert.ok(first.text.includes(part), part);
  }
  const second = await viewer(`${plainSite.url}/quote/driver`);
  assert.match(second.text, /from cache/);
});

test('map viewer: junk and failures say why', async () => {
  const cases: [string, number, RegExp][] = [
    ['not a url at all !!', 422, /not a web address|could not be opened|could not be found/],
    ['http://localhost:1/', 422, /could not be opened/],
    [`${registry.url}/spec/`, 422, /No form with visible fields/],
    [`${plainSite.url}/nowhere`, 422, /HTTP 404/],
  ];
  for (const [url, status, reason] of cases) {
    const r = await viewer(url);
    assert.equal(r.status, status, url);
    assert.match(r.text, reason, url);
    assert.match(r.text, /class="card error"/);
  }
  const publicOnly = new Viewer({ storage: registry.registry.storage });
  const r = await publicOnly.compile('http://localhost:4100/quote/driver', 'test');
  assert.deepEqual([r.ok, !r.ok && r.reason], [false, 'private_address']);
});

async function signIn(as: SiteKeys = keys): Promise<string> {
  const res = await fetch(`${registry.url}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: as.origin, secret: as.secret_key }) });
  assert.equal(res.status, 303);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

const dash = async (path: string, cookie: string, form?: Record<string, string>) => {
  const res = await fetch(`${registry.url}${path}`, { headers: { Cookie: cookie }, ...(form && { method: 'POST', body: new URLSearchParams(form) }) });
  return { status: res.status, text: await res.text() };
};

test('dashboard: sign in with the secret key; nothing without it', async () => {
  const anonymous = await fetch(`${registry.url}/dashboard`);
  assert.match(await anonymous.text(), /Sign in/);
  const wrong = await fetch(`${registry.url}/dashboard/login`, { method: 'POST', body: new URLSearchParams({ origin: site.url, secret: keys.site_key }) });
  assert.equal(wrong.status, 401, 'the public site key does not sign in');
  const cookie = await signIn();
  assert.match(cookie, /^usher_site=/);
  const tampered = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.match((await dash('/dashboard', tampered)).text, /Sign in/);
});

test('dashboard: a rule in English becomes policy, then applies on confirm', async () => {
  // The site the rules were recorded for.
  await seed(registry.registry, 'mock-site', 'http://localhost:4100');
  const cookie = await signIn(await registerSite(registry, 'http://localhost:4100'));
  const proposed = await dash('/dashboard/rules', cookie, { text: rules[0]!.text });
  assert.equal(proposed.status, 200, proposed.text.slice(0, 400));
  assert.match(proposed.text, /Proposed\. Check the policy below/);
  assert.match(proposed.text, /Confirm and apply/);
  const id = /\/dashboard\/rules\/(r_[A-Za-z0-9_-]+)\/confirm/.exec(proposed.text)![1]!;
  const applied = await dash(`/dashboard/rules/${id}/confirm`, cookie, {});
  assert.match(applied.text, /Rules applied/);
  assert.match(applied.text, /Your rules:<\/b> “Agents can fill in quotes, but a human confirms the submit\. Max five an hour\.”/);
  assert.match(applied.text, /at most 5 <code>form\.submit<\/code> per agent per hour/);
});

test('dashboard: agent sessions as timelines, blocked attempts from registry and site, drift', async () => {
  // A blocked unknocked attempt at the site's API, reported by its server check.
  const unknocked = await fetch(`${site.url}/api/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Usher-Agent': 'curious-bot' }, body: '{}' });
  assert.equal(unknocked.status, 403);
  // An agent session, and a refusal by the registry (a forbidden action).
  const agent = new RegistryClient(registry.url, (await generateAgentIdentity()).identity);
  const page = await browser.newPage();
  await page.goto(`${site.url}/quote/driver`);
  await page.evaluate(() => (window as unknown as { usher: { ready: Promise<void> } }).usher.ready);
  const scan: Scan = await page.evaluate(scanScript());
  const knock = await agent.knock({ url: page.url(), fingerprint: await fingerprint(scan.forms[0]!.elements) });
  await page.evaluate((t) => (window as unknown as { usher: { bind(t: string): Promise<unknown> } }).usher.bind(t), knock.token);
  await page.getByLabel('First name').fill('Sam');
  await page.waitForTimeout(150);
  await page.close();
  await assert.rejects(() => agent.knock({ url: `${site.url}/quote/cover`, intent: 'quote.car_insurance', confirmed: ['consent.declaration'] }));
  // Drift: layout B, seen by the site script.
  await site.setLayout('b');
  const b = await browser.newPage();
  await b.goto(`${site.url}/quote/cover`);
  await b.evaluate(() => (window as unknown as { usher: { ready: Promise<void> } }).usher.ready);
  await b.waitForTimeout(150);
  await b.close();
  await site.setLayout('a');
  await new Promise((r) => setTimeout(r, 150));

  const cookie = await signIn();
  const overview = (await dash('/dashboard', cookie)).text;
  assert.match(overview, /no knock: no token/);
  assert.match(overview, /curious-bot/);
  assert.match(overview, /forbidden by your rules/);
  assert.match(overview, /your server/);
  assert.match(overview, /<td class="small">Usher<\/td>/, 'refused by Usher, not the site');
  assert.match(overview, /drifted/);
  assert.match(overview, /<code>\/quote\/cover<\/code>/);
  assert.match(overview, /verified identity<\/span> <span class="small muted">Web Bot Auth · key in the knock/);

  const timeline = await dash(`/dashboard/sessions/${knock.session}`, cookie);
  assert.equal(timeline.status, 200);
  assert.match(timeline.text, /<b>knock<\/b>/);
  assert.match(timeline.text, /verified identity/);
  assert.match(timeline.text, /<b>fill<\/b> <code>person\.first_name<\/code>/);
  assert.ok(!timeline.text.includes('>Sam<'), 'no values');
});

test('dashboard: only the signed-in site\'s own data', async () => {
  const other = await registerSite(registry, 'http://localhost:4111');
  const res = await fetch(`${registry.url}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: other.origin, secret: other.secret_key }) });
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const sessions = await registry.registry.storage.listSessions(site.url);
  assert.ok(sessions.length > 0);
  assert.equal((await dash(`/dashboard/sessions/${sessions[0]!.id}`, cookie)).status, 404);
  const overview = (await dash('/dashboard', cookie)).text;
  assert.ok(!overview.includes(site.url) && !overview.includes('curious-bot'));
});

test('live: the map viewer on a real public form', { skip: process.env.USHER_LIVE !== '1' && 'set USHER_LIVE=1 to load a public page and call the model API' }, async () => {
  const { loadDotEnv } = await import('../../core/src/compile/env.ts');
  const { compilerModel, modelApi } = await import('@usher/core');
  loadDotEnv();
  const viewerOnly = new Viewer({ storage: registry.registry.storage, chat: modelApi(), model: compilerModel() });
  try {
    const result = await viewerOnly.compile('https://httpbin.org/forms/post', 'live-test');
    assert.ok(result.ok, JSON.stringify(result));
    console.log(`  httpbin.org/forms/post: ${result.map.form.purpose} · ${result.map.fields.map((f) => `${f.key}(${f.risk})`).join(', ')} · ${result.map.actions.map((a) => `${a.key}(${a.risk})`).join(', ')} · ${result.ms} ms`);
  } finally {
    await viewerOnly.close();
  }
});
