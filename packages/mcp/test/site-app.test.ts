// Site apps (LU-57): /mcp/<host> is the hosted server scoped to one joined site with its app
// switched on. Its tools are generated from the site's plans (named from the intent, parameters
// from ask_first with the site's labels and options); the generic tools are not there; a
// connection opened on one endpoint never reaches another; and an assistant with only Brightwater's
// endpoint gets a health quote from a plain sentence, through the usual pause and usher_confirm.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium, type Browser } from 'playwright';
import { seed, startRegistry, type RunningRegistry } from '@usher/registry';
import { replayAny, type LabelFixture } from '../../core/test/replay.ts';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { registerSite } from '../../registry/test/sites.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';
import { hostedMcp } from '../src/hosted.ts';
import { toolNameFor } from '../src/site-app.ts';
import { NATURAL_HEALTH } from './natural.ts';

const healthDetails = JSON.parse(await readFile(new URL('./fixtures/details/natural-health.json', import.meta.url), 'utf8')) as LabelFixture;

let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let browser: Browser;
const open: Client[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-site-app-'));
  browser = await chromium.launch();
  const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
  registry = await startRegistry({ storage: await testStorage(dir), siteScript, claims: { allowPrivate: true }, mcp: (r) => hostedMcp({ registry: r, version: 'test', browser: async () => browser, allowPrivate: true, fallback: { chat: replayAny([healthDetails]), model: 'muse-spark-1.3', logDir: null } }) });
  site = await startMockSite({ registry: registry.url, register: async (o) => (await registerSite(registry, o)).site_key });
  await seed(registry.registry, 'mock-site', site.url);
});
after(async () => {
  for (const c of open) await c.close().catch(() => undefined);
  await registry.close();
  await site.stop();
  await browser.close();
  await rm(dir, { recursive: true });
});

const endpoint = (host = new URL(site.url).host) => `${registry.url}/mcp/${host}`;
async function connect(url = endpoint()): Promise<Client> {
  const client = new Client({ name: 'site-app-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  open.push(client);
  return client;
}

test('tool names from intents', () => {
  assert.equal(toolNameFor('quote.health_insurance'), 'get_health_insurance_quote');
  assert.equal(toolNameFor('quote.car_insurance'), 'get_car_insurance_quote');
  assert.equal(toolNameFor('contact.callback'), 'request_callback');
  assert.equal(toolNameFor('apply.credit-card'), 'apply_for_credit_card');
});

test('Brightwater\'s app: its own tools, generated from its plans; none of the generic ones', async () => {
  const client = await connect();
  assert.match(client.getServerVersion()?.name ?? '', /^Brightwater Insurance \(via Usher\)$/);
  assert.match(client.getInstructions() ?? '', /^This is Brightwater Insurance's assistant app, run by Usher under Brightwater Insurance's rules\./);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), ['get_car_insurance_quote', 'get_health_insurance_quote', 'usher_cancel', 'usher_confirm']);
  const health = tools.find((t) => t.name === 'get_health_insurance_quote')!;
  assert.match(health.description!, /from Brightwater Insurance/);
  assert.match(health.description!, /Runs under Brightwater Insurance's rules: Assistants may fill the quote\./);
  // The schema, generated: by semantic key, the site's labels, its options as enums.
  const props = health.inputSchema.properties as Record<string, { type?: string; enum?: string[]; description?: string }>;
  assert.deepEqual(Object.keys(props).sort(), [
    'address_postcode', 'contact_email', 'cover_excess', 'cover_hospital_list', 'cover_level', 'cover_outpatient_limit', 'cover_who', 'details',
    'person_dob', 'person_first_name', 'person_last_name', 'person_smoker', 'person_title', 'policy_payment_frequency', 'policy_start_date',
  ]);
  assert.deepEqual(props.cover_level!.enum, ['Core', 'Standard', 'Comprehensive']);
  assert.deepEqual(props.person_title!.enum, ['Mr', 'Mrs', 'Miss', 'Ms', 'Mx', 'Dr']);
  assert.match(props.person_dob!.description!, /^Day of birth As a date: 1988-03-14, 14\/03\/1988 or 14 March 1988\.$/);
  assert.match(props.person_smoker!.description!, /Their own answer/);
  assert.equal((health.inputSchema.required ?? []).length, 0, 'nothing required: what is missing is asked');
  assert.ok(health._meta, 'renders as Usher\'s card');
});

test('an assistant with only Brightwater\'s endpoint gets a health quote from a plain sentence', async () => {
  const client = await connect();
  const first = (await client.callTool({ name: 'get_health_insurance_quote', arguments: { details: NATURAL_HEALTH } })).structuredContent as { status: string; id: string; decisions: { kind: string; key: string }[] };
  assert.equal(first.status, 'needs_decision', JSON.stringify(first).slice(0, 400));
  assert.deepEqual(first.decisions.map((d) => `${d.kind}:${d.key}`), ['confirm_value:person.smoker', 'required_consent:consent.declaration', 'submit:form.submit']);
  const done = (await client.callTool({ name: 'usher_confirm', arguments: { id: first.id, confirmation: 'Confirm: smoker yes, declaration yes, get my quote yes' } })).structuredContent as { status: string; reason?: string; result?: { facts: string[] } };
  assert.equal(done.status, 'completed', done.reason);
  assert.ok(done.result!.facts.some((f) => /a month/.test(f)), done.result!.facts.join(' | '));
  const usage = await registry.registry.siteAppUsage(site.url);
  assert.ok(usage.connections >= 1 && usage.fills >= 1, JSON.stringify(usage));
});

test('isolation: a connection belongs to its endpoint; a site without an app, or one switched off, has none', async () => {
  // A session opened on Brightwater's app is unknown to the general endpoint, and the other way round.
  const app = new StreamableHTTPClientTransport(new URL(endpoint()));
  const appClient = new Client({ name: 'iso', version: '0' });
  await appClient.connect(app);
  open.push(appClient);
  const call = (url: string, sid: string) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': sid, 'Mcp-Protocol-Version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal((await call(`${registry.url}/mcp`, app.sessionId!)).status, 404, 'the app\'s session on the general endpoint');
  assert.equal((await call(endpoint('other.example'), app.sessionId!)).status, 404, 'the app\'s session on another site\'s endpoint');
  assert.equal((await call(endpoint(), app.sessionId!)).status, 200, 'and on its own');
  // A site that hasn't joined has no app; nor does a joined one that switched it off.
  await assert.rejects(() => connect(endpoint('unjoined.example')));
  await registry.registry.setSiteApp(site.url, { enabled: false });
  try {
    await assert.rejects(() => connect());
    assert.equal((await call(endpoint(), app.sessionId!)).status, 404, 'an open connection stops too');
  } finally {
    await registry.registry.setSiteApp(site.url, { enabled: true });
  }
});

test('the owner renames, hides and describes each tool', async () => {
  await registry.registry.setSiteApp(site.url, { enabled: true, tools: { 'quote.car_insurance': { hidden: true }, 'quote.health_insurance': { name: 'brightwater_health_quote', description: 'A health insurance quote from Brightwater, the demo insurer.' } } });
  try {
    const tools = (await (await connect()).listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ['brightwater_health_quote', 'usher_cancel', 'usher_confirm']);
    assert.match(tools.find((t) => t.name === 'brightwater_health_quote')!.description!, /^A health insurance quote from Brightwater, the demo insurer\. Give what the person has told you/);
  } finally {
    await registry.registry.setSiteApp(site.url, { enabled: true });
  }
});
