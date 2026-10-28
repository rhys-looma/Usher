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
const labels = await Promise.all((['a', 'c'] as const).flatMap((l) => (['driver', 'vehicle', 'cover'] as const).map((s) => readFixture(l, s))));

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

type Decision = { key: string; label: string; kind: string; page: string; default?: boolean };
type Block = { kind: string; text: string; verbatim: boolean; source: { key?: string; url?: string } };
type Reply = {
  status: string;
  id: string;
  decisions?: Decision[];
  blocks?: Block[];
  problems?: { key: string; message: string }[];
  actions?: { page: string; action: string; key: string }[];
  session?: string;
  used_model?: string[];
  final_url?: string;
  result?: { title: string; final_url: string; facts: string[] };
  submitted?: string[];
  pauses?: number;
  reason?: string;
};
const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result.content));
  return result.structuredContent as unknown as Reply;
};
const session = async (sid: string): Promise<Session> => (await fetch(`${registry.url}/sessions/${sid}`, { headers: { Authorization: `Bearer ${keys.secret_key}` } })).json() as Promise<Session>;

/** Answers every decision set as the user would: yes to the declaration and Get my quote, no to marketing. */
async function toTheEnd(first: Reply, extra: Record<string, string> = {}): Promise<{ last: Reply; sets: Decision[][] }> {
  const sets: Decision[][] = [];
  let reply = first;
  while (reply.status === 'needs_decision') {
    sets.push(reply.decisions!);
    const answers = Object.fromEntries(reply.decisions!.map((d) => [d.key, d.kind === 'missing_value' ? extra[d.key]! : d.key !== 'consent.marketing']));
    reply = await call('usher_confirm', { id: reply.id, answers });
  }
  return { last: reply, sets };
}

test('the tools are offered alongside knock, and their descriptions carry the behaviour', async () => {
  const tools = (await client.listTools()).tools;
  for (const name of ['knock', 'usher_fill', 'usher_confirm', 'usher_cancel']) assert.ok(tools.some((t) => t.name === name), name);
  const fill = tools.find((t) => t.name === 'usher_fill')!.description!;
  assert.match(fill, /pauses for the person at every consent and before anything is submitted/);
  assert.match(fill, /word for word/);
  assert.match(fill, /never answer them yourself/);
  assert.match(fill, /usher_fill\(\{ site: "Brightwater", task: "health insurance quote", details: /, 'one example, in the person\'s words');
  assert.match(tools.find((t) => t.name === 'usher_confirm')!.description!, /never decide for them/);
});

test('pre-flight: a wrongly formatted value comes back by key, and nothing runs', async () => {
  const reply = await call('usher_fill', { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values: { ...values, 'person.dob': '02/04/1988' } });
  assert.equal(reply.status, 'invalid');
  assert.deepEqual(reply.problems?.map((p) => p.key), ['person.dob']);
  assert.equal(reply.actions, undefined, 'nothing ran');
});

test('Brightwater pauses once, with three decisions and the page\'s own words; the quote comes back verbatim', async () => {
  const first = await call('usher_fill', { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values });
  assert.equal(first.status, 'needs_decision');
  assert.deepEqual(
    first.decisions!.map((d) => `${d.kind}:${d.key}`),
    ['required_consent:consent.declaration', 'optional_consent:consent.marketing', 'submit:form.submit'],
  );
  assert.equal(first.decisions!.find((d) => d.key === 'consent.marketing')!.default, false);
  const consent = first.blocks!.find((b) => b.kind === 'consent' && b.source.key === 'consent.declaration')!;
  assert.deepEqual([consent.text, consent.verbatim], ['I confirm the information I have given is true and complete', true]);
  const disclosure = first.blocks!.find((b) => b.kind === 'disclosure')!;
  assert.equal(disclosure.text, 'By selecting Get my quote you agree that Brightwater may use these answers to work out your price. This is a demo site: nothing is bought.', 'the visible text only: not Usher\'s own note for agents');
  assert.equal(disclosure.source.key, 'form.submit');
  const { last, sets } = await toTheEnd(first);
  assert.equal(sets.length, 1, 'one pause');
  assert.equal(last.status, 'completed', last.reason);
  assert.equal(last.pauses, 1);
  assert.equal(last.result!.title, 'Your quote');
  assert.match(last.result!.final_url, /\/quote\/result$/);
  assert.ok(last.result!.facts.some((f) => /^£[\d,]+\.\d\d a year$/.test(f)), last.result!.facts.join(' | '));
  assert.ok(last.result!.facts.some((f) => /^Quote reference BW-[0-9A-F]{8}$/.test(f)));
  assert.ok(last.result!.facts.some((f) => /^This quote is valid for 30 days, until /.test(f)));
  assert.ok(last.blocks!.every((b) => b.kind === 'fact' && b.verbatim));
  assert.deepEqual(last.used_model, [], 'every page from the map');
  for (const k of ['person.first_name', 'vehicle.registration', 'policy.start_date', 'consent.declaration']) assert.ok(last.submitted!.includes(k), k);
  assert.ok(!JSON.stringify(last).includes('Taylor') && !JSON.stringify(last).includes('AB12CDE'), 'no values echoed back');
  const log = await session(last.session!);
  assert.ok(log.events.some((e) => e.source === 'site' && e.action === 'submit' && e.key === 'form.submit'), 'the site saw the submit by key');
  const shown = log.events.filter((e) => e.action === 'shown');
  assert.ok(shown.some((e) => e.key === 'consent.declaration' && (e.detail as { block: string }).block === 'consent'));
  assert.ok(shown.some((e) => (e.detail as { block: string }).block === 'fact'));
  assert.ok(shown.every((e) => /^sha256:[0-9a-f]{64}$/.test((e.detail as { sha256: string }).sha256)));
  assert.ok(!JSON.stringify(log).includes('I confirm the information'), 'the log keeps hashes, never the text');
});

test('a missing postcode is a question in the decision set, not a failure', async () => {
  const { 'address.postcode': _p, ...without } = values;
  const first = await call('usher_fill', { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values: without });
  assert.equal(first.status, 'needs_decision');
  const postcode = first.decisions!.find((d) => d.key === 'address.postcode')!;
  assert.equal(postcode.kind, 'missing_value');
  assert.ok(first.blocks!.some((b) => b.kind === 'question' && b.source.key === 'address.postcode' && !b.verbatim));
  // The rest of the journey's decisions come with it, from the plan.
  for (const k of ['consent.declaration', 'consent.marketing', 'form.submit']) assert.ok(first.decisions!.some((d) => d.key === k), k);
  const { last } = await toTheEnd(first, { 'address.postcode': 'WR14 1AA' });
  assert.equal(last.status, 'completed', last.reason);
  assert.ok(last.submitted!.includes('address.postcode'));
});

test('every decision needs an answer; no to the declaration stops before anything is submitted', async () => {
  const first = await call('usher_fill', { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values });
  const partial = await client.callTool({ name: 'usher_confirm', arguments: { id: first.id, answers: { 'consent.declaration': true } } });
  assert.ok(partial.isError);
  assert.match((partial.content as { text: string }[])[0]!.text, /form\.submit/);
  const stopped = await call('usher_confirm', { id: first.id, answers: { 'consent.declaration': false, 'consent.marketing': false, 'form.submit': true } });
  assert.equal(stopped.status, 'stopped');
  assert.match(stopped.reason!, /I confirm the information/);
  assert.ok(!stopped.actions!.some((a) => a.key === 'form.submit'));
});

test('cancel: the fill stops at the decision set and nothing is submitted', async () => {
  const first = await call('usher_fill', { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values });
  assert.equal(first.status, 'needs_decision');
  const cancelled = await call('usher_cancel', { id: first.id });
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(!cancelled.actions!.some((a) => a.key === 'form.submit'));
  const again = await client.callTool({ name: 'usher_confirm', arguments: { id: first.id } });
  assert.ok(again.isError, 'nothing left to confirm');
});

test('layout C: the same three decisions, every value filled through the controls real forms use', async () => {
  await site.setLayout('c');
  try {
    const first = await call('usher_fill', { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values });
    assert.equal(first.status, 'needs_decision', JSON.stringify(first).slice(0, 300));
    assert.deepEqual(first.decisions!.map((d) => `${d.kind}:${d.key}`), ['required_consent:consent.declaration', 'optional_consent:consent.marketing', 'submit:form.submit']);
    const { last } = await toTheEnd(first);
    assert.equal(last.status, 'completed', last.reason);
    assert.match(last.result!.facts.join(' '), /£[\d,]+\.\d\d a year/);
  } finally {
    await site.setLayout('a');
  }
});

test('a page with no map: the model reads it, and the reply says so', async () => {
  const first = await call('usher_fill', { url: `${bare.url}/quote/driver`, intent: 'quote.car_insurance', values });
  const { last } = await toTheEnd(first);
  assert.equal(last.status, 'completed');
  assert.deepEqual(last.used_model, ['/quote/driver', '/quote/vehicle', '/quote/cover']);
});

test('the person\'s own confirmation reads into answers by key; anything it doesn\'t settle is left unanswered', async () => {
  const { parseConfirmation, confirmationPhrase } = await import('../src/fill.ts');
  const decisions = [
    { key: 'consent.declaration', label: 'I confirm…', kind: 'required_consent' as const, page: '/quote/cover', short: 'declaration' },
    { key: 'consent.marketing', label: 'Send me offers by email (optional)', kind: 'optional_consent' as const, page: '/quote/cover', short: 'marketing' },
    { key: 'form.submit', label: 'Get my quote', kind: 'submit' as const, page: '/quote/cover', short: 'get my quote' },
    { key: 'address.postcode', label: 'Postcode', kind: 'missing_value' as const, page: '/quote/driver', short: 'postcode' },
  ];
  assert.equal(confirmationPhrase(decisions), 'Confirm: declaration yes/no, marketing yes/no, get my quote yes/no, postcode "…"');
  assert.deepEqual(parseConfirmation('Confirm: Declaration yes, marketing no, get my quote YES, postcode "WR14 1AA"', decisions), { 'consent.declaration': true, 'consent.marketing': false, 'form.submit': true, 'address.postcode': 'WR14 1AA' });
  assert.deepEqual(parseConfirmation('declaration yes', decisions), { 'consent.declaration': true, 'consent.marketing': undefined, 'form.submit': undefined, 'address.postcode': undefined });
});
