// The plan path through the hosted server: get_plan for Brightwater's health quote (the plan for a
// browser, and its card), prepare_run with the person's answers and the stops they confirmed, then a
// browser of the assistant's own, automated, opening entry_url and filling by the plan: the token in
// the URL is bound, the address bar is cleaned, and the quote is accepted. An unmapped site gets no
// plan and the ask is noted. Nothing the person gave is left in any file the registry writes or in
// what the process prints.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium, type Browser } from 'playwright';
import { fillField, locate, type BrowserPlan, type UsherMap } from '@usher/core';
import { seed, startRegistry, type RunningRegistry } from '@usher/registry';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { registerSite } from '../../registry/test/sites.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';
import { hostedMcp } from '../src/hosted.ts';

// Values no page, map or fixture holds, so finding one anywhere means it was kept.
const values = {
  'person.title': 'Mr',
  'person.first_name': 'Quillon',
  'person.last_name': 'Vexmore',
  'person.dob': '1979-03-17',
  'address.postcode': 'WR14 1AA',
  'contact.email': 'quillon.vexmore@example.org',
  'contact.phone': '07700 900456',
  'cover.who': 'Just me',
  'person.smoker': 'No',
  'cover.level': 'Standard',
  'cover.excess': '£500',
  'cover.hospital_list': 'Local',
  'cover.outpatient_limit': '£1,500',
  'policy.start_date': '2026-12-14',
  'policy.payment_frequency': 'Annually',
};
const NEEDLES = ['Quillon', 'Vexmore', 'quillon.vexmore', '900456', '1979-03-17', '17/03/1979', '2026-12-14', '14/12/2026'];

let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let browser: Browser;
let printed = '';
const writes = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-plan-'));
  browser = await chromium.launch();
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => ((printed += String(chunk)), writes.out(chunk, ...rest))) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => ((printed += String(chunk)), writes.err(chunk, ...rest))) as typeof process.stderr.write;
  const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
  registry = await startRegistry({
    storage: await testStorage(join(dir, 'registry')),
    siteScript,
    claims: { allowPrivate: true },
    mcp: (r) => hostedMcp({ registry: r, version: 'test', browser: async () => browser, allowPrivate: true }),
  });
  site = await startMockSite({ registry: registry.url, register: async (o) => (await registerSite(registry, o)).site_key });
  await seed(registry.registry, 'mock-site', site.url);
});
after(async () => {
  process.stdout.write = writes.out;
  process.stderr.write = writes.err;
  await browser.close();
  await site.stop();
  await registry.close();
  await rm(dir, { recursive: true });
});

async function connect(): Promise<Client> {
  const client = new Client({ name: 'plan-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${registry.url}/mcp`)));
  return client;
}

test('get_plan: the plan for a browser, with the card\'s questions and the declaration word for word', async () => {
  const client = await connect();
  const tools = (await client.listTools()).tools;
  assert.match(tools.find((t) => t.name === 'usher_fill')!.description!, /^If you cannot drive a browser, Usher can fill the form for you\. Otherwise use get_plan\./);
  assert.ok(tools.find((t) => t.name === 'get_plan')!._meta, 'get_plan renders as the card');
  assert.ok(tools.some((t) => t.name === 'prepare_run'));
  const result = await client.callTool({ name: 'get_plan', arguments: { url: `${site.url}/health/about` } });
  const data = result.structuredContent as { status: string; plan_for: string; plan: BrowserPlan; decisions: { key: string; kind: string }[]; blocks: { text: string }[] };
  assert.equal(data.status, 'needs_decision');
  assert.equal(data.plan_for, 'browser');
  assert.equal(data.plan.known, '3 of 3 pages, to the end');
  assert.equal(data.plan.site.joined, true);
  assert.ok(data.decisions.some((d) => d.key === 'person.first_name' && d.kind === 'missing_value'));
  // The declaration and the smoking question are the person's own to do on the page: the site
  // refuses them from an assistant, so the card neither asks nor confirms them.
  assert.deepEqual(data.decisions.filter((d) => d.kind !== 'missing_value').map((d) => d.key), ['form.submit']);
  assert.ok(!data.decisions.some((d) => d.key === 'person.smoker'));
  assert.equal(data.plan.stops.find((s) => s.key === 'consent.declaration')?.user_only, true);
  assert.match(data.plan.stops.find((s) => s.key === 'consent.declaration')!.verbatim!, /I confirm/);
  // The plan from the home page reaches the same journey for its intent.
  const fromHome = await client.callTool({ name: 'get_plan', arguments: { url: `${site.url}/`, intent: 'quote.health_insurance' } });
  assert.equal((fromHome.structuredContent as { plan: BrowserPlan }).plan.steps[0]!.url, `${site.url}/health/about`);
  await client.close();
});

test('an unmapped site gets no plan, never a compile, and the ask is noted for the admin', async () => {
  const client = await connect();
  const result = await client.callTool({ name: 'get_plan', arguments: { url: 'https://unmapped.example/quote', intent: 'quote.life_insurance' } });
  assert.equal((result.structuredContent as { status: string }).status, 'not_mapped');
  assert.match((result.content as { text: string }[])[0]!.text, /hasn't mapped https:\/\/unmapped\.example/);
  assert.deepEqual((await registry.registry.planAsks()).map((a) => [a.origin, a.intent, a.asks]), [['https://unmapped.example', 'quote.life_insurance', 1]]);
  await client.close();
});

test('prepare_run with an answer that won\'t fit: needs_answers, the problem by key, and no token yet', async () => {
  const client = await connect();
  const result = await client.callTool({ name: 'prepare_run', arguments: { url: `${site.url}/health/about`, values: { ...values, 'person.dob': 'the spring of 79' } } });
  const data = result.structuredContent as { status: string; plan: BrowserPlan; entry_url?: string };
  assert.equal(data.status, 'needs_answers');
  assert.deepEqual(data.plan.problems?.map((p) => p.key), ['person.dob']);
  assert.equal(data.entry_url, undefined);
  await client.close();
});

test('prepare_run, then the assistant\'s own browser opens entry_url, fills by the plan and gets its quote; nothing is kept', async () => {
  const client = await connect();
  const result = await client.callTool({ name: 'prepare_run', arguments: { url: `${site.url}/health/about`, values: { ...values, 'person.dob': '17 March 1979', 'policy.start_date': '14/12/2026' }, confirmed: ['consent.declaration', 'form.submit'] } });
  const data = result.structuredContent as { status: string; plan: BrowserPlan; entry_url: string; confirmed: string[] };
  assert.equal(data.status, 'ready');
  assert.equal(data.plan.problems, undefined, JSON.stringify(data.plan.problems));
  assert.deepEqual(data.confirmed, ['form.submit'], 'the declaration is the person\'s to tick, so it is not confirmed for them');
  const entry = new URL(data.entry_url);
  assert.ok(entry.searchParams.get('usher'), 'the token is in the entry URL');
  const dobDay = data.plan.steps[0]!.fields.find((f) => f.key === 'person.dob' && f.part === 'day');
  assert.equal(dobDay?.value, '17', 'the value in the site\'s own form');

  // The assistant's browser: automated (navigator.webdriver), so the site asks it for a token, which
  // the entry URL gave it. It fills by key with the values the plan gives.
  const page = await (await browser.newContext()).newPage();
  await page.goto(entry.href);
  await page.waitForFunction('window.usher && window.usher.state().bound === true');
  assert.equal(new URL(page.url()).searchParams.get('usher'), null, 'the token is gone from the address bar');
  const seeded = new URL('../../registry/seed/mock-site/', import.meta.url);
  for (const [i, file] of ['4-health-about', '5-health-cover', '6-health-declaration'].entries()) {
    const map = JSON.parse(await readFile(new URL(`${file}.map.json`, seeded), 'utf8')) as UsherMap;
    assert.equal(new URL(page.url()).pathname, map.path);
    if (i > 0) await page.waitForFunction('window.usher && window.usher.state().bound === true');
    const step = data.plan.steps[i]!;
    for (const f of map.fields) {
      const placed = step.fields.find((p) => p.key === f.key && p.part === f.part);
      // What only the person may do, they do: here, the test acts as them.
      if (f.key === 'consent.declaration') await fillField(page, f, true);
      else if (f.key === 'person.smoker') await fillField(page, f, 'No');
      else if (placed?.value !== undefined && !f.shown_if) await fillField(page, f, placed.value);
    }
    if (step.lookups?.length) {
      await (await locate(page, map.actions.find((a) => a.key === 'lookup.address')!))!.click();
      await page.waitForTimeout(800);
      const list = page.locator('.lookup-results select').first();
      if (await list.count()) await list.selectOption({ index: 1 });
    }
    await (await locate(page, map.actions.find((a) => a.key === 'form.submit' || a.key === 'nav.next')!))!.click();
    await page.waitForLoadState('load');
  }
  assert.equal(new URL(page.url()).pathname, '/health/result', 'the quote, with the token from the entry URL');
  await page.context().close();
  await client.close();

  // Nothing the person gave is in any file the registry wrote, or in what the process printed.
  const files: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) e.isDirectory() ? await walk(join(d, e.name)) : files.push(join(d, e.name));
  };
  await walk(dir);
  for (const f of files) {
    const text = await readFile(f, 'utf8');
    for (const n of NEEDLES) assert.ok(!text.includes(n), `${n} in ${f}`);
  }
  for (const n of NEEDLES) assert.ok(!printed.includes(n), `${n} printed`);
});
