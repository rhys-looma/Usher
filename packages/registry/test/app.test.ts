// "Publish as an assistant app" (LU-59): the setup strip and its join-to-publish time, the switch,
// the endpoint, each tool's name, description and visibility (checked), example prompts and the
// directory pack, on the owner's dashboard.

import { chromium } from 'playwright';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import type { ChatFn } from '@usher/core';
import { checkToolSettings, examplePrompts, seedMaps, startRegistry, type RunningRegistry } from '../src/index.ts';
import { registerSite, type SiteKeys } from './sites.ts';
import { testStorage } from './storage-helper.ts';

let dir: string;
let running: RunningRegistry;
let site: MockSite;
let keys: SiteKeys;
let cookie: string;
// Muse Spark's stand-in: names and describes the tools it's given, once with a name it may not use.
const asked: string[] = [];
const writer: ChatFn = async (request) => {
  const facts = JSON.parse(String(request.messages.at(-1)!.content).replace(/^Facts:\n/, '')) as { business: string; tools: { intent: string; journey: string }[] };
  asked.push(JSON.stringify(facts));
  const tools = facts.tools.map((t, i) => ({ intent: t.intent, name: i === 0 ? `quote_${t.intent.split('.')[1]}` : 'usher_confirm', description: `${t.journey}, in a few minutes.` }));
  return { content: JSON.stringify({ tools }), usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cached_tokens: 0 }, latency_ms: 1, response: null };
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-app-'));
  running = await startRegistry({ storage: await testStorage(dir), siteScript: fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url)), web: { allowPrivate: true, toolWriter: { chat: writer, model: 'muse-spark-1.3' } } });
  site = await startMockSite({ registry: running.url, register: async (o) => (keys = await registerSite(running, o)).site_key });
  const login = await fetch(`${running.url}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: keys.origin, secret: keys.secret_key }) });
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
});
after(async () => {
  await site.stop();
  await running.close();
  await rm(dir, { recursive: true });
});

const get = (path: string) => fetch(`${running.url}${path}`, { headers: { Cookie: cookie } });
const post = (path: string, form: Record<string, string>) => fetch(`${running.url}${path}`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie }, body: new URLSearchParams(form) });

test('the setup strip: each step as it is done, and the time from joining to publishing', async () => {
  const r = running.registry;
  let setup = await r.siteSetup(site.url);
  assert.deepEqual(setup.steps.map((s) => [s.key, Boolean(s.done_at)]), [['joined', true], ['mapped', false], ['rules', false], ['look', false], ['published', false]]);
  assert.equal(setup.join_to_publish_ms, undefined);
  // Nothing to publish yet: the switch refuses.
  assert.match(await (await get('/dashboard/app')).text(), /Joined [\d a-z]+ ago; not published yet/);
  assert.equal((await post('/dashboard/app/switch', { enabled: '1' })).status, 422);

  for (const map of await seedMaps('mock-site')) await r.addMap({ ...map, origin: site.url });
  await r.approveTheme(site.url, { name: 'Brightwater Insurance', accent: '#0b6e6e', second: '#0b6e6e', typeface: 'system', radius: 8, result_fields: [] });
  setup = await r.siteSetup(site.url);
  assert.deepEqual(setup.steps.map((s) => Boolean(s.done_at)), [true, true, false, true, false]);

  // Its rules before its name goes on it, with some ready to confirm.
  const held = await post('/dashboard/app/switch', { enabled: '1' });
  assert.equal(held.status, 422);
  assert.match(await held.text(), /Finish these first: Rules\./);
  await get('/dashboard');
  const [suggested] = (await r.storage.listDrafts(site.url)).filter((d) => d.status === 'pending');
  assert.equal(suggested?.model, 'usher', 'written from the maps');
  const onward = await post(`/dashboard/rules/${suggested!.id}/confirm`, {});
  assert.equal(onward.status, 303);
  assert.equal(onward.headers.get('location'), '/dashboard/app?done=rules#switch', 'on to the next step');
  assert.match(await (await get('/dashboard/app?done=rules')).text(), /Your rules are applied\. Last step: publish your app\./);
  assert.equal((await post('/dashboard/app/switch', { enabled: '1' })).status, 303);
  assert.equal(await r.siteAppServed(site.url), true);
  setup = await r.siteSetup(site.url);
  assert.ok(setup.steps.at(-1)!.done_at);
  assert.ok(setup.join_to_publish_ms! >= 0 && setup.join_to_publish_ms! < 60_000, String(setup.join_to_publish_ms));
  const pageText = await (await get('/dashboard/app?published')).text();
  assert.match(pageText, /Joined to published: \d+ s/);
  assert.match(pageText, new RegExp(`${running.url}/mcp/${new URL(site.url).host}`));
  assert.match(pageText, /“Get me a health insurance quote from /);
  assert.match(await (await get('/dashboard')).text(), /Manage your app/);
  // Usher's own name and description are in the boxes, not greyed out behind them.
  const toolText = await (await get('/dashboard/tools/quote.health_insurance')).text();
  assert.match(toolText, /name="name" value="get_health_insurance_quote"/);
  assert.match(toolText, /name="description"[^>]*>Health insurance quote from [^<]+\. Asks for title, first name, last name, [a-z ]+ and more\.</);

  // Off again: the endpoint answers no one; on again, the time counts to the latest publish.
  assert.equal((await post('/dashboard/app/switch', { enabled: '0' })).status, 303);
  assert.equal(await r.siteAppServed(site.url), false);
  await post('/dashboard/app/switch', { enabled: '1' });
});

test('the dashboard leads with tools, each down to its pages, one page open at a time', async () => {
  const board = await (await get('/dashboard')).text();
  assert.ok(board.indexOf('id="tools"') < board.indexOf('id="activity"') && board.indexOf('id="activity"') < board.indexOf('id="rules"'), 'tools come first');
  assert.ok(board.includes('href="/dashboard#activity"') && board.includes('href="/dashboard/app"'), 'the tabs');
  assert.ok(board.includes('>Tasks</a>') && !board.includes('>Tools</a>'), 'in words anyone would use');
  assert.ok(board.includes('href="/dashboard/tools/quote.health_insurance"'), 'each tool opens');
  assert.ok(board.includes('/dashboard/tools/quote.health_insurance?step=3#flow'), 'and its dots lead to its pages');
  const first = await (await get('/dashboard/tools/quote.health_insurance')).text();
  assert.ok(first.includes('<code>/health/about</code>') && first.includes('aria-current="step"'));
  assert.match(first, /<small>\/health\/declaration<\/small>/, 'every step is in the strip');
  assert.ok(!first.includes('<code>/health/declaration</code>'), 'only the open page is shown in full');
  const third = await (await get('/dashboard/tools/quote.health_insurance?step=3')).text();
  assert.ok(third.includes('<code>/health/declaration</code>') && !third.includes('<code>/health/about</code>'));
  assert.equal((await get('/dashboard/tools/quote.nothing')).status, 404);
  assert.equal((await fetch(`${running.url}/dashboard/tools/quote.health_insurance`)).status, 401, 'owners only');
  assert.match(await (await get('/dashboard/app')).text(), /href="\/dashboard\/tools\/quote\.health_insurance"/, 'the publish page lists them, and leads there');
});

test('tools: rename, describe and hide, one tool at a time, checked; Usher\'s own names, bad names and duplicates refused', async () => {
  const health = '/dashboard/tools/quote.health_insurance';
  const bad = await post(health, { name: 'usher_confirm', description: 'x' });
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /&quot;usher_confirm&quot; is one of Usher&#39;s own names/);
  const badName = await post(health, { name: 'Get Car!', description: 'x' });
  assert.equal(badName.status, 422);
  assert.match(await badName.text(), /&quot;Get Car!&quot; isn&#39;t a valid name/);
  assert.equal((await post(health, { name: 'get_car_insurance_quote', description: 'x' })).status, 422, 'two tools with one name');
  assert.equal((await post(health, { name: 'brightwater_health_quote', description: 'A <b>health</b> quote, in two minutes.' })).status, 303);
  const car = await (await get('/dashboard/tools/quote.car_insurance')).text();
  const box = (field: 'name' | 'description') => new RegExp(field === 'name' ? 'name="name" value="([^"]*)"' : 'name="description"[^>]*>([^<]*)<').exec(car)![1]!.replace(/&#39;/g, "'");
  assert.equal((await post('/dashboard/tools/quote.car_insurance', { name: box('name'), description: box('description'), hidden: '1' })).status, 303);
  const app = await running.registry.siteApp(site.url);
  assert.deepEqual(app.tools, { 'quote.health_insurance': { name: 'brightwater_health_quote', description: 'A bhealth/b quote, in two minutes.' }, 'quote.car_insurance': { hidden: true } });
  assert.equal(app.enabled, true, 'saving tools leaves the switch as it was');
  assert.equal((await post('/dashboard/tools/quote.nothing', { name: 'nothing_here', description: 'x' })).status, 404);
  assert.deepEqual(checkToolSettings({}, ['quote.health_insurance']), { tools: {} });
  assert.deepEqual(examplePrompts('Acme', [{ title: 'Pet insurance quote from Acme', intent: 'quote.pet_insurance' }]), ['Get me a pet insurance quote from Acme.', 'I\'d like a pet insurance quote from Acme. Ask me for whatever you need, then show me the price.', 'What can Acme do for me here?']);
});

test('tools: Usher\'s own words fill the boxes; saving them unchanged keeps them Usher\'s; Muse Spark suggests, the owner saves', async () => {
  const before = await running.registry.siteApp(site.url);
  await running.registry.setSiteApp(site.url, { ...before, tools: {} });
  const path = '/dashboard/tools/quote.health_insurance';
  const page = await (await get(path)).text();
  const box = (field: 'name' | 'description') => new RegExp(field === 'name' ? 'name="name" value="([^"]*)"' : 'name="description"[^>]*>([^<]*)<').exec(page)![1]!.replace(/&#39;/g, "'");
  assert.equal((await post(path, { name: box('name'), description: box('description') })).status, 303);
  assert.deepEqual((await running.registry.siteApp(site.url)).tools, {}, 'nothing stored: the names and descriptions stay Usher\'s');

  const suggested = await post(`${path}/suggest`, {});
  assert.equal(suggested.status, 200);
  const text = await suggested.text();
  assert.match(text, /Muse Spark's suggestion is in the boxes/);
  assert.match(text, /name="name" value="quote_health_insurance"/);
  assert.match(text, /Health insurance quote from [^,<]+, in a few minutes\./);
  assert.deepEqual((await running.registry.siteApp(site.url)).tools, {}, 'a suggestion isn\'t saved');
  assert.ok(!asked.join().match(/value|@/), 'the model sees journeys and questions, nothing anyone typed');
  await running.registry.setSiteApp(site.url, before);
});

test('the directory pack: everything a listing asks for, from the app as it is', async () => {
  const md = await get('/dashboard/app/pack.md');
  assert.match(md.headers.get('content-disposition') ?? '', /attachment; filename=".*-assistant-app\.md"/);
  const text = await md.text();
  assert.match(text, new RegExp(`MCP server URL:\\*\\* ${running.url}/mcp/`));
  assert.match(text, /`brightwater_health_quote`/);
  assert.doesNotMatch(text, /get_car_insurance_quote/, 'hidden tools are not listed');
  assert.match(text, /keeps none of what they typed/);
  const pack = (await (await get('/dashboard/app/pack.json')).json()) as { tools: { name: string; read_only: boolean }[]; example_prompts: string[]; short_description: string };
  assert.deepEqual(pack.tools.map((t) => t.name), ['brightwater_health_quote', 'usher_confirm', 'usher_cancel']);
  assert.ok(pack.tools.every((t) => !t.read_only), 'honest annotations: these act');
  assert.ok(pack.short_description.length <= 80);
  assert.ok(pack.example_prompts.length >= 2);
  assert.equal((await fetch(`${running.url}/dashboard/app/pack.json`)).status, 401, 'owners only');
});

test('a task\'s page: the owner chooses what happens when it finishes; mistakes are explained; the demo only shows it', async () => {
  const action = '/dashboard/tools/quote.health_insurance/after';
  const before = await (await get('/dashboard/tools/quote.health_insurance')).text();
  assert.match(before, /<h2>When it finishes<\/h2>/);
  for (const title of ['Stay in the assistant', 'Send them to a page', 'Open it on your site']) assert.ok(before.includes(`<b>${title}</b>`), title);
  assert.ok(before.includes('openHandoff'), 'the steps for a developer');

  const form = new URLSearchParams({ mode: 'redirect', show: 'reference', message: 'Call us any time.', retrieve_url: '/retrieve?reference=', retrieve_label: 'Find your quote', redirect_url: '/handoff', redirect_label: 'Open your quote' });
  form.append('ask', 'your reference');
  form.append('ask', 'your date of birth');
  const saved = await fetch(`${running.url}${action}`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie }, body: form });
  assert.equal(saved.status, 303);
  assert.deepEqual((await running.registry.siteHandoffs(keys.origin))['quote.health_insurance'], { mode: 'redirect', show: 'reference', message: 'Call us any time.', resume: { url: '/retrieve', label: 'Find your quote', asks: ['your reference', 'your date of birth'], reference_param: 'reference' }, redirect: { url: '/handoff', label: 'Open your quote' } });
  assert.match(await (await get('/dashboard/tools/quote.health_insurance')).text(), /value="redirect" checked/);

  const bad = await post(action, { mode: 'redirect', show: 'all', redirect_url: 'https://evil.example/x', redirect_label: 'Open' });
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /must be a path on your site/);
  await fetch(`${running.url}${action}`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ mode: 'none' }) });
  assert.equal((await running.registry.siteHandoffs(keys.origin))['quote.health_insurance']!.mode, 'redirect', 'not without signing in');
});

test('what the model does sits in a floating panel, and shows it is working until the page changes', async () => {
  const js = await fetch(`${running.url}/busy.js`);
  assert.equal(js.status, 200);
  assert.match(await js.text(), /data-busy/);
  const rules = await (await get('/dashboard')).text();
  assert.match(rules, /<div class="card rules-change" id="change"><h2>(Change|Tell Usher) your rules<\/h2><form method="post" action="\/dashboard\/rules" data-busy="Muse Spark is writing your policy…"/);
  assert.match(rules, /<script src="\/busy\.js" defer><\/script>/);
  const task = await (await get('/dashboard/tools/quote.health_insurance')).text();
  assert.match(task, /<details class="partner">[\s\S]*?action="\/dashboard\/tools\/quote\.health_insurance\/suggest" data-busy=/);

  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${running.url}/dashboard`);
    await page.fill('input[name=origin]', keys.origin);
    await page.fill('input[name=secret]', keys.secret_key);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForLoadState();
    await page.goto(`${running.url}/dashboard/tools/quote.health_insurance`);
    // Held here, after the page's own listener, so the wait can be looked at: a page mid-navigation can't be.
    await page.evaluate(() => window.addEventListener('submit', (e) => e.preventDefault()));
    await page.locator('.partner summary').click(); // Folded here, so it doesn't sit over the page.
    await page.getByRole('button', { name: 'Suggest with Muse Spark' }).click();
    await page.locator('.partner p.busy').waitFor();
    assert.match((await page.locator('.partner p.busy').innerText()), /Muse Spark is writing/);
    assert.equal(await page.getByRole('button', { name: 'Suggest with Muse Spark' }).isDisabled(), true, 'it can only be pressed once');
    // The rules, the slowest wait of all.
    await page.goto(`${running.url}/dashboard#rules`);
    await page.evaluate(() => window.addEventListener('submit', (e) => e.preventDefault()));
    await page.fill('#rules-text', 'Agents may fill it in.');
    await page.getByRole('button', { name: 'Propose policy' }).click();
    await page.locator('#rules p.busy').waitFor();
    assert.match(await page.locator('#rules p.busy').innerText(), /Muse Spark is writing your policy/);
    assert.equal(await page.getByRole('button', { name: 'Propose policy' }).isDisabled(), true);
  } finally {
    await browser.close();
  }
});

test('reloading an address that answered a form goes back to its page, not to "not found"', async () => {
  for (const [from, to] of [['/dashboard/rules', '/dashboard#rules'], ['/dashboard/rules/r_x/confirm', '/dashboard#rules'], ['/dashboard/explain', '/dashboard#activity'], ['/dashboard/app/switch', '/dashboard/app'], ['/dashboard/walkthrough/edit', '/dashboard/walkthrough'], ['/dashboard/tools/quote.health_insurance/after', '/dashboard/tools/quote.health_insurance'], ['/dashboard/tools/quote.health_insurance/suggest', '/dashboard/tools/quote.health_insurance']] as const) {
    const res = await fetch(`${running.url}${from}`, { redirect: 'manual', headers: { Cookie: cookie } });
    assert.deepEqual([res.status >= 300 && res.status < 400, res.headers.get('location')], [true, to], from);
  }
});

test('a site with no rules: the page says what applies and leads to the box, with examples to start from', async () => {
  const fresh = await registerSite(running, 'http://no-rules.localhost:4191');
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 850 } })).newPage();
    await page.goto(`${running.url}/dashboard`);
    await page.fill('input[name=origin]', fresh.origin);
    await page.fill('input[name=secret]', fresh.secret_key);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForLoadState();
    await page.goto(`${running.url}/dashboard#rules`);
    await page.locator('text=You haven\'t set any rules yet').waitFor();
    assert.equal(await page.locator('#rules .rules-change #rules-text').count(), 1, 'the box is on the page');
    // The page's button takes you to the box.
    await page.locator('label.button', { hasText: 'Write my rules' }).click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'rules-text');
    // An example goes in the box to change; nothing is sent.
    await page.getByRole('button', { name: 'Limit how often' }).click();
    assert.match(await page.inputValue('#rules-text'), /no more than ten submissions an hour/);
    assert.match(page.url(), /#rules$/);
    assert.equal(await page.getByRole('button', { name: 'Propose policy' }).isDisabled(), false);
  } finally {
    await browser.close();
  }
});

test('a mapped site with no rules gets some to start from: from its maps, proposed, applied only when confirmed', async () => {
  const origin = 'http://starting-rules.localhost:4192';
  const owner = await registerSite(running, origin);
  const r = running.registry;
  const mapped = (await seedMaps('mock-site')).find((m) => m.path === '/quote/cover')!;
  // Nothing mapped: nothing to suggest.
  await r.suggestRules(origin);
  assert.deepEqual(await r.storage.listDrafts(origin), []);
  await r.addMap({ ...mapped, origin });
  await r.suggestRules(origin);
  const [draft] = (await r.storage.listDrafts(origin)).filter((d) => d.status === 'pending');
  assert.equal(draft?.model, 'usher', 'no model call');
  assert.equal(await r.storage.getPolicy(origin), undefined, 'nothing applies yet');
  assert.match(draft!.text, /The person answers or confirms these themselves: “/);
  assert.match(draft!.text, /At most 10 submissions an hour/);
  // Asked again: the same one, not another.
  await r.suggestRules(origin);
  assert.equal((await r.storage.listDrafts(origin)).filter((d) => d.status === 'pending').length, 1);
  // The owner's own proposal is never replaced.
  await r.storage.putDraft({ ...draft!, id: 'r_ownwords', model: 'muse-spark-1.3', text: 'My own words' });
  await r.suggestRules(origin, { refresh: true });
  assert.ok((await r.storage.listDrafts(origin)).some((d) => d.id === 'r_ownwords' && d.status === 'pending'));
  await r.storage.putDraft({ ...draft!, id: 'r_ownwords', model: 'muse-spark-1.3', status: 'superseded' });
  // Confirmed: it applies, and nothing more is suggested.
  const applied = await r.confirmRulesFor(origin, draft!.id);
  assert.equal(applied.status, 200);
  assert.ok(await r.storage.getPolicy(origin));
  await r.suggestRules(origin, { refresh: true });
  assert.equal((await r.storage.listDrafts(origin)).filter((d) => d.status === 'pending').length, 0);
  assert.ok(owner.site_key);
});
