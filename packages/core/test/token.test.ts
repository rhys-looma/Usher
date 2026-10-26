import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ReplayCache,
  canonicalJson,
  decodeToken,
  fromBase64Url,
  generateAgentIdentity,
  generateSigningKey,
  importAgentIdentity,
  jwkThumbprint,
  signRequest,
  signToken,
  toBase64Url,
  verifySignedRequest,
  verifyToken,
  type KeySet,
  type TokenClaims,
} from '../src/index.ts';
import { knockSchemaErrors } from './map-schema.ts';

const examples = new URL('../../../spec/examples/knock/', import.meta.url);
const read = async (name: string) => JSON.parse(await readFile(new URL(name, examples), 'utf8'));

const now = 1_793_095_200;
const site = 'http://localhost:4100';
const claims = (over: Partial<TokenClaims> = {}): Omit<TokenClaims, 'kid'> => ({
  iss: 'http://localhost:4200',
  sub: 'agent-id',
  origin: site,
  intent: 'quote.car_insurance',
  map: null,
  sid: 's_test',
  iat: now,
  exp: now + 600,
  jti: 'jti-0123456789abcdef',
  ...over,
});

async function setup() {
  const { key } = await generateSigningKey();
  const keys: KeySet = { keys: [key.publicJwk] };
  return { key, keys };
}

test('round trip: sign, then verify with the published key set', async () => {
  const { key, keys } = await setup();
  const token = await signToken(claims(), key);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const result = await verifyToken(token, { keys, origin: site, intent: 'quote.car_insurance', issuers: ['http://localhost:4200'], now: now + 1 });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.claims.kid, key.kid);
  assert.equal(result.claims.sid, 's_test');
  assert.deepEqual(decodeToken(token)!.header, { alg: 'EdDSA', typ: 'usher+jwt', kid: key.kid });
  assert.equal(knockSchemaErrors('keySet', keys), null);
  assert.equal(key.kid, await jwkThumbprint(key.publicJwk));
});

test('expired and future tokens fail, allowing a minute of clock skew', async () => {
  const { key, keys } = await setup();
  const token = await signToken(claims(), key);
  assert.ok((await verifyToken(token, { keys, now: now + 600 + 59 })).ok, 'within skew');
  assert.deepEqual(await verifyToken(token, { keys, now: now + 600 + 60 }).then((r) => !r.ok && r.error), 'expired');
  assert.deepEqual(await verifyToken(token, { keys, now: now - 61 }).then((r) => !r.ok && r.error), 'not_yet_valid');
});

test('wrong origin, intent or issuer fail', async () => {
  const { key, keys } = await setup();
  const token = await signToken(claims(), key);
  const error = async (o: object) => {
    const r = await verifyToken(token, { keys, now, ...o });
    return r.ok ? 'ok' : r.error;
  };
  assert.equal(await error({ origin: 'http://localhost:9999' }), 'wrong_origin');
  assert.equal(await error({ origin: 'https://localhost:4100' }), 'wrong_origin');
  assert.equal(await error({ intent: 'booking.table' }), 'wrong_intent');
  assert.equal(await error({ issuers: ['https://registry.example'] }), 'wrong_issuer');
});

test('tampered payloads and signatures fail', async () => {
  const { key, keys } = await setup();
  const token = await signToken(claims(), key);
  const [h, p, s] = token.split('.') as [string, string, string];
  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(p)));
  const forged = toBase64Url(new TextEncoder().encode(JSON.stringify({ ...payload, origin: 'https://evil.example' })));
  const r1 = await verifyToken(`${h}.${forged}.${s}`, { keys, now });
  assert.equal(!r1.ok && r1.error, 'bad_signature');
  const flipped = s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1);
  const r2 = await verifyToken(`${h}.${p}.${flipped}`, { keys, now });
  assert.equal(!r2.ok && r2.error, 'bad_signature');
  for (const bad of ['', 'a.b', 'not.a.token', `${h}.${p}`]) {
    const r = await verifyToken(bad, { keys, now });
    assert.equal(!r.ok && r.error, 'malformed', bad);
  }
});

test('a token signed by another key, or naming an unknown kid, fails', async () => {
  const { keys } = await setup();
  const other = await setup();
  const token = await signToken(claims(), other.key);
  const r = await verifyToken(token, { keys, now });
  assert.equal(!r.ok && r.error, 'unknown_kid');
  // A lookup function (refetching keys on a miss) works the same way.
  const viaLookup = await verifyToken(token, { keys: async (kid) => other.keys.keys.find((k) => k.kid === kid), now });
  assert.ok(viaLookup.ok);
});

test('a replayed jti fails; the cache forgets ids once they expire', async () => {
  const { key, keys } = await setup();
  const replay = new ReplayCache();
  const token = await signToken(claims(), key);
  assert.ok((await verifyToken(token, { keys, now, replay })).ok);
  const again = await verifyToken(token, { keys, now: now + 5, replay });
  assert.equal(!again.ok && again.error, 'replayed');
  // A failed verification does not burn the jti.
  const fresh = await signToken(claims({ jti: 'jti-fedcba9876543210' }), key);
  assert.equal((await verifyToken(fresh, { keys, now, replay, origin: 'http://other' })).ok, false);
  assert.ok((await verifyToken(fresh, { keys, now, replay })).ok);

  const small = new ReplayCache(2);
  assert.ok(small.accept('a', now + 10, now));
  assert.ok(small.accept('b', now + 10, now));
  assert.ok(!small.accept('b', now + 10, now));
  assert.ok(small.accept('c', now + 10, now), 'full: the oldest is dropped');
  assert.equal(small.size, 2);
  assert.ok(small.accept('a', now + 1000, now + 100), 'expired ids are forgotten');
});

test('canonical JSON sorts members and drops undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 'é' }], c: undefined } }), '{"a":{"d":[1,{"y":"é","z":1}]},"b":1}');
});

test('signed requests: agent id is the key thumbprint, signature covers every member', async () => {
  const { identity, privateJwk } = await generateAgentIdentity();
  assert.equal(identity.id, await jwkThumbprint(identity.publicJwk));
  assert.equal((await importAgentIdentity(privateJwk)).id, identity.id);
  const at = new Date('2026-10-27T10:00:00Z');
  const request = await signRequest({ usher: '0.1', url: `${site}/quote/driver` }, identity, { now: at });
  assert.equal(request.ts, '2026-10-27T10:00:00Z');
  assert.ok(!('d' in request.agent.jwk!), 'no private key material');

  const ok = await verifySignedRequest(request, { now: at });
  assert.ok(ok.ok);
  assert.equal(ok.agentId, identity.id);
  // Member order doesn't matter: the signature is over canonical JSON.
  const reordered = JSON.parse(JSON.stringify({ signature: request.signature, ts: request.ts, url: request.url, agent: request.agent, usher: request.usher }));
  assert.ok((await verifySignedRequest(reordered, { now: at })).ok);

  const error = async (r: unknown, o: object = {}) => {
    const v = await verifySignedRequest(r, { now: at, ...o });
    return v.ok ? 'ok' : v.error;
  };
  assert.equal(await error({ ...request, url: `${site}/quote/cover` }), 'bad_signature');
  assert.equal(await error(request, { now: new Date('2026-10-27T10:06:00Z') }), 'stale_request');
  const other = (await generateAgentIdentity()).identity;
  assert.equal(await error({ ...request, agent: { id: request.agent.id, jwk: other.publicJwk } }), 'bad_signature', 'id must match the key');
  const withoutKey = await signRequest({ usher: '0.1', url: `${site}/quote/driver` }, identity, { now: at, includeJwk: false });
  assert.equal(await error(withoutKey), 'unknown_agent');
  assert.equal(await error(withoutKey, { knownKey: async () => identity.publicJwk }), 'ok');
  assert.equal(await error({ url: 'x' }), 'invalid_request');
});

test('the spec examples verify: knock request signature and token', async () => {
  const knock = await read('knock-request.json');
  assert.ok((await verifySignedRequest(knock, { now: new Date(knock.ts) })).ok);
  const response = await read('knock-response.json');
  const keys = await read('keys.json');
  const verified = await verifyToken(response.token, { keys, now: (await read('token-claims.json')).iat, origin: 'http://localhost:4100', intent: 'quote.car_insurance' });
  assert.ok(verified.ok);
  assert.deepEqual(verified.claims, await read('token-claims.json'));
  assert.equal(verified.claims.sub, knock.agent.id);
});
