// "Usher fills the form and forgets it", checked: through the hosted server, a completed, a
// cancelled and a timed-out usher_fill on Brightwater Health (keyed values and details in the
// person's words) leave none of the person's values in any file the registry writes (its store and
// the model log), in what the process prints, or, with DATABASE_URL, in any Postgres table. The
// session record holds keys and decisions only. Run against both stores: npm test, and
// DATABASE_URL=… npm test.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium, type Browser } from 'playwright';
import { seed, startRegistry, type RunningRegistry } from '@usher/registry';
import { readFixture, replayAny, type LabelFixture } from '../../core/test/replay.ts';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { registerSite } from '../../registry/test/sites.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';
import { hostedMcp } from '../src/hosted.ts';
import { NATURAL_HEALTH } from './natural.ts';

// Values no page, map or fixture holds, so finding one anywhere means it was kept.
const values = {
  'person.title': 'mr',
  'person.first_name': 'Quillon',
  'person.last_name': 'Vexmore',
  'person.dob': '1979-03-17',
  'address.postcode': 'WR14 1AA',
  'address.line1': '11 High Street',
  'contact.email': 'quillon.vexmore@example.org',
  'contact.phone': '07700 900456',
  'cover.who': 'just-me',
  'person.smoker': 'no',
  'cover.level': 'standard',
  'cover.excess': '500',
  'cover.hospital_list': 'local',
  'cover.outpatient_limit': '1500',
  'policy.start_date': '2026-12-14',
  'policy.payment_frequency': 'annually',
};
const NEEDLES = ['Quillon', 'Vexmore', 'quillon.vexmore', '900456', '1979-03-17', '17/03/1979', '2026-12-14', '14/12/2026', 'Sam Taylor', 'sam@example.com', '900123', '1988-04-02', '02/04/1988', '01/12/2026', 'non-smoker'];
const DECISION_MS = 1500;

const details = JSON.parse(await readFile(new URL('./fixtures/details/natural-health.json', import.meta.url), 'utf8')) as LabelFixture;
const chat = replayAny([details, ...(await Promise.all((['health-about', 'health-cover', 'health-declaration'] as const).map((s) => readFixture('a', s))))]);

let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let browser: Browser;
const open: Client[] = [];
let printed = '';
const writes = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-forget-'));
  browser = await chromium.launch();
  // Everything the process prints from here on, to search.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => ((printed += String(chunk)), writes.out(chunk, ...rest))) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => ((printed += String(chunk)), writes.err(chunk, ...rest))) as typeof process.stderr.write;
  const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
  registry = await startRegistry({
    storage: await testStorage(join(dir, 'registry')),
    siteScript,
    claims: { allowPrivate: true },
    mcp: (r) => hostedMcp({ registry: r, version: 'test', browser: async () => browser, allowPrivate: true, timeouts: { decisionMs: DECISION_MS }, fallback: { chat, model: 'muse-spark-1.3', logDir: join(dir, 'compiler-log') } }),
  });
  site = await startMockSite({ registry: registry.url, register: async (o) => (await registerSite(registry, o)).site_key });
  await seed(registry.registry, 'mock-site', site.url);
});
after(async () => {
  process.stdout.write = writes.out;
  process.stderr.write = writes.err;
  for (const c of open) await c.close().catch(() => undefined);
  await registry.close();
  await site.stop();
  await browser.close();
  await rm(dir, { recursive: true });
});

async function connect(): Promise<Client> {
  const client = new Client({ name: 'forget-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${registry.url}/mcp`)));
  open.push(client);
  return client;
}
type Reply = { status: string; id: string; decisions?: { kind: string; key: string; value?: string }[]; session?: string; reason?: string };
const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as { structuredContent?: Reply; isError?: boolean; content: { type: string; text?: string }[] };

async function filesUnder(path: string): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else out.push({ path: full, text: await readFile(full, 'utf8') });
  }
  return out;
}

/** Every row of every table in this test's Postgres schema, as JSON text. */
async function tables(): Promise<{ path: string; text: string }[]> {
  if (!process.env.DATABASE_URL) return [];
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const schema = `t_${createHash('sha256').update(join(dir, 'registry')).digest('hex').slice(0, 16)}`;
    const names = (await client.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [schema])).rows.map((r: { table_name: string }) => r.table_name);
    const out: { path: string; text: string }[] = [];
    for (const t of names) {
      const rows = (await client.query(`SELECT row_to_json(x)::text AS j FROM "${schema}"."${t}" x`)).rows as { j: string }[];
      out.push({ path: `postgres:${schema}.${t}`, text: rows.map((r) => r.j).join('\n') });
    }
    return out;
  } finally {
    await client.end();
  }
}

test('a completed fill: keyed values, the smoker answer confirmed, quote got', async () => {
  const client = await connect();
  const first = (await call(client, 'usher_fill', { site: 'Brightwater', task: 'health insurance quote', values })).structuredContent!;
  assert.equal(first.status, 'needs_decision', JSON.stringify(first).slice(0, 300));
  const smoker = first.decisions!.find((d) => d.key === 'person.smoker');
  assert.equal(smoker?.kind, 'confirm_value', 'put back to the person to confirm');
  assert.equal(smoker?.value, 'No');
  const done = (await call(client, 'usher_confirm', { id: first.id, confirmation: 'Confirm: smoker yes, declaration yes, get my quote yes' })).structuredContent!;
  assert.equal(done.status, 'completed', done.reason);
});

test('a completed fill from the person\'s own words', async () => {
  const client = await connect();
  const first = (await call(client, 'usher_fill', { site: 'Brightwater', task: 'health insurance quote', details: NATURAL_HEALTH })).structuredContent!;
  assert.equal(first.status, 'needs_decision', JSON.stringify(first).slice(0, 300));
  const done = (await call(client, 'usher_confirm', { id: first.id, confirmation: 'Confirm: smoker yes, declaration yes, get my quote yes' })).structuredContent!;
  assert.equal(done.status, 'completed', done.reason);
});

test('a cancelled fill', async () => {
  const client = await connect();
  const first = (await call(client, 'usher_fill', { site: 'Brightwater', task: 'PMI', values })).structuredContent!;
  assert.equal(first.status, 'needs_decision');
  assert.equal((await call(client, 'usher_cancel', { id: first.id })).structuredContent!.status, 'cancelled');
  assert.match((await call(client, 'usher_confirm', { id: first.id, confirmation: 'Confirm: smoker yes' })).content[0]!.text!, /Nothing is waiting/);
});

test('a fill left waiting times out, and its job is gone', async () => {
  const client = await connect();
  const first = (await call(client, 'usher_fill', { site: 'Brightwater', task: 'medical insurance', values })).structuredContent!;
  assert.equal(first.status, 'needs_decision');
  await new Promise((r) => setTimeout(r, DECISION_MS + 1000));
  assert.match((await call(client, 'usher_confirm', { id: first.id, confirmation: 'Confirm: smoker yes, declaration yes, get my quote yes' })).content[0]!.text!, /Nothing is waiting/);
});

test('none of it is kept: no value in the store, the model log, the printed output or the database', async () => {
  // Let the last session events land.
  await new Promise((r) => setTimeout(r, 500));
  const rows = await tables();
  const sources = [...(await filesUnder(dir)), ...rows, { path: 'process output', text: printed }];
  // With Postgres, the sessions are rows: the scan must have found them.
  if (process.env.DATABASE_URL) assert.ok(rows.some((r) => r.text.includes('"person.first_name"')), `the session rows were read (${rows.map((r) => r.path).join(', ')})`);
  const kept = sources.flatMap((s) => NEEDLES.filter((n) => s.text.includes(n)).map((n) => `${n} in ${s.path}`));
  assert.deepEqual(kept, []);
  // What is kept: the sessions, by key, and the model log of the details read (keys, not values).
  const all = sources.map((s) => s.text).join('\n');
  assert.ok(all.includes('person.first_name'), 'the session log names the fields filled');
  assert.ok((await filesUnder(join(dir, 'compiler-log'))).some((f) => f.text.includes('"task":"details"')), 'the details read was logged, by key');
  console.log(`  searched ${sources.length} sources (${process.env.DATABASE_URL ? `Postgres, ${rows.length} tables` : 'file store'}): no value kept`);
});
