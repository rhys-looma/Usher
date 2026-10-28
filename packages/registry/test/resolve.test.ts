// A site and a task in a person's words, to a journey: the site by display name (from its own home
// page, with or without "Motor"), host or any URL on it; the task by words in common with each
// journey's intent and title; more than one plausible journey comes back as choices, never a guess;
// a site that hasn't joined gets the same answer as hosted Usher gives today.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { seed, seedMaps, siteNameFrom, startRegistry, type RunningRegistry } from '../src/index.ts';
import { registerSite } from './sites.ts';
import { testStorage } from './storage-helper.ts';

let dir: string;
let registry: RunningRegistry;
let site: MockSite;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-resolve-'));
  registry = await startRegistry({ storage: await testStorage(dir), claims: { allowPrivate: true } });
  site = await startMockSite({ registry: registry.url, register: async (o) => (await registerSite(registry, o)).site_key });
  await seed(registry.registry, 'mock-site', site.url);
});
after(async () => {
  await registry.close();
  await site.stop();
  await rm(dir, { recursive: true });
});

const resolve = (s: string, t?: string) => registry.registry.resolveTask(s, t);

test('a site\'s name comes from its own home page', async () => {
  assert.equal(siteNameFrom('<title>Get a quote | Brightwater Motor</title>'), 'Brightwater Motor');
  assert.equal(siteNameFrom('<meta property="og:site_name" content="Acme Insurance"><title>Home - Acme</title>'), 'Acme Insurance');
  assert.equal(siteNameFrom('<meta content="Shop" name="application-name">'), 'Shop');
  assert.equal(siteNameFrom('<p>nothing</p>'), null);
  assert.equal(await registry.registry.siteName(site.url), 'Brightwater Motor');
  const [joined] = await registry.registry.joinedSites();
  assert.deepEqual([joined!.name, joined!.journeys.map((j) => [j.start, j.intent, j.label])], ['Brightwater Motor', [['/quote/driver', 'quote.car_insurance', 'car insurance quote']]]);
});

test('by name (with or without Motor, any case), host or a URL on the site', async () => {
  const want = { status: 'resolved', url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', site: { name: 'Brightwater Motor', origin: site.url } };
  for (const said of ['Brightwater', 'brightwater motor', 'BRIGHTWATER MOTOR', new URL(site.url).host, `${site.url}/quote/cover`, site.url]) assert.deepEqual(await resolve(said, 'car insurance quote'), want, said);
  assert.deepEqual(await resolve('Brightwater'), want, 'one journey: no task needed');
  assert.deepEqual(await resolve('Brightwater', 'get me a quote for my car'), want);
});

test('a site that hasn\'t joined: the answer hosted Usher gives today, pointing at the local server', async () => {
  const byName = await resolve('Acme Insurance', 'car insurance quote');
  assert.equal(byName.status, 'not_joined');
  assert.match((byName as { message: string }).message, /"Acme Insurance" isn't one of the sites that have joined \(Brightwater Motor/);
  assert.match((byName as { message: string }).message, /npx -y @usher-run\/mcp/);
  const byUrl = await resolve('https://quotes.example.org/car', 'car insurance quote');
  assert.equal(byUrl.status, 'not_joined');
  assert.match((byUrl as { message: string }).message, /Hosted Usher only acts where a site has said yes: https:\/\/quotes\.example\.org hasn't joined Usher/);
});

test('two plausible journeys: the choices, never a guess; a task that says which picks it', async () => {
  // A second journey on the same site: home insurance.
  const [driver] = await seedMaps('mock-site');
  const home = { ...driver!, origin: site.url, path: '/home/start', form: { ...driver!.form, intent: 'quote.home_insurance', purpose: 'Home insurance quote: about you' }, fingerprint: { ...driver!.fingerprint, digest: `sha256:${'1'.repeat(64)}` }, actions: driver!.actions.map((a) => ({ ...a, leads_to: undefined })) };
  await registry.registry.storage.putMap({ digest: home.fingerprint.digest, map: home as never, added_at: new Date().toISOString() });
  const either = await resolve('Brightwater', 'insurance quote');
  assert.equal(either.status, 'needs_details');
  assert.deepEqual((either as { choices: { task: string }[] }).choices.map((c) => c.task).sort(), ['car insurance quote', 'home insurance quote']);
  assert.equal((await resolve('Brightwater')).status, 'needs_details', 'two journeys and no task');
  const car = await resolve('Brightwater', 'car insurance quote');
  assert.equal((car as { intent: string }).intent, 'quote.car_insurance');
  const homeQuote = await resolve('Brightwater', 'home insurance');
  assert.equal((homeQuote as { url: string }).url, `${site.url}/home/start`);
  const nothing = await resolve('Brightwater', 'book a flight');
  assert.equal(nothing.status, 'needs_details');
  assert.match((nothing as { message: string }).message, /Nothing on Brightwater Motor matches "book a flight"\. It offers: /);
});
