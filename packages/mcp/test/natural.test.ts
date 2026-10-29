// A normal prompt is enough: through the hosted server, as a client would call it, the site and the
// task in the person's words and their details as prose reach the same decision set as the keyed
// prompt, with every value filled and make, model and year from the site's own lookup, in both of
// Brightwater's car layouts; and for Brightwater Health, with the smoker answer put back to the
// person and the declaration word for word. The details are read by Muse Spark, replayed from a
// recording.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium, type Browser } from 'playwright';
import { composePlan } from '@usher/core';
import { seed, seedMaps, startRegistry, type RunningRegistry } from '@usher/registry';
import { readFixture, replayAny, type LabelFixture } from '../../core/test/replay.ts';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { registerSite } from '../../registry/test/sites.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';
import { detailsSchema, detailInputs, mapDetails } from '../src/details.ts';
import { hostedMcp } from '../src/hosted.ts';
import { NATURAL, NATURAL_HEALTH } from './natural.ts';

const profile = JSON.parse(await readFile(new URL('../../agent/profiles/test-driver.json', import.meta.url), 'utf8')) as Record<string, string | boolean>;
const { _comment: _, 'consent.declaration': _d, 'consent.marketing': _m, ...values } = profile;
const details = JSON.parse(await readFile(new URL('./fixtures/details/natural.json', import.meta.url), 'utf8')) as LabelFixture;
const healthDetails = JSON.parse(await readFile(new URL('./fixtures/details/natural-health.json', import.meta.url), 'utf8')) as LabelFixture;
// Layout B's pages have no map in this registry: the model reads them, from recordings.
const labels = await Promise.all((['a', 'b'] as const).flatMap((l) => (['driver', 'vehicle', 'cover'] as const).map((s) => readFixture(l, s))));
const chat = replayAny([details, healthDetails, ...labels]);

let dir: string;
let registry: RunningRegistry;
let bare: RunningRegistry;
let site: MockSite;
let browser: Browser;
const open: Client[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-natural-'));
  browser = await chromium.launch();
  const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
  registry = await startRegistry({ storage: await testStorage(join(dir, 'a')), siteScript, claims: { allowPrivate: true }, mcp: (r) => hostedMcp({ registry: r, version: 'test', browser: async () => browser, allowPrivate: true, fallback: { chat, model: 'muse-spark-1.3', logDir: null } }) });
  site = await startMockSite({ registry: registry.url, register: async (o) => (await registerSite(registry, o)).site_key });
  await seed(registry.registry, 'mock-site', site.url);
  // The same, with no model: details can't be read.
  bare = await startRegistry({ storage: await testStorage(join(dir, 'b')), claims: { allowPrivate: true }, mcp: (r) => hostedMcp({ registry: r, version: 'test', browser: async () => browser, allowPrivate: true }) });
});
after(async () => {
  for (const c of open) await c.close().catch(() => undefined);
  await registry.close();
  await bare.close();
  await site.stop();
  await browser.close();
  await rm(dir, { recursive: true });
});

async function connect(r = registry): Promise<Client> {
  const client = new Client({ name: 'natural-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${r.url}/mcp`)));
  open.push(client);
  return client;
}
type Reply = { status: string; id: string; decisions?: { kind: string; key: string; label: string }[]; actions_so_far?: number; read_from_details?: string[]; reason?: string; message?: string; actions?: { action: string; key: string }[]; elapsed_ms?: number };
const fill = async (client: Client, args: Record<string, unknown>) => {
  const started = performance.now();
  const result = await client.callTool({ name: 'usher_fill', arguments: args });
  return { result, reply: result.structuredContent as Reply, ms: Math.round(performance.now() - started) };
};
const decisionSet = (r: Reply) => r.decisions!.map((d) => `${d.kind}:${d.key}:${d.label}`);

test('the server routes an assistant with a browser to the plan, names its mapped sites, and keeps usher_fill as the fallback', async () => {
  const instructions = (await connect()).getInstructions() ?? '';
  assert.ok(instructions.includes(`- Brightwater Insurance (${new URL(site.url).host}): health insurance quote, car insurance quote.`), instructions);
  assert.match(instructions, /^Usher gives you the plan and the rules for a web form; you drive your own browser\. Call get_plan/);
  assert.match(instructions, /prepare_run/);
  assert.match(instructions, /stop at every stop for your user/);
  assert.match(instructions, /only if you cannot drive a browser, use usher_fill instead/);
});

test('the details mapper: one optional key per field, options as their values, dates as YYYY-MM-DD; it reads the prose by key', async () => {
  const maps = await seedMaps('mock-site');
  const plan = composePlan('/quote/driver', new Map(maps.map((m) => [m.path, m])))!;
  const schema = detailsSchema(detailInputs(plan)) as { required: string[]; properties: Record<string, { anyOf: { type: string; enum?: string[]; description?: string }[] }> };
  assert.ok(!schema.required.some((k) => k.startsWith('consent.')), 'never the person\'s own consents');
  assert.deepEqual(schema.properties['policy.payment_frequency']!.anyOf[0]!.enum, ['annually', 'monthly']);
  assert.equal(schema.properties['person.dob']!.anyOf[0]!.description, 'A date as YYYY-MM-DD');
  assert.deepEqual(schema.properties['person.first_name']!.anyOf[1], { type: 'null' });
  const { values: read } = await mapDetails(chat, 'muse-spark-1.3', plan, NATURAL, { logDir: null, given: () => true });
  for (const [k, v] of Object.entries(read)) assert.equal(v, String(values[k]), k);
  assert.equal(Object.keys(read).length, 21);
  for (const k of ['vehicle.make', 'vehicle.model', 'vehicle.year']) assert.ok(!(k in read), `${k}: the site's lookup fills it`);
});

test('the natural prompt and the keyed prompt reach the same decision set; make, model and year from the lookup', async () => {
  const client = await connect();
  const natural = await fill(client, { site: 'Brightwater', task: 'car insurance quote', details: NATURAL });
  assert.equal(natural.reply.status, 'needs_decision', JSON.stringify(natural.reply).slice(0, 400));
  assert.equal(natural.reply.read_from_details!.length, 21);
  const keyed = await fill(await connect(), { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values });
  assert.equal(keyed.reply.status, 'needs_decision');
  assert.deepEqual(decisionSet(natural.reply), decisionSet(keyed.reply));
  assert.deepEqual(decisionSet(natural.reply).map((d) => d.split(':').slice(0, 2).join(':')), ['required_consent:consent.declaration', 'optional_consent:consent.marketing', 'submit:form.submit']);
  console.log(`  natural prompt: decision set in ${natural.ms} ms; keyed prompt: ${keyed.ms} ms`);
  // Through to the end, to see what was filled and how.
  const done = (await client.callTool({ name: 'usher_confirm', arguments: { id: natural.reply.id, confirmation: 'Confirm: declaration yes, marketing no, get my quote yes' } })).structuredContent as Reply;
  assert.equal(done.status, 'completed', done.reason);
  const taken = done.actions!.map((a) => `${a.action}:${a.key}`);
  assert.ok(taken.includes('fill:vehicle.registration') && taken.includes('press:lookup.vehicle'), 'the lookup ran');
  for (const k of ['vehicle.make', 'vehicle.model', 'vehicle.year']) assert.ok(!taken.includes(`fill:${k}`), `${k} left as the lookup filled it`);
  for (const k of ['person.first_name', 'person.dob', 'vehicle.annual_mileage', 'policy.voluntary_excess', 'policy.payment_frequency']) assert.ok(taken.some((t) => t.endsWith(`:${k}`)), k);
});

test('layout B too: the lookup runs, and the same decisions come back', async () => {
  await site.setLayout('b');
  try {
    const { reply } = await fill(await connect(), { site: 'Brightwater', task: 'car insurance quote', details: NATURAL });
    assert.equal(reply.status, 'needs_decision', JSON.stringify(reply).slice(0, 400));
    assert.deepEqual(reply.decisions!.map((d) => `${d.kind}:${d.key}`), ['required_consent:consent.declaration', 'optional_consent:consent.marketing', 'submit:form.submit']);
    const done = (await (open.at(-1)!).callTool({ name: 'usher_confirm', arguments: { id: reply.id, confirmation: 'Confirm: declaration yes, marketing no, get my quote yes' } })).structuredContent as Reply;
    const taken = done.actions!.map((a) => `${a.action}:${a.key}`);
    assert.ok(taken.includes('press:lookup.vehicle'), taken.join(' '));
    assert.ok(!taken.includes('fill:vehicle.make'));
  } finally {
    await site.setLayout('a');
  }
});

test('without a model, details are refused, pointing at values', async () => {
  const result = await (await connect(bare)).callTool({ name: 'usher_fill', arguments: { site: 'Brightwater', task: 'car insurance quote', details: NATURAL } });
  assert.equal(result.isError, true);
  assert.match((result.content as { text: string }[])[0]!.text, /needs Muse Spark on this server \(MODEL_API_KEY\)\. Pass them by Usher key in values instead\./);
});

test('Brightwater Health: the plain prompt and the keyed one reach the same decision set; the smoker answer comes back to confirm, the declaration word for word', async () => {
  const health = JSON.parse(await readFile(new URL('../../agent/profiles/test-health.json', import.meta.url), 'utf8')) as Record<string, string | boolean>;
  const { _comment: _c, 'consent.declaration': _d2, ...keyed } = health;
  const plain = await fill(await connect(), { site: 'Brightwater', task: 'health insurance quote', details: NATURAL_HEALTH });
  assert.equal(plain.reply.status, 'needs_decision', JSON.stringify(plain.reply).slice(0, 400));
  const byKey = await fill(await connect(), { site: 'Brightwater', task: 'PMI', values: keyed });
  assert.equal(byKey.reply.status, 'needs_decision', JSON.stringify(byKey.reply).slice(0, 400));
  assert.deepEqual(decisionSet(plain.reply), decisionSet(byKey.reply));
  // One card: the smoker answer as they said it, the declaration as the site words it, then the submit.
  assert.deepEqual(plain.reply.decisions!.map((d) => `${d.kind}:${d.key}`), ['confirm_value:person.smoker', 'required_consent:consent.declaration', 'submit:form.submit']);
  assert.equal((plain.reply.decisions![0] as { value?: string }).value, 'No');
  const blocks = (plain.result.structuredContent as { blocks: { kind: string; text: string; verbatim: boolean; source: { key?: string } }[] }).blocks;
  const declaration = blocks.find((b) => b.source.key === 'consent.declaration' && b.kind === 'consent');
  assert.deepEqual([declaration?.verbatim, declaration?.text], [true, 'I confirm the information I have given is true and complete, and I understand that my medical history will be asked about after the quote']);
  assert.ok(blocks.some((b) => b.kind === 'disclosure' && b.verbatim && /Medical history is not asked here/.test(b.text)), 'the text by Get my quote, verbatim');
  assert.match(String((plain.result.content as { text: string }[])[0]!.text), /Confirm: “Have you smoked or used nicotine products in the last 12 months\?” They said: “No”\. Is that right\?/);
  // No medical question anywhere in the journey, and nothing read for one.
  assert.ok(!plain.reply.read_from_details!.some((k) => k.startsWith('health.')));
  // Through to the quote.
  const done = (await (open.at(-2)!).callTool({ name: 'usher_confirm', arguments: { id: plain.reply.id, confirmation: 'Confirm: smoker yes, declaration yes, get my quote yes' } })).structuredContent as Reply & { result?: { facts: string[] } };
  assert.equal(done.status, 'completed', done.reason);
  assert.ok(done.result!.facts.some((f) => /a month/.test(f)), done.result!.facts.join(' | '));
  const taken = done.actions!.map((a) => `${a.action}:${a.key}`);
  assert.ok(taken.includes('press:lookup.address'), 'the address from the site\'s own lookup');
  assert.ok(taken.includes('handoff:person.smoker'), 'the smoker answer entered as theirs');
  console.log(`  health, plain prompt: decision set in ${plain.ms} ms; keyed: ${byKey.ms} ms`);
});

test('Brightwater Health: a smoker answer the person says isn\'t right stops the fill before anything is submitted', async () => {
  const client = await connect();
  const { reply } = await fill(client, { site: 'Brightwater', task: 'medical insurance', details: NATURAL_HEALTH });
  assert.equal(reply.status, 'needs_decision');
  const done = (await client.callTool({ name: 'usher_confirm', arguments: { id: reply.id, confirmation: 'Confirm: smoker no, declaration yes, get my quote yes' } })).structuredContent as Reply;
  assert.equal(done.status, 'stopped');
  assert.match(done.reason!, /isn't their answer to "Have you smoked/);
  assert.ok(!done.actions!.some((a) => a.key === 'form.submit'), 'nothing submitted');
});

test('Brightwater Health: with only a postcode, the person chooses from the lookup\'s list of addresses', async () => {
  const health = JSON.parse(await readFile(new URL('../../agent/profiles/test-health.json', import.meta.url), 'utf8')) as Record<string, string | boolean>;
  const { _comment: _c, 'consent.declaration': _d2, 'address.line1': _l, ...keyed } = health;
  const client = await connect();
  const { reply } = await fill(client, { site: 'Brightwater', task: 'health insurance quote', values: keyed });
  assert.equal(reply.status, 'needs_decision', JSON.stringify(reply).slice(0, 400));
  const address = reply.decisions!.find((d) => d.key === 'address.line1') as { kind: string; label: string; options?: string[] } | undefined;
  assert.equal(address?.kind, 'missing_value');
  assert.equal(address?.label, 'Please select an address');
  assert.deepEqual(address?.options, ['1 High Street', '2 High Street', '11 High Street', 'Flat 1, 1 High Street', 'The Old Forge, High Street'].map((l) => `${l}, Malvern, WR14 1AA`));
  const next = (await client.callTool({ name: 'usher_confirm', arguments: { id: reply.id, confirmation: 'Confirm: line1 "2 High Street", smoker yes, declaration yes, get my quote yes' } })).structuredContent as Reply;
  const done = next.status === 'needs_decision' ? ((await client.callTool({ name: 'usher_confirm', arguments: { id: next.id, confirmation: 'Confirm: smoker yes, declaration yes, get my quote yes' } })).structuredContent as Reply) : next;
  assert.equal(done.status, 'completed', done.reason);
  assert.ok(done.actions!.some((a) => a.action === 'fill' && a.key === 'address.line1'), 'the address chosen from the list');
});
