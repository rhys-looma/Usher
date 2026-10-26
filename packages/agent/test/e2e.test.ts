// End to end on the mock site: an unknocked API call is refused; the agent knocks, binds, fills
// all three steps, pauses at "Get my quote", confirms and gets a quote; the log shows every
// action by semantic key; a second run with the maps is faster; layout B is reported as drift.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { compilerModel, knockSchemaErrors, modelApi } from '@usher/core';
import { FileStorage, startRegistry, type RunningRegistry, type Session } from '@usher/registry';
import { readFixture, replayAny } from '../../core/test/replay.ts';
import { loadDotEnv } from '../../core/src/compile/env.ts';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { httpTransport, mcpTransport, runAgent, scriptedUser, summaryLine, type Profile, type RunResult } from '../src/index.ts';

const profile = JSON.parse(await readFile(new URL('../profiles/test-driver.json', import.meta.url), 'utf8')) as Profile;
const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
const fixtures = await Promise.all((['a', 'b'] as const).flatMap((l) => (['driver', 'vehicle', 'cover'] as const).map((s) => readFixture(l, s))));
const replay = { chat: replayAny(fixtures, { simulateLatency: true }), model: 'muse-spark-1.3', logDir: null };

let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let browser: Browser;
const runs: Record<string, RunResult> = {};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-e2e-'));
  registry = await startRegistry({ storage: new FileStorage(join(dir, 'registry')), siteScript });
  site = await startMockSite({ registry: registry.url });
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await site.stop();
  await registry.close();
  await rm(dir, { recursive: true });
  const lines = Object.entries(runs).map(([name, r]) => `  ${name.padEnd(28)} ${summaryLine(r)}`);
  if (lines.length) console.log(['', 'end-to-end runs', ...lines, ''].join('\n'));
});

const keyFile = () => join(dir, 'agent-key.json');
const session = async (sid: string): Promise<Session> => (await fetch(`${registry.url}/sessions/${sid}`)).json() as Promise<Session>;

test('an agent that did not knock gets 403 knock_required from the API', async () => {
  const res = await fetch(`${site.url}/api/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Usher-Agent': 'unknocked' }, body: '{}' });
  assert.equal(res.status, 403);
  assert.match(res.headers.get('link') ?? '', /rel="usher-knock"/);
  const body = await res.json();
  assert.equal(knockSchemaErrors('knockRequired', body), null);
  assert.equal(body.knock_url, `${registry.url}/knock`);
});

test('run 1, no maps yet: the agent reads each page with Muse Spark, completes the quote and shares the maps', async () => {
  const user = scriptedUser(profile);
  const transport = await httpTransport(registry.url, keyFile());
  const run = await runAgent({ browser, url: `${site.url}/quote/driver`, profile, intent: 'quote.car_insurance', registry: transport, user, fallback: replay });
  await transport.close();
  runs['run 1 (no map, http)'] = run;
  assert.equal(run.outcome, 'completed', run.reason);
  assert.match(run.final_url, /\/quote\/result$/);
  assert.deepEqual(run.pages.map((p) => [p.path, p.match, p.map_source]), [
    ['/quote/driver', 'none', 'compiled'],
    ['/quote/vehicle', 'none', 'compiled'],
    ['/quote/cover', 'none', 'compiled'],
  ]);
  assert.equal(run.maps_submitted, 3);
  assert.ok(run.usage.prompt_tokens > 10_000);
  assert.deepEqual(user.confirmations, ['form.submit'], 'paused once, at Get my quote');
  assert.deepEqual(user.handoffs, ['consent.declaration', 'consent.marketing'], 'needs_user left to the user');

  // The session shows every action by semantic key, and no values.
  const log = await session(run.session!);
  const actions = log.events.map((e) => `${e.source}:${e.action}${e.key ? `:${e.key}` : ''}`);
  console.log(`session ${run.session}: ${actions.join(', ')}`);
  for (const key of ['person.first_name', 'person.dob', 'address.postcode', 'vehicle.registration', 'vehicle.annual_mileage', 'policy.start_date']) {
    assert.ok(actions.includes(`site:fill:${key}`), `${key} logged`);
  }
  for (const key of ['person.title', 'person.occupation', 'policy.voluntary_excess']) assert.ok(actions.includes(`site:select:${key}`), key);
  for (const key of ['person.employment_status', 'person.claims.has_any', 'vehicle.use', 'policy.cover_level']) assert.ok(actions.includes(`site:choose:${key}`), key);
  assert.equal(actions.filter((a) => a === 'registry:knock').length, 3);
  assert.ok(actions.includes('site:handoff:consent.declaration') && actions.includes('site:check:consent.declaration'));
  // The agent asked its user, told the page, then submitted.
  assert.deepEqual(actions.slice(-3), ['site:confirm:form.submit', 'site:submit:form.submit', 'agent:run']);
  assert.ok(!actions.some((a) => a.includes('person.claims.date')), 'conditional claim fields skipped');
  const json = JSON.stringify(log);
  for (const value of ['Sam', 'Taylor', 'sam@example.com', 'WR14 1AA', 'AB12CDE', '1988-04-02', '07700 900123', '1 High Street']) assert.ok(!json.includes(value), `log holds ${value}`);
});

test('run 2, with the maps: exact matches over MCP, no model, and faster', async () => {
  const user = scriptedUser(profile);
  const transport = await mcpTransport(registry.url, keyFile());
  const run = await runAgent({ browser, url: `${site.url}/quote/driver`, profile, intent: 'quote.car_insurance', registry: transport, user, fallback: replay });
  await transport.close();
  runs['run 2 (with map, mcp)'] = run;
  assert.equal(run.outcome, 'completed', run.reason);
  assert.equal(run.transport, 'mcp');
  assert.deepEqual(run.pages.map((p) => [p.match, p.map_source]), [['exact', 'registry'], ['exact', 'registry'], ['exact', 'registry']]);
  assert.equal(run.model_ms, 0);
  assert.equal(run.usage.total_tokens, 0);
  assert.ok(run.total_ms < runs['run 1 (no map, http)']!.total_ms, `${run.total_ms} ms vs ${runs['run 1 (no map, http)']!.total_ms} ms`);
});

test('layout B: the site script reports drift, the registry marks the maps, the agent re-reads and completes', async () => {
  await site.setLayout('b');
  try {
    const transport = await httpTransport(registry.url, keyFile());
    const run = await runAgent({ browser, url: `${site.url}/quote/driver`, profile, intent: 'quote.car_insurance', registry: transport, user: scriptedUser(profile), fallback: replay });
    await transport.close();
    runs['run 3 (layout B, drifted)'] = run;
    assert.equal(run.outcome, 'completed', run.reason);
    assert.deepEqual(run.pages.map((p) => p.match), ['path', 'near', 'near']);
    assert.ok(run.pages.every((p) => p.map_source === 'compiled'));

    const records = await registry.registry.storage.mapsForOrigin(site.url);
    const a = records.filter((r) => r.drift);
    assert.equal(a.length, 3, 'the three layout A maps are marked drifted');
    assert.equal(records.length, 6, 'layout B maps were shared too');
    const scores = (await registry.registry.storage.readLog('drift')) as { path: string; score: number }[];
    console.log(`drift scores: ${scores.map((s) => `${s.path} ${s.score}`).join(', ')}`);
  } finally {
    await site.setLayout('a');
  }
});

test('the match log holds every lookup with its scores', async () => {
  const log = (await registry.registry.storage.readLog('matches')) as { via: string; path: string; kind: string; score: number; scores: { path: string; score: number }[] }[];
  const lines = log.map((m) => `${m.via.padEnd(6)} ${m.path.padEnd(14)} ${m.kind.padEnd(5)} best ${m.score.toFixed(3)}  [${m.scores.map((s) => `${s.path} ${s.score}`).join(', ')}]`);
  console.log(['', 'match log', ...lines.map((l) => `  ${l}`), ''].join('\n'));
  assert.ok(log.length >= 12);
});

test('live: Muse Spark as the fallback model on step 1', { skip: process.env.USHER_LIVE !== '1' && 'set USHER_LIVE=1 to call the model API' }, async () => {
  loadDotEnv();
  const live = await mkdtemp(join(tmpdir(), 'usher-e2e-live-'));
  const fresh = await startRegistry({ storage: new FileStorage(live), siteScript });
  const liveSite = await startMockSite({ registry: fresh.url });
  try {
    const transport = await httpTransport(fresh.url, keyFile());
    const run = await runAgent({ browser, url: `${liveSite.url}/quote/driver`, profile, intent: 'quote.car_insurance', registry: transport, user: scriptedUser(profile), fallback: { chat: modelApi(), model: compilerModel() } });
    await transport.close();
    runs['live run (no map, http)'] = run;
    assert.equal(run.outcome, 'completed', run.reason);
  } finally {
    await liveSite.stop();
    await fresh.close();
    await rm(live, { recursive: true });
  }
});
