// "Publish as an assistant app" (LU-59): the setup strip and its join-to-publish time, the switch,
// the endpoint, each tool's name, description and visibility (checked), example prompts and the
// directory pack, on the owner's dashboard.

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

  assert.equal((await post('/dashboard/app/switch', { enabled: '1' })).status, 303);
  assert.equal(await r.siteAppServed(site.url), true);
  setup = await r.siteSetup(site.url);
  assert.ok(setup.steps.at(-1)!.done_at);
  assert.ok(setup.join_to_publish_ms! >= 0 && setup.join_to_publish_ms! < 60_000, String(setup.join_to_publish_ms));
  const pageText = await (await get('/dashboard/app?published')).text();
  assert.match(pageText, /Joined to published: \d+ s/);
  assert.match(pageText, new RegExp(`${running.url}/mcp/${new URL(site.url).host}`));
  // Usher's own name and description are in the boxes, not greyed out behind them.
  assert.match(pageText, /name="name:quote.health_insurance" value="get_health_insurance_quote"/);
  assert.match(pageText, /name="description:quote.health_insurance"[^>]*>Health insurance quote from [^<]+\. Asks for title, first name, last name, [a-z ]+ and more\.</);
  assert.match(pageText, /“Get me a health insurance quote from /);
  assert.match(await (await get('/dashboard')).text(), /Manage your app/);

  // Off again: the endpoint answers no one; on again, the time counts to the latest publish.
  assert.equal((await post('/dashboard/app/switch', { enabled: '0' })).status, 303);
  assert.equal(await r.siteAppServed(site.url), false);
  await post('/dashboard/app/switch', { enabled: '1' });
});

test('tools: rename, describe and hide, checked; Usher\'s own names, bad names and duplicates refused', async () => {
  const bad = await post('/dashboard/app/tools', { 'name:quote.health_insurance': 'usher_confirm', 'name:quote.car_insurance': 'Get Car!' });
  assert.equal(bad.status, 422);
  const text = await bad.text();
  assert.match(text, /&quot;usher_confirm&quot; is one of Usher&#39;s own tools/);
  assert.match(text, /&quot;Get Car!&quot; isn&#39;t a tool name/);
  assert.equal((await post('/dashboard/app/tools', { 'name:quote.health_insurance': 'get_car_insurance_quote' })).status, 422, 'two tools with one name');
  const ok = await post('/dashboard/app/tools', { 'name:quote.health_insurance': 'brightwater_health_quote', 'description:quote.health_insurance': 'A <b>health</b> quote, in two minutes.', 'hidden:quote.car_insurance': '1' });
  assert.equal(ok.status, 303);
  const app = await running.registry.siteApp(site.url);
  assert.deepEqual(app.tools, { 'quote.health_insurance': { name: 'brightwater_health_quote', description: 'A bhealth/b quote, in two minutes.' }, 'quote.car_insurance': { hidden: true } });
  assert.equal(app.enabled, true, 'saving tools leaves the switch as it was');
  assert.deepEqual(checkToolSettings({}, ['quote.health_insurance']), { tools: {} });
  assert.deepEqual(examplePrompts('Acme', [{ title: 'Pet insurance quote from Acme', intent: 'quote.pet_insurance' }]), ['Get me a pet insurance quote from Acme.', 'I\'d like a pet insurance quote from Acme. Ask me for whatever you need, then show me the price.', 'What can Acme do for me here?']);
});

test('tools: Usher\'s own words fill the boxes; saving them unchanged keeps them Usher\'s; Muse Spark suggests, the owner saves', async () => {
  const before = await running.registry.siteApp(site.url);
  await running.registry.setSiteApp(site.url, { ...before, tools: {} });
  const page = await (await get('/dashboard/app')).text();
  const box = (intent: string, field: 'name' | 'description') => new RegExp(field === 'name' ? `name="name:${intent}" value="([^"]*)"` : `name="description:${intent}"[^>]*>([^<]*)<`).exec(page)![1]!.replace(/&#39;/g, "'");
  const intents = ['quote.health_insurance', 'quote.car_insurance'];
  const unchanged = Object.fromEntries(intents.flatMap((i) => [[`name:${i}`, box(i, 'name')], [`description:${i}`, box(i, 'description')]]));
  assert.equal((await post('/dashboard/app/tools', unchanged)).status, 303);
  assert.deepEqual((await running.registry.siteApp(site.url)).tools, {}, 'nothing stored: the names and descriptions stay Usher\'s');

  const suggested = await post('/dashboard/app/tools/suggest', {});
  assert.equal(suggested.status, 200);
  const text = await suggested.text();
  assert.match(text, /Muse Spark's suggestions are in the boxes/);
  assert.match(text, /name="name:quote.health_insurance" value="quote_health_insurance"/);
  assert.match(text, /name="name:quote.car_insurance" value="get_car_insurance_quote"/, 'a name it may not use falls back to Usher\'s');
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
