// usher_fill, usher_confirm, usher_cancel over MCP, against the three-step Brightwater quote: values
// that fail pre-flight come back before anything runs; a fill pauses for the user's answers and the
// consequential "Get my quote", then completes; a cancel stops it; a page with no map falls back to
// the model and says so. needs_user fields are only ever filled from the user's answer.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { chromium, type Browser } from 'playwright';
import { seed, startRegistry, type RunningRegistry, type Session } from '@usher/registry';
import { createMcpServer } from '../../registry/src/mcp.ts';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { registerSite, type SiteKeys } from '../../registry/test/sites.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';
import { readFixture, replayAny } from '../../core/test/replay.ts';
import { registerFillTools } from '../src/fill.ts';

const profile = JSON.parse(await readFile(new URL('../../agent/profiles/test-driver.json', import.meta.url), 'utf8')) as Record<string, string | boolean>;
// The user's values by key; needs_user answers are the user's to give at the pause, so they're not here.
const { _comment: _, 'consent.declaration': _d, 'consent.marketing': _m, ...values } = profile;
const labels = await Promise.all((['driver', 'vehicle', 'cover'] as const).map((s) => readFixture('a', s)));

let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let bare: MockSite;
let keys: SiteKeys;
let browser: Browser;
let client: Client;
let tools: { close: () => Promise<void> };
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-fill-'));
  registry = await startRegistry({ storage: await testStorage(join(dir, 'registry')), siteScript: fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url)) });
  site = await startMockSite({ registry: registry.url, register: async (o) => (keys = await registerSite(registry, o)).site_key });
  await seed(registry.registry, 'mock-site', site.url);
  // The same quote on an origin with no maps: the model reads it.
  bare = await startMockSite({ registry: registry.url, register: async (o) => (await registerSite(registry, o)).site_key });
  browser = await chromium.launch();
  const keyFile = join(dir, 'agent-key.json');
  const server = await createMcpServer(registry.url, keyFile, '0.2.0-test');
  tools = registerFillTools(server, { registryUrl: registry.url, keyFile, browser: async () => browser, fallback: { chat: replayAny(labels), model: 'muse-spark-1.3', logDir: null } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'fill-test', version: '0' });
  await client.connect(b);
});
after(async () => {
  await client.close();
  await tools.close();
  await browser.close();
  await bare.stop();
  await site.stop();
  await registry.close();
  await rm(dir, { recursive: true });
});

type Reply = { status: string; id: string; decision?: { kind: string; key: string; label: string }; problems?: { key: string; message: string }[]; actions?: { page: string; action: string; key: string }[]; session?: string; used_model?: string[]; page_maps?: string[]; final_url?: string };
const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result.content));
  return result.structuredContent as unknown as Reply;
};
const session = async (sid: string): Promise<Session> => (await fetch(`${registry.url}/sessions/${sid}`, { headers: { Authorization: `Bearer ${keys.secret_key}` } })).json() as Promise<Session>;

/** Answers each pause as the user would: yes to the declaration, no to marketing, yes to Get my quote. */
async function toTheEnd(first: Reply): Promise<{ last: Reply; decisions: string[] }> {
  const decisions: string[] = [];
  let reply = first;
  while (reply.status === 'needs_decision') {
    decisions.push(`${reply.decision!.kind}:${reply.decision!.key}`);
    const answer = reply.decision!.key === 'consent.marketing' ? false : true;
    reply = await call('usher_confirm', { id: reply.id, answer });
  }
  return { last: reply, decisions };
}

test('the tools are offered alongside knock', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const name of ['knock', 'usher_fill', 'usher_confirm', 'usher_cancel']) assert.ok(names.includes(name), name);
});

test('pre-flight: an invalid value comes back by key, and nothing runs', async () => {
  const reply = await call('usher_fill', { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values: { ...values, 'person.dob': '02/04/1988' } });
  assert.equal(reply.status, 'invalid');
  assert.deepEqual(reply.problems?.map((p) => p.key), ['person.dob']);
  assert.deepEqual(reply.actions, [], 'nothing entered');
});

test('fill, then the user\'s answers and "Get my quote": the three-step quote completes, logged by key', async () => {
  const first = await call('usher_fill', { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values });
  assert.equal(first.status, 'needs_decision');
  const { last, decisions } = await toTheEnd(first);
  assert.deepEqual(decisions, ['needs_user:consent.declaration', 'needs_user:consent.marketing', 'confirm:form.submit']);
  assert.equal(last.status, 'completed');
  assert.match(last.final_url!, /\/quote\/result$/);
  assert.deepEqual(last.used_model, [], 'every page from the map');
  assert.deepEqual(last.page_maps, ['/quote/driver', '/quote/vehicle', '/quote/cover'], 'each page\'s own published map');
  const keysTaken = last.actions!.map((a) => `${a.action}:${a.key}`);
  for (const k of ['fill:person.first_name', 'fill:vehicle.registration', 'fill:policy.start_date', 'press:form.submit']) assert.ok(keysTaken.includes(k), k);
  assert.ok(!JSON.stringify(last).includes('Taylor'), 'no values in the reply');
  const log = await session(last.session!);
  assert.ok(log.events.some((e) => e.source === 'site' && e.action === 'submit' && e.key === 'form.submit'), 'the site saw the submit by key');
});

test('cancel: the fill stops at the first decision and nothing is submitted', async () => {
  const first = await call('usher_fill', { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values });
  assert.equal(first.status, 'needs_decision');
  const cancelled = await call('usher_cancel', { id: first.id });
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(!cancelled.actions!.some((a) => a.key === 'form.submit'));
  const again = await client.callTool({ name: 'usher_confirm', arguments: { id: first.id } });
  assert.ok(again.isError, 'nothing left to confirm');
});

test('a page with no map: the model reads it, and the reply says so', async () => {
  const first = await call('usher_fill', { url: `${bare.url}/quote/driver`, intent: 'quote.car_insurance', values });
  const { last } = await toTheEnd(first);
  assert.equal(last.status, 'completed');
  assert.deepEqual(last.used_model, ['/quote/driver', '/quote/vehicle', '/quote/cover']);
});
