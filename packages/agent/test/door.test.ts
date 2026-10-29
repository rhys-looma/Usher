// The door holds on Brightwater: plain Playwright with no Usher (no knock, no token, no Usher-Agent,
// no signature) can't get a quote on either journey, and a consequential post without a valid token
// is refused 403 knock_required. A person still can.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { fillField, locate, type UsherMap } from '@usher/core';
import { startRegistry, type RunningRegistry } from '@usher/registry';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { registerSite } from '../../registry/test/sites.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';

const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
const seedDir = new URL('../../registry/seed/mock-site/', import.meta.url);
const profiles = new URL('../profiles/', import.meta.url);

let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let browser: Browser;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-door-'));
  registry = await startRegistry({ storage: await testStorage(join(dir, 'registry')), siteScript });
  site = await startMockSite({ registry: registry.url, register: async (origin) => (await registerSite(registry, origin)).site_key });
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await site.stop();
  await registry.close();
  await rm(dir, { recursive: true });
});

const read = async <T>(url: URL) => JSON.parse(await readFile(url, 'utf8')) as T;

/** Fills a journey by the seeded maps' locators and presses each way forward; the final page reached and its status. */
async function drive(context: BrowserContext, files: string[], profileFile: string): Promise<{ path: string; status: number }> {
  const maps = await Promise.all(files.map((f) => read<UsherMap>(new URL(`${f}.map.json`, seedDir))));
  const profile = await read<Record<string, string | boolean>>(new URL(profileFile, profiles));
  const page = await context.newPage();
  let status = 0;
  page.on('response', (r) => {
    if (!r.request().isNavigationRequest() || r.frame() !== page.mainFrame()) return;
    status = r.status();
  });
  await page.goto(`${site.url}${maps[0]!.path}`);
  await page.waitForFunction('window.usher !== undefined').catch(() => undefined);
  for (const map of maps) {
    if (new URL(page.url()).pathname !== map.path) break;
    for (const f of map.fields) if (profile[f.key] !== undefined && !f.shown_if) await fillField(page, f, profile[f.key]!).catch(() => undefined);
    const lookup = map.actions.find((a) => a.key === 'lookup.address' || a.key === 'lookup.vehicle');
    if (lookup) {
      await (await locate(page, lookup))?.click();
      await page.waitForTimeout(800);
      // The lookup's list of results, when it shows one: the first entry, as a person would pick.
      const list = page.locator('.lookup-results select').first();
      if (await list.count()) await list.selectOption({ index: 1 }).catch(() => undefined);
    }
    const forward = map.actions.find((a) => a.key === 'form.submit' || a.key === 'nav.next')!;
    await (await locate(page, forward))!.click();
    await page.waitForLoadState('load');
  }
  const path = new URL(page.url()).pathname;
  await page.close();
  return { path, status };
}

const HEALTH = ['4-health-about', '5-health-cover', '6-health-declaration'];
const CAR = ['1-driver', '2-vehicle', '3-cover'];

test('plain Playwright with no Usher gets no quote on either journey: the final step answers 403', async () => {
  const context = await browser.newContext();
  const health = await drive(context, HEALTH, 'test-health.json');
  assert.notEqual(health.path, '/health/result');
  assert.equal(health.status, 403, 'the quote request refused');
  const car = await drive(context, CAR, 'test-driver.json');
  assert.notEqual(car.path, '/quote/result');
  assert.equal(car.status, 403);
  await context.close();
});

test('a consequential post without a valid token is refused 403 knock_required', async () => {
  for (const path of ['/api/quote', '/api/health-quote']) {
    const res = await fetch(`${site.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403, path);
    assert.equal(((await res.json()) as { error: string }).error, 'knock_required');
  }
  const forged = await fetch(`${site.url}/api/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Usher not-a-token' }, body: '{}' });
  assert.equal(forged.status, 403);
});

test('a person still gets a quote: a browser that isn\'t automated, with an ordinary user agent', async () => {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' });
  // A string, not a function: nothing in it is rewritten before it reaches the page.
  await context.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => false })");
  const health = await drive(context, HEALTH, 'test-health.json');
  assert.equal(health.path, '/health/result', `stopped with ${health.status}`);
  await context.close();
});
