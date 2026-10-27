// Site-published maps: the site script writes the form's map into the page as
// <script type="application/usher+json" data-usher-map>, and the middleware points at it with a
// Link header. Unchanged, it is the registry's map; after a redesign (layout B) it is the live
// structure with each field keyed where it still matches, the rest unlabelled, and a drift report.
// The agent's side, running the quote on the page's maps alone, is in packages/agent/test/page-maps.test.ts.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { mapSchemaErrors, UNLABELLED, type UsherMap } from '@usher/core';
import { seed, startRegistry, type RunningRegistry } from '@usher/registry';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { registerSite, type SiteKeys } from '../../registry/test/sites.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';

const siteScript = fileURLToPath(new URL('../dist/usher.js', import.meta.url));
let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let browser: Browser;
let keys: SiteKeys;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-published-'));
  registry = await startRegistry({ storage: await testStorage(dir), siteScript });
  site = await startMockSite({ registry: registry.url, register: async (origin) => (keys = await registerSite(registry, origin)).site_key });
  await seed(registry.registry, 'mock-site', site.url);
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await site.stop();
  await registry.close();
  await rm(dir, { recursive: true });
});

const driver = { title: 'mr', first_name: 'Sam', last_name: 'Taylor', dob: '1988-04-02', email: 'sam@example.com', postcode: 'WR14 1AA', address_line1: '1 High Street', occupation: 'teacher', employment_status: 'employed', has_claims: 'no' };
const vehicle = { registration: 'AB12CDE', make: 'Ford', model: 'Fiesta', year: '2018', annual_mileage: '8000', use: 'social-and-commuting', overnight: 'driveway', modified: 'no' };

/** A fresh browser on a step (earlier steps posted as a person would), with the site script done. */
async function open(step: 'driver' | 'vehicle' | 'cover', layout: 'a' | 'b' = 'a'): Promise<Page> {
  const context = await browser.newContext();
  const earlier = { driver: [], vehicle: ['driver'], cover: ['driver', 'vehicle'] }[step] as ('driver' | 'vehicle')[];
  // Layout B names its fields differently; the server reads either, by canonical name.
  for (const s of earlier) await context.request.post(`${site.url}/quote/${s}`, { form: layout === 'a' ? { driver, vehicle }[s] : await layoutB(s, { driver, vehicle }[s]) });
  const page = await context.newPage();
  await page.goto(`${site.url}/quote/${step}`);
  await page.evaluate(() => window.usher.ready);
  return page;
}

/** Layout B's field names for a step, read off the page. */
async function layoutB(step: string, answers: Record<string, string>): Promise<Record<string, string>> {
  const html = await (await fetch(`${site.url}/quote/${step}`)).text();
  const names = [...html.matchAll(/name="(bw_[a-z_0-9]+)"/g)].map((m) => m[1]!);
  return Object.fromEntries(Object.entries(answers).map(([k, v]) => [names.find((n) => n.startsWith(`bw_${k}_`)) ?? k, v]));
}

const embedded = async (page: Page): Promise<UsherMap | null> => JSON.parse((await page.locator('script[type="application/usher+json"][data-usher-map]').textContent()) ?? 'null');
const publicMap = async (path: string): Promise<UsherMap> => ((await (await fetch(`${registry.url}/maps/public?origin=${encodeURIComponent(site.url)}&path=${encodeURIComponent(path)}`)).json()) as { map: UsherMap }).map;

test('each step publishes its map in the page: schema-valid, and the registry\'s map for it', async () => {
  for (const step of ['driver', 'vehicle', 'cover'] as const) {
    const page = await open(step);
    const map = await embedded(page);
    assert.equal(mapSchemaErrors(map), null, step);
    assert.deepEqual(map, await publicMap(`/quote/${step}`), `${step}: the registry's map`);
    assert.equal(await page.locator('script[data-usher-map]').getAttribute('data-usher-digest'), map!.fingerprint.digest);
    // Nothing anyone types: the map is structure, and the element isn't rendered.
    assert.equal(await page.locator('script[data-usher-map]').isVisible(), false);
    await page.context().close();
  }
});

test('the site\'s pages point at their map with a Link header', async () => {
  const res = await fetch(`${site.url}/quote/driver`);
  const link = /<([^>]+)>;\s*rel="usher-map"/.exec(res.headers.get('link') ?? '');
  assert.ok(link, res.headers.get('link') ?? 'no Link header');
  const body = (await (await fetch(link[1]!)).json()) as { map: UsherMap };
  assert.deepEqual(body.map, await publicMap('/quote/driver'));
});

test('layout B: the published map has the live structure, moved fields keyed in their new places, the rest unlabelled, and a drift report', async () => {
  const before = await publicMap('/quote/driver');
  // Layout A's field name for each key: layout B renames <name> to bw_<name>_<hash>.
  const nameOf = new Map(before.fields.map((f) => [f.key, f.locators.find((l) => l.by === 'name')?.value]));
  await site.setLayout('b');
  try {
    const page = await open('driver', 'b');
    const map = (await embedded(page))!;
    assert.equal(mapSchemaErrors(map), null);
    assert.notEqual(map.fingerprint.digest, before.fingerprint.digest, 'the live form, not the old map');
    assert.equal(map.provenance.source, 'site');
    // Layout B moves email and phone to the top: they're keyed there.
    assert.deepEqual(map.fields.slice(0, 2).map((f) => f.key), ['contact.email', 'contact.phone']);
    const keyed = map.fields.filter((f) => !UNLABELLED.test(f.key));
    for (const f of keyed) {
      // Each keyed field's own locators find the layout B input that was that key's in layout A.
      const name = await page.locator(`#${f.locators.find((l) => l.by === 'id')!.value}`).getAttribute('name').catch(() => null);
      const was = nameOf.get(f.key);
      if (name && was) assert.ok(name.startsWith(`bw_${was}_`), `${f.key}: ${name}`);
    }
    // Reworded beyond recognition: "Surname" and "House number and street" are left unlabelled.
    const unlabelled = map.fields.filter((f) => UNLABELLED.test(f.key));
    assert.deepEqual(unlabelled.map((f) => f.label).sort(), ['House number and street', 'Surname']);
    assert.ok(unlabelled.every((f) => f.risk === 'needs_user'));
    assert.ok(keyed.length >= 10, `${keyed.length} fields keyed`);
    assert.deepEqual((await page.evaluate(() => window.usher.state().published)), { digest: map.fingerprint.digest, exact: false, unlabelled: 2 });
    // And the drift report reached the registry.
    let drift: { path: string; live: string }[] = [];
    for (let i = 0; i < 40 && !drift.length; i++) {
      drift = ((await registry.registry.storage.readLog('drift')) as { path: string; live: string }[]).filter((d) => d.path === '/quote/driver' && d.live === map.fingerprint.digest);
      if (!drift.length) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(drift.length, 1, 'drift reported once');
    await page.context().close();
  } finally {
    await site.setLayout('a');
  }
});
