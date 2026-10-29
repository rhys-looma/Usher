// End to end on the mock site. An unknocked API call is refused. Agent A (Muse Spark) finds no
// maps, reads each page, completes the quote and shares the maps; the log shows every action by
// semantic key. Agent C, with its own key, can't see them until verified: it builds its own, agrees
// and completes, which verifies them. Agent B (Muse Spark Open, its own key, over MCP) runs on them,
// faster. In layout B the site script reports drift and Agent B re-reads the pages with Spark Open.
// Brightwater Health completes in every layout: the smoker answer entered as the person gave it,
// the address from the site's lookup list, no medical question anywhere.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { compilerModel, knockSchemaErrors, modelApi, openModel } from '@usher/core';
import { startRegistry, type RunningRegistry, type Session } from '@usher/registry';
import { readFixture, replayAny } from '../../core/test/replay.ts';
import { loadDotEnv } from '../../core/src/compile/env.ts';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { registerSite, type SiteKeys } from '../../registry/test/sites.ts';
import { httpTransport, mcpTransport, runAgent, scriptedUser, summaryLine, type Profile, type RunResult } from '../src/index.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';

const profile = JSON.parse(await readFile(new URL('../profiles/test-driver.json', import.meta.url), 'utf8')) as Profile;
const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
const health = JSON.parse(await readFile(new URL('../profiles/test-health.json', import.meta.url), 'utf8')) as Profile;
const HEALTH = ['health-about', 'health-cover', 'health-declaration'] as const;
const recorded = (set: 'labels' | 'labels-open') =>
  Promise.all([
    ...(set === 'labels' ? (['a', 'b', 'c'] as const) : (['a', 'b'] as const)).flatMap((l) => (['driver', 'vehicle', 'cover'] as const).map((s) => readFixture(l, s, set))),
    // Brightwater Health: layout C is layout A, so A's recordings answer it.
    ...(['a', 'b'] as const).flatMap((l) => HEALTH.map((s) => readFixture(l, s, set))),
  ]);
// Recorded responses, replayed with the latency they had when recorded.
const spark = { chat: replayAny(await recorded('labels'), { simulateLatency: true }), model: 'muse-spark-1.3', logDir: null };
// Replayed under the model id the fixtures were recorded with (see OPEN_MODEL).
const openFixtures = await recorded('labels-open');
const sparkOpen = { chat: replayAny(openFixtures, { simulateLatency: true }), model: openFixtures[0]!.model, logDir: null };

let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let browser: Browser;
let keys: SiteKeys;
const runs: Record<string, RunResult> = {};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-e2e-'));
  registry = await startRegistry({ storage: await testStorage(join(dir, 'registry')), siteScript });
  site = await startMockSite({
    registry: registry.url,
    register: async (origin) => {
      keys = await registerSite(registry, origin);
      return keys.site_key;
    },
  });
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

const keyA = () => join(dir, 'agent-a-key.json');
const keyB = () => join(dir, 'agent-b-key.json');
const session = async (sid: string): Promise<Session> =>
  (await fetch(`${registry.url}/sessions/${sid}`, { headers: { Authorization: `Bearer ${keys.secret_key}` } })).json() as Promise<Session>;

test('an agent that did not knock gets 403 knock_required from the API', async () => {
  const res = await fetch(`${site.url}/api/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Usher-Agent': 'unknocked' }, body: '{}' });
  assert.equal(res.status, 403);
  assert.match(res.headers.get('link') ?? '', /rel="usher-knock"/);
  const body = await res.json();
  assert.equal(knockSchemaErrors('knockRequired', body), null);
  assert.equal(body.knock_url, `${registry.url}/knock`);
});

test('Agent A (Muse Spark), no maps yet: reads each page, completes the quote and shares the maps', async () => {
  const user = scriptedUser(profile);
  const transport = await httpTransport(registry.url, keyA());
  const run = await runAgent({ browser, url: `${site.url}/quote/driver`, profile, intent: 'quote.car_insurance', registry: transport, user, fallback: spark });
  await transport.close();
  runs['Agent A, Muse Spark, no map'] = run;
  assert.equal(run.outcome, 'completed', run.reason);
  assert.match(run.final_url, /\/quote\/result$/);
  assert.deepEqual(run.pages.map((p) => [p.path, p.match, p.map_source]), [
    ['/quote/driver', 'none', 'compiled'],
    ['/quote/vehicle', 'none', 'compiled'],
    ['/quote/cover', 'none', 'compiled'],
  ]);
  assert.equal(run.maps_submitted, 3);
  assert.ok(run.usage.prompt_tokens > 10_000);
  // The consents are the person's: shown to them and ticked only on their yes; then Get my quote.
  assert.deepEqual(user.confirmations, ['consent.declaration', 'consent.marketing', 'form.submit'], 'the person\'s yes for each consent and the submit');
  assert.deepEqual(user.handoffs, [], 'nothing taken out of the agent\'s hands');

  // The session shows every action by semantic key, and no values.
  const log = await session(run.session!);
  const actions = log.events.map((e) => `${e.source}:${e.action}${e.key ? `:${e.key}` : ''}`);
  console.log(`session ${run.session}: ${actions.join(', ')}`);

  // The shared maps carry the edges the agent learned by acting on them.
  const edges = (await registry.registry.storage.mapsForOrigin(site.url))
    .map((r) => [r.map.path, r.map.actions.find((a) => a.leads_to)?.leads_to ?? null])
    .sort();
  assert.deepEqual(edges, [['/quote/cover', '/quote/result'], ['/quote/driver', '/quote/vehicle'], ['/quote/vehicle', '/quote/cover']]);
  for (const key of ['person.first_name', 'person.dob', 'address.postcode', 'vehicle.registration', 'vehicle.annual_mileage', 'policy.start_date']) {
    assert.ok(actions.includes(`site:fill:${key}`), `${key} logged`);
  }
  for (const key of ['person.title', 'person.occupation', 'policy.voluntary_excess']) assert.ok(actions.includes(`site:select:${key}`), key);
  for (const key of ['person.employment_status', 'person.claims.has_any', 'vehicle.use', 'policy.cover_level']) assert.ok(actions.includes(`site:choose:${key}`), key);
  // One knock per page, and one more before "Get my quote", stating the user confirmed it.
  assert.equal(actions.filter((a) => a === 'registry:knock').length, 4);
  assert.equal(log.events.filter((e) => e.action === 'knock').at(-1)!.detail?.confirmed, 'form.submit');
  // The declaration ticked by the agent on the person's yes, not handed over.
  assert.ok(actions.includes('site:check:consent.declaration') && !actions.includes('site:handoff:consent.declaration'));
  // The agent asked its user, told the page, then submitted.
  assert.deepEqual(actions.slice(-3), ['site:confirm:form.submit', 'site:submit:form.submit', 'agent:run']);
  assert.ok(!actions.some((a) => a.includes('person.claims.date')), 'conditional claim fields skipped');
  const json = JSON.stringify(log);
  for (const value of ['Sam', 'Taylor', 'sam@example.com', 'WR14 1AA', 'AB12CDE', '1988-04-02', '07700 900123', '1 High Street']) assert.ok(!json.includes(value), `log holds ${value}`);
});

test('Agent C (Muse Spark, its own key) can\'t see A\'s unverified maps, builds its own, agrees and completes: the maps are verified', async () => {
  const user = scriptedUser(profile);
  const transport = await httpTransport(registry.url, join(dir, 'agent-c-key.json'));
  // Agent C is established: it has completed a run on another site before (simulated here).
  const elsewhere = await transport.knock({ url: 'http://elsewhere.example/contact', intent: 'contact.message' });
  await transport.reportRun({ session: elsewhere.session, url: 'http://elsewhere.example/contact', outcome: 'completed' });
  const run = await runAgent({ browser, url: `${site.url}/quote/driver`, profile, intent: 'quote.car_insurance', registry: transport, user, fallback: spark });
  await transport.close();
  assert.equal(run.outcome, 'completed', run.reason);
  assert.deepEqual(run.pages.map((p) => p.match), ['none', 'none', 'none'], 'Agent A\'s maps were private to Agent A');
  const maps = await registry.registry.storage.mapsForOrigin(site.url);
  assert.equal(maps.length, 3);
  for (const r of maps) {
    assert.equal(r.verification?.by, 'agent', r.map.path);
    assert.notEqual(r.verification?.verifier, r.submitted_by, 'verified by a second identity');
    assert.equal(r.map.provenance.verified, true);
  }
});

test('Agent B (Muse Spark Open, own key, MCP) knocks and runs on the maps Agent A built: no model, faster', async () => {
  const user = scriptedUser(profile);
  const transport = await mcpTransport(registry.url, keyB());
  const run = await runAgent({ browser, url: `${site.url}/quote/driver`, profile, intent: 'quote.car_insurance', registry: transport, user, fallback: sparkOpen });
  await transport.close();
  runs['Agent B, Spark Open, with map'] = run;
  assert.equal(run.outcome, 'completed', run.reason);
  assert.equal(run.transport, 'mcp');
  assert.deepEqual(run.pages.map((p) => [p.match, p.map_source]), [['exact', 'registry'], ['exact', 'registry'], ['exact', 'registry']]);
  assert.equal(run.model_ms, 0);
  assert.equal(run.usage.total_tokens, 0);
  const a = runs['Agent A, Muse Spark, no map']!;
  assert.ok(run.total_ms < a.total_ms, `${run.total_ms} ms vs ${a.total_ms} ms`);
  // Two agents, two identities.
  const sessions = await Promise.all([a.session!, run.session!].map(session));
  assert.notEqual(sessions[0]!.agent, sessions[1]!.agent);
});

test('layout B: the site script reports drift, the registry marks the maps, Agent B re-reads with Spark Open', async () => {
  await site.setLayout('b');
  try {
    const transport = await httpTransport(registry.url, keyB());
    const run = await runAgent({ browser, url: `${site.url}/quote/driver`, profile, intent: 'quote.car_insurance', registry: transport, user: scriptedUser(profile), fallback: sparkOpen });
    await transport.close();
    runs['Agent B, Spark Open, layout B'] = run;
    assert.equal(run.outcome, 'completed', run.reason);
    // At the 0.3 threshold every layout B page is a near match; the agent only trusts exact ones.
    assert.deepEqual(run.pages.map((p) => p.match), ['near', 'near', 'near']);
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

test('layout C, the controls real quote forms use: split date of birth, address lookup with a list, bands, a year select, a text date, card radios', async () => {
  await site.setLayout('c');
  try {
    const transport = await httpTransport(registry.url, join(dir, 'agent-c-layout.json'));
    const actions: string[] = [];
    const run = await runAgent({ browser, url: `${site.url}/quote/driver`, profile, intent: 'quote.car_insurance', registry: transport, user: scriptedUser(profile), fallback: spark, onEvent: (e) => e.type === 'action' && actions.push(`${e.action}:${e.key}`) });
    await transport.close();
    runs['Agent A, Spark, layout C'] = run;
    assert.equal(run.outcome, 'completed', run.reason);
    assert.match(run.final_url, /\/quote\/result$/);
    for (const a of ['fill:person.dob', 'fill:address.postcode', 'press:lookup.address', 'press:lookup.vehicle', 'fill:vehicle.annual_mileage', 'fill:policy.start_date', 'fill:policy.voluntary_excess', 'fill:policy.payment_frequency', 'fill:person.employment_status']) assert.ok(actions.includes(a), `${a} in ${actions.join(' ')}`);
    assert.ok(!actions.includes('fill:vehicle.year'), 'the year as the lookup set it');
  } finally {
    await site.setLayout('a');
  }
});

test('live: Agent A on Muse Spark builds the maps, Agent B on Muse Spark Open runs on them, then reads layout B', { skip: process.env.USHER_LIVE !== '1' && 'set USHER_LIVE=1 to call the model APIs' }, async () => {
  loadDotEnv();
  const live = await mkdtemp(join(tmpdir(), 'usher-e2e-live-'));
  const fresh = await startRegistry({ storage: await testStorage(live), siteScript });
  const liveSite = await startMockSite({ registry: fresh.url, register: async (origin) => (await registerSite(fresh, origin)).site_key });
  const go = async (name: string, key: string, fallback: { chat: ReturnType<typeof modelApi>; model: string }) => {
    const transport = await httpTransport(fresh.url, key);
    const run = await runAgent({ browser, url: `${liveSite.url}/quote/driver`, profile, intent: 'quote.car_insurance', registry: transport, user: scriptedUser(profile), fallback });
    await transport.close();
    runs[name] = run;
    assert.equal(run.outcome, 'completed', `${name}: ${run.reason}`);
  };
  try {
    await go('live: Agent A, Muse Spark, no map', join(live, 'a.json'), { chat: modelApi(), model: compilerModel() });
    await go('live: Agent B, Spark Open, map', join(live, 'b.json'), { chat: modelApi({ provider: 'baseten' }), model: openModel() });
    await liveSite.setLayout('b');
    await go('live: Agent B, Spark Open, layout B', join(live, 'b.json'), { chat: modelApi({ provider: 'baseten' }), model: openModel() });
  } finally {
    await liveSite.stop();
    await fresh.close();
    await rm(live, { recursive: true });
  }
});

test('Brightwater Health in layouts A, B and C: the smoker answer as the person gave it, the address from the lookup, the quote', async () => {
  for (const layout of ['a', 'b', 'c'] as const) {
    await site.setLayout(layout);
    try {
      const transport = await httpTransport(registry.url, join(dir, `agent-health-${layout}.json`));
      const actions: string[] = [];
      const user = scriptedUser(health);
      const run = await runAgent({ browser, url: `${site.url}/health/about`, profile: health, intent: 'quote.health_insurance', registry: transport, user, fallback: spark, onEvent: (e) => e.type === 'action' && actions.push(`${e.action}:${e.key}`) });
      await transport.close();
      runs[`Agent A, Spark, health ${layout.toUpperCase()}`] = run;
      assert.equal(run.outcome, 'completed', `${layout}: ${run.reason} ${JSON.stringify(run.pages)} ${run.final_url}`);
      assert.match(run.final_url, /\/health\/result$/);
      for (const a of ['fill:person.dob', 'press:lookup.address', 'fill:cover.who', 'fill:person.smoker', 'fill:cover.level', 'fill:cover.excess', 'fill:policy.start_date', 'fill:consent.declaration']) assert.ok(actions.includes(a), `${layout}: ${a} in ${actions.join(' ')}`);
      assert.ok(!actions.some((a) => a.includes('health.')), 'no medical question');
      assert.deepEqual(user.confirmations, ['person.smoker', 'consent.declaration', 'form.submit'], 'the smoker answer, the declaration and Get my quote, each on the person\'s yes');
    } finally {
      await site.setLayout('a');
    }
  }
});
