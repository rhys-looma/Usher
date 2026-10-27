// The front page (LU-53): the sentence and the three blocks, the viewer box, both quickstarts with
// this registry's address, the numbers, and the interest form, which carries Usher's own tag, is
// locked to agents that didn't knock, and is listed for the admin only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startRegistry, type RunningRegistry } from '../src/index.ts';
import { testStorage } from './storage-helper.ts';
import { pickerForms } from '../src/web/picker.ts';

const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
let dir: string;
let registry: RunningRegistry;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-landing-'));
  registry = await startRegistry({ storage: await testStorage(dir), siteScript, web: { adminKey: 'admin-test-key', viewer: 'open', forms: pickerForms() } });
});
after(async () => {
  await registry.close();
  await rm(dir, { recursive: true });
});

const post = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(`${registry.url}${path}`, { method: 'POST', body: new URLSearchParams(form), headers, redirect: 'manual' });

test('front page: the sentence, map / knock / log, the viewer box, both quickstarts, numbers, sharing tags', async () => {
  const res = await fetch(`${registry.url}/`);
  const text = await res.text();
  assert.equal(res.status, 200);
  // The sentence, its second half set in italic.
  const order = ['Usher is the front door for AI agents on web forms. <em>Agents knock, get in fast, and follow the house rules.</em>', '<p class="lede">More of the web, open to agents.</p>', '<h3>Map</h3>', '<h3>Knock</h3>', '<h3>Log</h3>', '<h2>Try it</h2>', '<p class="label">For sites</p><h2>The control layer for AI agents on your forms.</h2>', '<p class="lede">No integration required.</p>', '<b>No changes to your systems.</b>', '<b>You set the terms.</b>', '<b>Every agent action on the record.</b>', '<p class="label">For agents</p><h2>One call fills the form.</h2>', '<h2>Numbers</h2>', '<h2>I run a site with forms</h2>', 'Built by</small><a class="wordmark" href="https://looma.insure"'];
  const at = order.map((s) => text.indexOf(s));
  assert.ok(at.every((i) => i >= 0), `all present: ${order.filter((_, i) => at[i]! < 0).join(', ')}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in that order');
  assert.ok(text.includes('No signup. Your agent&#39;s key is its identity.') || text.includes("No signup. Your agent's key is its identity."));
  assert.ok(text.includes(`&quot;USHER_REGISTRY_URL&quot;: &quot;${registry.url}&quot;`), 'the MCP entry names this registry');
  assert.ok(text.includes(`data-usher-registry=&quot;${registry.url}&quot;`), 'the tag names this registry');
  assert.ok(text.includes('href="/sites/new"'), 'Get your keys');
  assert.match(text, /× faster/, 'the benchmark');
  assert.match(text, /given the right meaning, human-checked \(\d+ on public forms\)/, 'human-checked public forms only, never the mock site\'s answer key');
  assert.match(text, /<code>usher_fill<\/code> takes the form&#39;s values by meaning|<code>usher_fill<\/code> takes the form's values by meaning/);
  const description = 'Usher is the front door for AI agents on web forms: the control layer for sites, one call for agents, no integration required.';
  assert.ok(text.includes(`<meta name="description" content="${description}">`) && text.includes(`<meta property="og:description" content="${description}">`));
  assert.match(text, /<meta property="og:image" content="[^"]+\/og\.png">/);
  assert.match(text, /<title>Usher: the front door for AI agents on web forms<\/title>/);
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'; connect-src 'self'/, 'its own site script, nothing else');
  const og = await fetch(`${registry.url}/og.png`);
  assert.deepEqual([og.status, og.headers.get('content-type')], [200, 'image/png']);
});

test('front page: the interest form carries Usher\'s own tag, and the site claims its origin like any other', async () => {
  const own = await registry.registry.ownSite();
  const text = await (await fetch(`${registry.url}/`)).text();
  assert.ok(text.includes(`data-usher-site-key="${own.site_key}"`));
  assert.deepEqual(await (await fetch(`${registry.url}/.well-known/usher-site.json`)).json(), { usher_site: '0.1', site_key: own.site_key });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${registry.url}/`);
  await page.waitForFunction(() => document.querySelector('form[action="/interest"]')?.getAttribute('data-usher-knock'));
  assert.equal(await page.locator('form[action="/interest"]').getAttribute('data-usher-knock'), `${registry.url}/knock`);
  await browser.close();
});

test('front page: a failed "try it" is explained on the page', async () => {
  const res = await post('/viewer', { from: 'home', url: 'http://10.0.0.1/form' });
  assert.equal(res.status, 422);
  const text = await res.text();
  assert.match(text, /class="card error">The viewer only opens public websites\./);
  assert.match(text, /<h3>Map<\/h3>/, 'still the front page');
});

test('interest: people are stored, agents must knock, mistakes are explained, the list is for the admin only', async () => {
  const ok = await post('/interest', { site: 'https://shop.example', email: 'owner@shop.example', note: 'A checkout form' });
  assert.deepEqual([ok.status, ok.headers.get('location')], [303, '/interest/thanks']);
  assert.match(await (await fetch(`${registry.url}/interest/thanks`)).text(), /Thank you/);
  const agent = await post('/interest', { site: 'https://shop.example', email: 'a@shop.example' }, { 'Usher-Agent': 'test-agent' });
  assert.equal(agent.status, 403);
  assert.deepEqual(((await agent.json()) as { error: string; intent: string }).intent, 'contact.interest');
  const bad = await post('/interest', { site: 'shop', email: 'a@shop.example' });
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /Give your site&#39;s address|Give your site's address/);

  assert.equal((await fetch(`${registry.url}/admin`)).status, 200, 'a sign-in form');
  assert.doesNotMatch(await (await fetch(`${registry.url}/admin`)).text(), /owner@shop\.example/);
  assert.equal((await post('/admin/login', { key: 'wrong' })).status, 401);
  const login = await post('/admin/login', { key: 'admin-test-key' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const list = await (await fetch(`${registry.url}/admin`, { headers: { cookie } })).text();
  assert.match(list, /owner@shop\.example/);
  assert.match(list, /A checkout form/);
  assert.doesNotMatch(list, /a@shop\.example/, 'the refused agent stored nothing');
});

test('specifications are served with this registry in place of the example registry', async () => {
  const index = await (await fetch(`${registry.url}/spec/`)).text();
  assert.match(index, /knock\.md/);
  const discovery = (await (await fetch(`${registry.url}/spec/examples/knock/site-discovery.json`)).json()) as { registry: string; knock_url: string };
  assert.deepEqual([discovery.registry, discovery.knock_url], [registry.url, `${registry.url}/knock`]);
  assert.equal((await fetch(`${registry.url}/spec/../package.json`)).status, 404);
});

test('the dashboard sign-in and signup step 1 carry the same three claims', async () => {
  for (const path of ['/dashboard', '/sites/new']) {
    const text = await (await fetch(`${registry.url}${path}`)).text();
    for (const claim of ['No changes to your systems.', 'You set the terms.', 'Every agent action on the record.']) assert.ok(text.includes(`<b>${claim}</b>`), `${path}: ${claim}`);
  }
});
