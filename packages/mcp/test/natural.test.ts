// A normal prompt is enough: through the hosted server, as a client would call it, the site and the
// task in the person's words and their details as prose reach the same decision set as the keyed
// prompt, with every value filled and make, model and year from the site's own lookup, in both of
// Brightwater's layouts. The details are read by Muse Spark, replayed from a recording.

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
import { NATURAL } from './natural.ts';

const profile = JSON.parse(await readFile(new URL('../../agent/profiles/test-driver.json', import.meta.url), 'utf8')) as Record<string, string | boolean>;
const { _comment: _, 'consent.declaration': _d, 'consent.marketing': _m, ...values } = profile;
const details = JSON.parse(await readFile(new URL('./fixtures/details/natural.json', import.meta.url), 'utf8')) as LabelFixture;
// Layout B's pages have no map in this registry: the model reads them, from recordings.
const labels = await Promise.all((['a', 'b'] as const).flatMap((l) => (['driver', 'vehicle', 'cover'] as const).map((s) => readFixture(l, s))));
const chat = replayAny([details, ...labels]);

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

test('the server says which sites it acts on, and that it pauses for the person by default', async () => {
  const instructions = (await connect()).getInstructions() ?? '';
  assert.ok(instructions.includes(`- Brightwater Motor (${new URL(site.url).host}): car insurance quote.`), instructions);
  assert.match(instructions, /pauses for the person at every consent and before anything is submitted, by default: the person never has to ask for that/);
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
