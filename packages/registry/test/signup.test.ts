// Self-serve signup (LU-54), scripted through a real browser against the mock site: keys shown once
// and downloadable, the tag, a claim check that fails and says why and then passes, the dashboard
// signed in, and "lost your secret key?". Every sentence a site owner sees is checked for jargon.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { seed, startRegistry, type RunningRegistry } from '../src/index.ts';
import { testStorage } from './storage-helper.ts';

const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
// Words for the protocol's insides, not for site owners.
const JARGON = /\b(registry|registries|fingerprints?|jwks?|digests?)\b/i;

let dir: string;
let registry: RunningRegistry;
let site: MockSite | undefined;
let browser: Browser;
const seen = new Map<string, string>();

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-signup-'));
  // The mock site is on a local address: claims are checked against it for real, with private addresses allowed.
  registry = await startRegistry({ storage: await testStorage(dir), siteScript, web: {}, claims: { allowPrivate: true } });
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await site?.stop();
  await registry.close();
  await rm(dir, { recursive: true });
});

/** Records the sentences a site owner reads on this page (not code to copy), for the jargon check. */
async function look(page: Page, name: string): Promise<string> {
  const text = await page.locator('body').innerText();
  seen.set(name, await page.evaluate(() => {
    const copy = document.body.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('pre, code').forEach((n) => n.remove());
    return copy.innerText ?? copy.textContent ?? '';
  }));
  return text;
}

test('signup: keys once, the tag, a claim that fails and says why, then passes, and the dashboard signed in', async () => {
  const page = await browser.newPage({ acceptDownloads: true });
  let secret = '';
  let siteKey = '';
  // The mock site starts with the site key from step 1, and serves its claim file with it.
  site = await startMockSite({
    registry: registry.url,
    register: async (origin) => {
      await page.goto(`${registry.url}/sites/new`);
      await look(page, 'start');
      await page.getByLabel("Your site's address").fill(`${origin}/quote/driver`);
      await page.getByRole('button', { name: 'Get my keys' }).click();
      const keys = await look(page, 'keys');
      assert.match(keys, /Save your secret key now\. It is not shown again\./);
      assert.match(keys, new RegExp(`For ${origin.replace(/[.:/]/g, '\\$&')}\\.`), 'the address, without the path');
      siteKey = /usp_[\w-]+/.exec(keys)![0];
      secret = /uss_[\w-]+/.exec(keys)![0];
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download both keys' }).click()]);
      const file = await readFile((await download.path())!, 'utf8');
      assert.ok(file.includes(siteKey) && file.includes(secret), 'the download holds both keys');
      assert.equal(download.suggestedFilename(), 'usher-keys.txt');

      await page.getByRole('link', { name: 'Next: the tag' }).click();
      const tag = await look(page, 'tag');
      assert.ok(tag.includes(`data-usher-site-key="${siteKey}"`) && tag.includes(`data-usher-registry="${registry.url}"`), 'the tag, filled in');
      assert.match(tag, /never tracks people and never sees what anyone types/);

      await page.getByRole('link', { name: "Next: prove it's yours" }).click();
      const claim = await look(page, 'claim');
      assert.ok(claim.includes(`"site_key": "${siteKey}"`), 'the file, ready to copy');
      assert.ok(claim.includes(`usher-site=${siteKey}`), 'or the DNS record');
      // The site isn't serving its file yet: the check says what it found.
      await page.getByRole('button', { name: 'Check now' }).click();
      const failed = await look(page, 'claim failed');
      assert.match(failed, /Not yet\./);
      assert.match(failed, /We couldn't reach .*\/\.well-known\/usher-site\.json|There's no file at/);
      assert.match(failed, /no TXT record/i);
      return siteKey;
    },
  });

  await page.getByRole('button', { name: 'Check now' }).click();
  assert.equal(new URL(page.url()).pathname, '/dashboard', 'the dashboard opens, signed in');
  assert.match(await look(page, 'dashboard'), /You're set up\./);
  assert.equal((await registry.registry.storage.getSite(site.url))?.claim?.method, 'well-known');

  // With maps, as once agents have used the forms: the forms table and a map, as the owner sees them.
  await seed(registry.registry, 'mock-site', site.url);
  await page.goto(`${registry.url}/dashboard`);
  await look(page, 'dashboard with maps');
  await page.getByRole('link', { name: 'view map' }).first().click();
  assert.match(await look(page, 'map'), /Download the map file/);

  // Signing in later works with the secret key from step 1.
  const fresh = await browser.newPage();
  await fresh.goto(`${registry.url}/dashboard`);
  await look(fresh, 'sign in');
  await fresh.getByLabel('Site origin').fill(site.url);
  await fresh.getByLabel('Secret key').fill(secret);
  await fresh.getByRole('button', { name: 'Sign in' }).click();
  assert.match(await fresh.locator('body').innerText(), /Sign out/);
  await fresh.close();
  await page.close();
});

test('lost your secret key: a new one only after a fresh claim check; the old one stops working', async () => {
  const page = await browser.newPage();
  await page.goto(`${registry.url}/sites/lost`);
  await look(page, 'lost');
  await page.getByLabel("Your site's address").fill(site!.url);
  await page.getByRole('button', { name: 'Check and give me a new key' }).click();
  const keys = await look(page, 'new key');
  assert.match(keys, /Your old secret key no longer works\./);
  const secret = /uss_[\w-]+/.exec(keys)![0];
  const login = (s: string) => fetch(`${registry.url}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: site!.url, secret: s }) });
  assert.equal((await login(secret)).status, 303);

  // A site that can't show it's theirs gets an explanation, not a key.
  await registry.registry.registerSite({ origin: 'http://127.0.0.1:9' });
  await page.goto(`${registry.url}/sites/lost`);
  await page.getByLabel("Your site's address").fill('http://127.0.0.1:9');
  await page.getByRole('button', { name: 'Check and give me a new key' }).click();
  const refused = await look(page, 'lost refused');
  assert.match(refused, /We couldn't confirm the site is yours\./);
  assert.doesNotMatch(refused, /uss_/);
  await page.close();
});

test('before the claim passes, the dashboard shows what is missing rather than a bare refusal', async () => {
  const reply = await registry.registry.registerSite({ origin: 'https://not-yet.example' });
  const { secret_key } = reply.body as { secret_key: string };
  const res = await fetch(`${registry.url}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: 'https://not-yet.example', secret: secret_key }) });
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const page = await browser.newPage({ extraHTTPHeaders: { cookie } });
  const response = await page.goto(`${registry.url}/dashboard`);
  assert.equal(response?.status(), 200);
  const text = await look(page, 'dashboard, unclaimed');
  assert.match(text, /Almost there: prove https:\/\/not-yet\.example is yours/);
  assert.match(text, /Still to do/);
  await page.close();
});

test('every sentence a site owner sees is free of the protocol\'s jargon', () => {
  assert.ok(seen.size >= 10, `pages seen: ${[...seen.keys()].join(', ')}`);
  for (const [name, text] of seen) {
    const hit = text.split('\n').find((line) => JARGON.test(line));
    assert.equal(hit, undefined, `"${name}" says: ${hit}`);
  }
});
