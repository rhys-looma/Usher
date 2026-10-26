import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { contentDigest, generateAgentIdentity, knockSchemaErrors, randomId, signHttpMessage, signToken, utf8 } from '@usher/core';
import { RegistryClient, seed, startRegistry, type RunningRegistry } from '@usher/registry';
import { createUsherCheck, tokenFrom } from '../src/index.ts';
import { startMockSite, type MockSite } from './mock-site.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';

let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let client: RegistryClient;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-check-'));
  registry = await startRegistry({ storage: await testStorage(dir) });
  site = await startMockSite({ registry: registry.url });
  await seed(registry.registry, 'mock-site', site.url);
  client = new RegistryClient(registry.url, (await generateAgentIdentity()).identity);
});
after(async () => {
  await site.stop();
  await registry.close();
  await rm(dir, { recursive: true });
});

const req = (headers: Record<string, string> = {}) => ({ headers }) as unknown as IncomingMessage;
// A token for requesting the quote: knocked with the user's confirmation, as the rules require.
const knockToken = async (url = `${site.url}/quote/cover`, confirmed: string[] = ['form.submit']) => (await client.knock({ url, intent: 'quote.car_insurance', confirmed })).token;

test('the token is read from Authorization, X-Usher-Token, then the usher_token form field', () => {
  assert.equal(tokenFrom(req({ authorization: 'Usher a.b.c', 'x-usher-token': 'x.y.z' })), 'a.b.c');
  assert.equal(tokenFrom(req({ authorization: 'Bearer nope', 'x-usher-token': 'x.y.z' })), 'x.y.z');
  assert.equal(tokenFrom(req(), new URLSearchParams({ usher_token: 'f.o.rm' })), 'f.o.rm');
  assert.equal(tokenFrom(req()), undefined);
});

test('people pass through; agents without a valid token need to knock', async () => {
  const usher = createUsherCheck({ registry: registry.url, intent: 'quote.car_insurance', origin: site.url });
  assert.deepEqual(await usher.check(req()), { status: 'human' });
  assert.equal((await usher.check(req({ 'usher-agent': 'my-agent' }))).status, 'knock_required');
  assert.equal((await usher.check(req({ 'signature-agent': '"https://agent.example"' }))).status, 'knock_required');
  const custom = createUsherCheck({ registry: registry.url, intent: 'quote.car_insurance', origin: site.url, isAgent: (r) => r.headers['user-agent'] === 'bot' });
  assert.equal((await custom.check(req({ 'user-agent': 'bot' }))).status, 'knock_required');
  assert.deepEqual(await usher.check(req(), { always: true }), { status: 'knock_required', reason: 'missing', message: 'Knock at the registry for a token first.' });

  const token = await knockToken();
  const ok = await usher.check(req({ authorization: `Usher ${token}` }), { action: 'form.submit' });
  assert.equal(ok.status, 'ok');
  const replayed = await usher.check(req({ authorization: `Usher ${token}` }), { action: 'form.submit' });
  assert.equal(replayed.status === 'knock_required' && replayed.reason, 'replayed');
});

test('expired, foreign-origin and wrong-intent tokens fail; no keys fails closed', async () => {
  const usher = createUsherCheck({ registry: registry.url, intent: 'quote.car_insurance', origin: site.url });
  const reason = async (token: string) => {
    const r = await usher.check(req({ 'x-usher-token': token }));
    return r.status === 'knock_required' ? r.reason : r.status;
  };
  const key = await registry.registry.signingKey();
  const iat = Math.floor(Date.now() / 1000) - 3600;
  const base = { iss: registry.url, sub: 'agent', origin: site.url, intent: 'quote.car_insurance', map: null, sid: 's_x', iat, exp: iat + 600 };
  assert.equal(await reason(await signToken({ ...base, jti: randomId() }, key)), 'expired');
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await reason(await signToken({ ...base, iat: now, exp: now + 600, origin: 'http://localhost:1', jti: randomId() }, key)), 'wrong_origin');
  assert.equal(await reason(await signToken({ ...base, iat: now, exp: now + 600, intent: 'booking.table', jti: randomId() }, key)), 'wrong_intent');
  assert.equal(await reason(await signToken({ ...base, iat: now, exp: now + 600, iss: 'http://other-registry', jti: randomId() }, key)), 'wrong_issuer');

  const offline = createUsherCheck({ registry: 'http://localhost:1', intent: 'quote.car_insurance', origin: site.url });
  const r = await offline.check(req({ 'x-usher-token': await knockToken() }));
  assert.equal(r.status === 'knock_required' && r.reason, 'keys_unavailable');
});

test('the rules travel in the token: unconfirmed consequential actions and forbidden ones are refused', async () => {
  const usher = createUsherCheck({ registry: registry.url, intent: 'quote.car_insurance', origin: site.url });
  const reason = async (token: string, action: string) => {
    const r = await usher.check(req({ 'x-usher-token': token }), { action });
    return r.status === 'knock_required' ? r.reason : r.status;
  };
  // form.submit is consequential: a token from a plain knock is not enough, even with no map.
  assert.equal(await reason(await knockToken(undefined, []), 'form.submit'), 'confirmation_required');
  assert.equal(await reason(await knockToken(`${site.url}/unmapped`, []), 'form.submit'), 'confirmation_required');
  assert.equal(await reason(await knockToken(), 'form.submit'), 'ok');
  // Paying is for the user (needs_user by default), whatever the token says.
  assert.equal(await reason(await knockToken(undefined, []), 'form.purchase'), 'action_forbidden');
  // Safe actions need nothing more.
  assert.equal(await reason(await knockToken(undefined, []), 'nav.next'), 'ok');
});

test('mock site: /.well-known/usher.json names the registry', async () => {
  const discovery = await (await fetch(`${site.url}/.well-known/usher.json`)).json();
  assert.equal(knockSchemaErrors('siteDiscovery', discovery), null);
  assert.equal(discovery.knock_url, `${registry.url}/knock`);
});

const quote = {
  driver: { title: 'mr', first_name: 'Sam', last_name: 'Taylor', dob: '1988-04-02', email: 'sam@example.com', postcode: 'WR14 1AA', address_line1: '1 High Street', occupation: 'teacher', employment_status: 'employed', has_claims: 'no' },
  vehicle: { registration: 'AB12CDE', make: 'Ford', model: 'Fiesta', year: 2018, annual_mileage: 8000, use: 'social-and-commuting', overnight: 'driveway', modified: 'no' },
  cover: { start_date: '2026-11-15', cover_level: 'comprehensive', excess: '250', ncd_years: '5', payment: 'monthly', declaration: 'yes' },
};

test('mock site API: 403 knock_required without a token, a quote with one, 403 on replay', async () => {
  const call = (headers: Record<string, string> = {}) => fetch(`${site.url}/api/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(quote) });
  const refused = await call();
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('link'), `<${registry.url}/knock>; rel="usher-knock"`);
  const body = await refused.json();
  assert.equal(knockSchemaErrors('knockRequired', body), null);
  assert.deepEqual(body, { error: 'knock_required', knock_url: `${registry.url}/knock`, origin: site.url, intent: 'quote.car_insurance', reason: 'missing' });

  const token = await knockToken(`${site.url}/api/quote`);
  const priced = await call({ Authorization: `Usher ${token}` });
  assert.equal(priced.status, 200);
  assert.match((await priced.json()).reference, /^BW-/);
  const replay = await call({ Authorization: `Usher ${token}` });
  assert.equal(replay.status, 403);
  assert.equal((await replay.json()).reason, 'replayed');
});

// Walks the form with a cookie jar, as a browser would.
async function formFlow(coverHeaders: Record<string, string>, extra: Record<string, string> = {}): Promise<Response> {
  let cookie = '';
  const post = async (step: string, form: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const res = await fetch(`${site.url}/quote/${step}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie && { Cookie: cookie }), ...headers },
      body: new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])),
    });
    cookie ||= (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    return res;
  };
  await post('driver', quote.driver);
  await post('vehicle', quote.vehicle);
  return post('cover', { ...quote.cover, ...extra }, coverHeaders);
}

test('mock site form: people get their quote unchecked; identified agents need a token', async () => {
  const human = await formFlow({});
  assert.deepEqual([human.status, human.headers.get('location')], [303, '/quote/result']);

  const agentWithout = await formFlow({ 'Usher-Agent': 'test-agent' });
  assert.equal(agentWithout.status, 403);
  assert.equal((await agentWithout.json()).error, 'knock_required');

  // The site script puts the bound token in the form as usher_token.
  const agentWith = await formFlow({ 'Usher-Agent': 'test-agent' }, { usher_token: await knockToken() });
  assert.deepEqual([agentWith.status, agentWith.headers.get('location')], [303, '/quote/result']);
});

test('Web Bot Auth: a signature from the token\'s key is verified; another key, or none when required, is refused', async () => {
  const usher = createUsherCheck({ registry: registry.url, intent: 'quote.car_insurance', origin: site.url });
  const strict = createUsherCheck({ registry: registry.url, intent: 'quote.car_insurance', origin: site.url, requireSignature: true });
  const host = new URL(site.url).host;
  const signedReq = async (token: string, identity: Awaited<ReturnType<typeof generateAgentIdentity>>['identity'], body = utf8('quote=yes')) => {
    const headers: Record<string, string> = { host, authorization: `Usher ${token}`, 'content-digest': await contentDigest(body) };
    Object.assign(headers, await signHttpMessage({ method: 'POST', url: `http://${host}/api/quote`, headers }, identity, { components: ['@method', '@authority', '@path', 'content-digest'] }));
    return { request: { method: 'POST', url: '/api/quote', headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) } as unknown as IncomingMessage, body };
  };
  const { identity } = await generateAgentIdentity();
  const own = new RegistryClient(registry.url, identity);
  const knock = async () => (await own.knock({ url: `${site.url}/quote/cover`, intent: 'quote.car_insurance', confirmed: ['form.submit'] })).token;

  const good = await signedReq(await knock(), identity);
  const ok = await usher.check(good.request, { action: 'form.submit', always: true, body: good.body });
  assert.equal(ok.status === 'ok' && ok.identity, 'verified');

  // A copied token, signed by someone else.
  const thief = (await generateAgentIdentity()).identity;
  const stolen = await signedReq(await knock(), thief);
  const refused = await usher.check(stolen.request, { action: 'form.submit', always: true, body: stolen.body });
  assert.equal(refused.status === 'knock_required' && refused.reason, 'bad_signature');

  // The body changed after signing.
  const tampered = await signedReq(await knock(), identity);
  const changed = await usher.check(tampered.request, { action: 'form.submit', always: true, body: utf8('quote=no') });
  assert.equal(changed.status === 'knock_required' && changed.reason, 'bad_signature');

  // A token alone still works unless the site requires signatures.
  const plain = req({ authorization: `Usher ${await knock()}` });
  const unsigned = await usher.check(plain, { action: 'form.submit' });
  assert.equal(unsigned.status === 'ok' && unsigned.identity, 'unsigned');
  const required = await strict.check(req({ authorization: `Usher ${await knock()}` }), { action: 'form.submit' });
  assert.equal(required.status === 'knock_required' && required.reason, 'signature_required');
});
