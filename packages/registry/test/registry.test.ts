import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAgentIdentity, knockSchemaErrors, signRequest, verifyToken, type AgentIdentity, type Fingerprint, type UsherMap } from '@usher/core';
import { FileStorage, RegistryClient, RegistryError, findMatch, seed, startRegistry, type MapRecord, type RunningRegistry } from '../src/index.ts';

const site = 'http://localhost:4100';
let dir: string;
let running: RunningRegistry;
let maps: UsherMap[];
let agent: AgentIdentity;
let client: RegistryClient;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-registry-'));
  running = await startRegistry({ storage: new FileStorage(dir) });
  maps = await seed(running.registry, 'mock-site', site);
  agent = (await generateAgentIdentity()).identity;
  client = new RegistryClient(running.url, agent);
});
after(async () => {
  await running.close();
  await rm(dir, { recursive: true });
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${running.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

function nearly(fp: Fingerprint, keep: number): Fingerprint {
  // Same structure with the last few elements changed, like a small redesign.
  const signature = fp.signature.map((s, i) => (i < keep ? s : `ffff${s.slice(4)}`));
  return { algo: 'usher-fp-1', digest: `sha256:${'f'.repeat(63)}${keep % 10}`, signature };
}

test('keys are published as a JWK set, without private material', async () => {
  const res = await fetch(`${running.url}/.well-known/usher-keys.json`);
  const keys = await res.json();
  assert.equal(knockSchemaErrors('keySet', keys), null);
  assert.equal(keys.keys.length, 1);
  assert.ok(!JSON.stringify(keys).includes('"d"'));
});

test('knock with an exact fingerprint: map, rules, a token that verifies, a session', async () => {
  const knock = await client.knock({ url: `${site}/quote/driver?ignored=1`, fingerprint: maps[0]!.fingerprint });
  assert.equal(knockSchemaErrors('knockResponse', knock), null);
  assert.deepEqual(knock.match, { kind: 'exact', score: 1, digest: maps[0]!.fingerprint.digest, drifted: false });
  assert.equal(knock.map?.path, '/quote/driver');
  assert.deepEqual(knock.rules, { agents: 'allowed', confirm: ['consequential'], human_only: ['needs_user'] });
  assert.equal(knock.events_url, `${running.url}/sessions/${knock.session}/events`);

  const keys = await (await fetch(knock.keys_url)).json();
  const verified = await verifyToken(knock.token, { keys, origin: site, intent: 'quote.car_insurance', issuers: [running.url] });
  assert.ok(verified.ok);
  assert.equal(verified.claims.sub, agent.id);
  assert.equal(verified.claims.sid, knock.session);
  assert.equal(verified.claims.map, maps[0]!.fingerprint.digest);
  assert.equal(verified.claims.exp - verified.claims.iat, 600);

  const session = await (await fetch(`${running.url}/sessions/${knock.session}`)).json();
  assert.equal(session.agent, agent.id);
  assert.deepEqual(session.events.map((e: { action: string; path: string }) => [e.action, e.path]), [['knock', '/quote/driver']]);
});

test('a second knock continues the session; only its own agent may continue it', async () => {
  const first = await client.knock({ url: `${site}/quote/driver`, fingerprint: maps[0]!.fingerprint });
  const second = await client.knock({ url: `${site}/quote/vehicle`, fingerprint: maps[1]!.fingerprint, session: first.session });
  assert.equal(second.session, first.session);
  assert.notEqual(second.token, first.token);
  const other = new RegistryClient(running.url, (await generateAgentIdentity()).identity);
  await assert.rejects(() => other.knock({ url: `${site}/quote/vehicle`, session: first.session, intent: 'quote.car_insurance' }), /invalid_request/);
});

test('near, path and no matches report their score', async () => {
  const near = await client.knock({ url: `${site}/quote/driver`, fingerprint: nearly(maps[0]!.fingerprint, 12) });
  assert.equal(near.match.kind, 'near');
  assert.equal(near.match.digest, maps[0]!.fingerprint.digest);
  assert.ok(near.match.score >= 0.5 && near.match.score < 1, String(near.match.score));

  const path = await client.knock({ url: `${site}/quote/driver`, fingerprint: nearly(maps[0]!.fingerprint, 2) });
  assert.equal(path.match.kind, 'path');
  assert.ok(path.match.score < 0.5);

  const none = await client.knock({ url: `${site}/contact`, intent: 'contact.message', fingerprint: nearly(maps[0]!.fingerprint, 0) });
  assert.deepEqual([none.match.kind, none.map], ['none', null]);
  await assert.rejects(() => client.knock({ url: `${site}/contact` }), /intent/);

  const noFingerprint = await client.knock({ url: `${site}/quote/cover` });
  assert.deepEqual([noFingerprint.match.kind, noFingerprint.match.score, noFingerprint.map?.path], ['path', 0, '/quote/cover']);
});

test('every lookup is logged with each candidate\'s score', async () => {
  const log = (await running.registry.storage.readLog('matches')) as { via: string; kind: string; scores: { digest: string; score: number }[]; threshold: number }[];
  assert.ok(log.length >= 6);
  const last = log.at(-1)!;
  assert.equal(last.via, 'knock');
  assert.equal(last.threshold, 0.5);
  assert.equal(last.scores.length, 3, 'one score per map for the origin');
});

test('bad signatures, stale requests and unknown agents are refused', async () => {
  const status = async (body: unknown) => {
    const res = await post('/knock', body);
    return [res.status, (await res.json()).error];
  };
  const signed = await signRequest({ usher: '0.1', url: `${site}/quote/driver` }, agent);
  assert.deepEqual(await status({ ...signed, url: `${site}/quote/cover` }), [401, 'bad_signature']);
  const old = await signRequest({ usher: '0.1', url: `${site}/quote/driver` }, agent, { now: new Date(Date.now() - 10 * 60_000) });
  assert.deepEqual(await status(old), [401, 'stale_request']);
  const stranger = (await generateAgentIdentity()).identity;
  assert.deepEqual(await status(await signRequest({ usher: '0.1', url: `${site}/quote/driver` }, stranger, { includeJwk: false })), [401, 'unknown_agent']);
  // Known agents may leave the key out.
  assert.deepEqual((await status(await signRequest({ usher: '0.1', url: `${site}/quote/driver` }, agent, { includeJwk: false })))[0], 200);
  assert.deepEqual(await status({ ...signed, extra: 1 }), [400, 'invalid_request']);
  const res = await fetch(`${running.url}/knock`, { method: 'POST', body: '{not json' });
  assert.equal(res.status, 400);
});

test('site rules: agents can be turned away per form', async () => {
  await running.registry.storage.putPolicy({ origin: 'http://localhost:4101', forms: [{ path: '/quote/cover', rules: { agents: 'denied' } }] });
  await assert.rejects(() => client.knock({ url: 'http://localhost:4101/quote/cover', intent: 'quote.car_insurance' }), (err: RegistryError) => err.status === 403 && err.code === 'agents_not_allowed');
  const allowed = await client.knock({ url: 'http://localhost:4101/quote/driver', intent: 'quote.car_insurance' });
  assert.equal(allowed.rules.agents, 'allowed');
});

test('events: token required, session must match, values are refused', async () => {
  const knock = await client.knock({ url: `${site}/quote/driver`, fingerprint: maps[0]!.fingerprint });
  const event = { ts: new Date().toISOString(), source: 'site', action: 'fill', key: 'person.first_name', element: 'e2', path: '/quote/driver' };
  const send = (body: unknown, token?: string, sid = knock.session) =>
    post(`/sessions/${sid}/events`, body, token ? { Authorization: `Usher ${token}` } : {}).then(async (r) => [r.status, (await r.json()).error ?? 'ok']);

  assert.deepEqual(await send({ events: [event] }), [401, 'token_required']);
  assert.deepEqual(await send({ events: [event] }, knock.token), [200, 'ok']);
  assert.deepEqual(await send({ events: [{ ...event, value: 'Sam' }] }, knock.token), [400, 'invalid_events']);
  const other = await client.knock({ url: `${site}/quote/driver`, fingerprint: maps[0]!.fingerprint });
  assert.deepEqual(await send({ events: [event] }, other.token), [403, 'wrong_session']);
  assert.deepEqual(await send({ events: [event] }, `${knock.token.slice(0, -3)}AAA`), [401, 'bad_signature']);

  const session = await (await fetch(`${running.url}/sessions/${knock.session}`)).json();
  assert.deepEqual(session.events.map((e: { action: string }) => e.action), ['knock', 'fill']);
});

test('maps: get by digest, look up for a page, submit from an agent', async () => {
  const got = await (await fetch(`${running.url}/maps/${maps[2]!.fingerprint.digest}?origin=${encodeURIComponent(site)}`)).json();
  assert.equal(got.map.path, '/quote/cover');
  assert.equal((await fetch(`${running.url}/maps/sha256:${'0'.repeat(64)}?origin=${encodeURIComponent(site)}`)).status, 404);
  assert.equal((await fetch(`${running.url}/maps/${maps[2]!.fingerprint.digest}`)).status, 400, 'origin required');

  const lookup = await client.lookup(site, '/quote/vehicle', maps[1]!.fingerprint);
  assert.equal(lookup.match.kind, 'exact');

  const mine: UsherMap = { ...maps[0]!, origin: 'http://localhost:4102', provenance: { source: 'agent', compiler: 'muse-spark-1.3', created_at: new Date().toISOString(), verified: true } };
  assert.deepEqual(await client.submitMap(mine), { digest: mine.fingerprint.digest, stored: true });
  assert.deepEqual(await client.submitMap(mine), { digest: mine.fingerprint.digest, stored: false });
  const stored = (await running.registry.storage.mapsForOrigin('http://localhost:4102'))[0]!;
  assert.equal(stored.submitted_by, agent.id);
  assert.equal(stored.map.provenance.verified, false, 'submitted maps start unverified');
  await assert.rejects(() => client.submitMap({ ...mine, fields: [{ id: 'e1' }] } as unknown as UsherMap), /invalid_map/);
  const knock = await client.knock({ url: 'http://localhost:4102/quote/driver', fingerprint: mine.fingerprint });
  assert.equal(knock.match.kind, 'exact');
});

test('runs: reported by the session\'s agent, logged and added to the session', async () => {
  const knock = await client.knock({ url: `${site}/quote/driver`, fingerprint: maps[0]!.fingerprint });
  await client.reportRun({ session: knock.session, url: `${site}/quote/result`, outcome: 'completed', summary: { pages: 3, total_ms: 4200 } });
  const session = await (await fetch(`${running.url}/sessions/${knock.session}`)).json();
  assert.deepEqual(session.events.at(-1).detail, { outcome: 'completed', pages: 3, total_ms: 4200 });
  const runs = (await running.registry.storage.readLog('runs')) as { agent: string; outcome: string }[];
  assert.deepEqual([runs.at(-1)!.agent, runs.at(-1)!.outcome], [agent.id, 'completed']);
  const other = new RegistryClient(running.url, (await generateAgentIdentity()).identity);
  await assert.rejects(() => other.reportRun({ session: knock.session, url: site, outcome: 'completed' }), /not_found/);
});

test('drift: a differing live form marks the map drifted, and knocks say so', async () => {
  const live = nearly(maps[1]!.fingerprint, 6);
  const res = await post('/drift', { origin: site, path: '/quote/vehicle', map: maps[1]!.fingerprint.digest, fingerprint: live, score: 0.99 });
  const body = await res.json();
  assert.equal(body.drifted, true);
  assert.ok(body.score < 0.99, 'the registry scores it itself');
  const record = (await running.registry.storage.getMap(site, maps[1]!.fingerprint.digest)) as MapRecord;
  assert.equal(record.drift?.live_digest, live.digest);
  const knock = await client.knock({ url: `${site}/quote/vehicle`, fingerprint: live });
  assert.equal(knock.match.drifted, true);
  const unchanged = await post('/drift', { origin: site, path: '/quote/driver', map: maps[0]!.fingerprint.digest, fingerprint: maps[0]!.fingerprint, score: 1 });
  assert.equal((await unchanged.json()).drifted, false);
  assert.equal((await post('/drift', { origin: site })).status, 400);
});

test('CORS: the site script may call the registry from the site', async () => {
  const res = await fetch(`${running.url}/maps/lookup`, { method: 'OPTIONS', headers: { Origin: site, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /Authorization/);
});

test('matching ranks exact, then near above the threshold, then same path', () => {
  const rec = (digest: string, path: string, signature: string[], added_at = '2026-10-27T00:00:00Z'): MapRecord =>
    ({ digest, added_at, map: { path, fingerprint: { algo: 'usher-fp-1', digest, signature } } }) as unknown as MapRecord;
  const a = rec('sha256:a', '/one', ['1', '2', '3', '4']);
  const b = rec('sha256:b', '/two', ['1', '2', '3', '5']);
  const c = rec('sha256:c', '/two', ['1', '2', '3', '5'], '2026-10-28T00:00:00Z');
  const live = { digest: 'sha256:x', signature: ['1', '2', '3', '9'] };
  assert.equal(findMatch({ digest: 'sha256:a', signature: [] }, '/one', [a, b]).kind, 'exact');
  const near = findMatch(live, '/two', [a, b, c]);
  assert.deepEqual([near.kind, near.score, near.record?.digest], ['near', 0.6, 'sha256:c'], 'same path, then newest');
  assert.deepEqual(near.scores.map((s) => s.score), [0.6, 0.6, 0.6]);
  assert.equal(findMatch(live, '/one', [a, b, c], 0.7).kind, 'path');
  assert.equal(findMatch(live, '/three', [a, b, c], 0.7).kind, 'none');
  assert.equal(findMatch(undefined, '/one', [a]).kind, 'path');
});

test('storage survives a restart: keys, maps and sessions', async () => {
  const keys = await (await fetch(`${running.url}/.well-known/usher-keys.json`)).json();
  const again = await startRegistry({ storage: new FileStorage(dir) });
  try {
    assert.deepEqual(await (await fetch(`${again.url}/.well-known/usher-keys.json`)).json(), keys);
    assert.equal((await again.registry.storage.mapsForOrigin(site)).length, 3);
  } finally {
    await again.close();
  }
});
