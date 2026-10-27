import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, STALE_CLAIM_MS, startRegistry, type ClaimInstructions } from '../src/index.ts';
import { testStorage } from './storage-helper.ts';

const ORIGIN = 'https://quote.example';

/** A registry whose clock, website and DNS the test controls. */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'usher-claim-'));
  let now = Date.parse('2026-11-01T09:00:00Z');
  const web = new Map<string, string>();
  const dns = new Map<string, string[]>();
  const registry = new Registry({
    storage: await testStorage(dir),
    url: 'https://registry.example',
    now: () => new Date(now),
    claims: {
      fetch: (async (url: string) => (web.has(url) ? new Response(web.get(url)) : new Response('not found', { status: 404 }))) as typeof fetch,
      resolveTxt: async (name) => (dns.get(name) ?? []).map((v) => [v]),
    },
  });
  return { registry, web, dns, advance: (ms: number) => (now += ms), cleanup: () => rm(dir, { recursive: true }) };
}

/** A reply's JSON body. */
const b = (r: { body: unknown }) => r.body as Record<string, unknown>;

type Registered = { site_key: string; secret_key: string; claimed: boolean; claim: ClaimInstructions };

test('a new site gets claim instructions; nothing is readable until it proves control', async () => {
  const { registry, web, cleanup } = await setup();
  try {
    const r = await registry.registerSite({ origin: ORIGIN });
    const site = r.body as Registered;
    assert.equal(site.claimed, false);
    assert.deepEqual(site.claim.well_known, { url: `${ORIGIN}/.well-known/usher-site.json`, content: { usher_site: '0.1', site_key: site.site_key } });
    assert.deepEqual(site.claim.dns, { name: '_usher.quote.example', type: 'TXT', value: `usher-site=${site.site_key}` });
    const auth = `Bearer ${site.secret_key}`;
    assert.deepEqual([(await registry.getRules(ORIGIN, auth)).status, b(await registry.getRules(ORIGIN, auth)).error], [403, 'claim_required']);

    const missing = await registry.verifySite(ORIGIN, auth);
    assert.equal(missing.status, 422);
    assert.match(String(b(missing).message), /well-known: HTTP 404; dns: no TXT records/);
    assert.equal((await registry.verifySite(ORIGIN, 'Bearer uss_wrong')).status, 401);

    web.set(site.claim.well_known.url, JSON.stringify({ usher_site: '0.1', site_key: 'usp_someone_else' }));
    assert.match(String(b(await registry.verifySite(ORIGIN, auth)).message), /does not contain this site key/);
    web.set(site.claim.well_known.url, JSON.stringify(site.claim.well_known.content));
    const verified = await registry.verifySite(ORIGIN, auth);
    assert.deepEqual([verified.status, b(verified).method], [200, 'well-known']);
    assert.equal((await registry.getRules(ORIGIN, auth)).status, 200);
  } finally {
    await cleanup();
  }
});

test('a DNS TXT record also proves control', async () => {
  const { registry, dns, cleanup } = await setup();
  try {
    const site = (await registry.registerSite({ origin: ORIGIN })).body as Registered;
    dns.set('_usher.quote.example', ['v=spf1 -all', site.claim.dns.value]);
    const verified = await registry.verifySite(ORIGIN, `Bearer ${site.secret_key}`);
    assert.deepEqual([verified.status, b(verified).method], [200, 'dns']);
  } finally {
    await cleanup();
  }
});

test('claims are re-checked daily; three failures in a row withdraw one', async () => {
  const { registry, web, advance, cleanup } = await setup();
  try {
    const site = (await registry.registerSite({ origin: ORIGIN })).body as Registered;
    web.set(site.claim.well_known.url, JSON.stringify(site.claim.well_known.content));
    await registry.verifySite(ORIGIN, `Bearer ${site.secret_key}`);
    assert.deepEqual(await registry.recheckClaims(), { checked: 0, withdrawn: [] }, 'not due yet');
    advance(25 * 3_600_000);
    assert.deepEqual(await registry.recheckClaims(), { checked: 1, withdrawn: [] });

    web.clear();
    for (let day = 1; day <= 2; day++) {
      advance(25 * 3_600_000);
      assert.deepEqual(await registry.recheckClaims(), { checked: 1, withdrawn: [] }, `failure ${day} counts, the claim stays`);
      assert.equal((await registry.storage.getSite(ORIGIN))?.claim?.failures, day);
    }
    advance(25 * 3_600_000);
    assert.deepEqual(await registry.recheckClaims(), { checked: 1, withdrawn: [ORIGIN] });
    assert.equal((await registry.storage.getSite(ORIGIN))?.claim, undefined);
    assert.equal((await registry.getRules(ORIGIN, `Bearer ${site.secret_key}`)).status, 403);
  } finally {
    await cleanup();
  }
});

test('an unclaimed registration can be replaced after a day; a claimed one never', async () => {
  const { registry, web, advance, cleanup } = await setup();
  try {
    await registry.registerSite({ origin: ORIGIN });
    const again = await registry.registerSite({ origin: ORIGIN });
    assert.deepEqual([again.status, b(again).error], [409, 'site_exists']);
    advance(STALE_CLAIM_MS + 1);
    const replaced = await registry.registerSite({ origin: ORIGIN });
    assert.equal(replaced.status, 201);
    const site = replaced.body as Registered;
    web.set(site.claim.well_known.url, JSON.stringify(site.claim.well_known.content));
    await registry.verifySite(ORIGIN, `Bearer ${site.secret_key}`);
    advance(10 * STALE_CLAIM_MS);
    assert.equal((await registry.registerSite({ origin: ORIGIN })).status, 409);
  } finally {
    await cleanup();
  }
});

test('local origins are claimed only with development keys, which are never re-checked', async () => {
  const { registry, advance, cleanup } = await setup();
  try {
    const local = (await registry.registerSite({ origin: 'http://localhost:4100' })).body as Registered;
    const refused = await registry.verifySite('http://localhost:4100', `Bearer ${local.secret_key}`);
    assert.match(String(b(refused).message), /private or local address/);
    await registry.ensureSite('http://localhost:4101', 'usp_dev', 'uss_dev');
    assert.equal((await registry.storage.getSite('http://localhost:4101'))?.claim?.method, 'dev');
    advance(30 * 24 * 3_600_000);
    assert.deepEqual(await registry.recheckClaims(), { checked: 0, withdrawn: [] });
  } finally {
    await cleanup();
  }
});

test('dashboard: an unclaimed site sees only how to claim it; the mock site claims itself by its well-known file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usher-claim-web-'));
  const { startMockSite } = await import('../../site-middleware/test/mock-site.ts');
  const running = await startRegistry({ storage: await testStorage(dir), web: {}, claims: { allowPrivate: true } });
  let keys: Registered | undefined;
  const site = await startMockSite({
    registry: running.url,
    register: async (origin) => {
      keys = (await running.registry.registerSite({ origin })).body as Registered;
      return keys.site_key;
    },
  });
  try {
    const login = await fetch(`${running.url}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: site.url, secret: keys!.secret_key }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const gated = await fetch(`${running.url}/dashboard`, { headers: { Cookie: cookie } });
    const text = await gated.text();
    assert.equal(gated.status, 200, 'what is missing, not a bare refusal');
    assert.match(text, /Almost there: prove http:\/\/localhost:\d+ is yours/);
    assert.ok(text.includes(`usher-site=${keys!.site_key}`));
    assert.ok(!/Agent sessions|Forms and maps|Rules/.test(text), 'nothing else shown');
    const check = await fetch(`${running.url}/dashboard/verify`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie } });
    assert.equal(check.status, 303);
    const open = await fetch(`${running.url}/dashboard`, { headers: { Cookie: cookie } });
    assert.equal(open.status, 200);
    assert.match(await open.text(), /Agent sessions/);
    assert.equal((await running.registry.storage.getSite(site.url))?.claim?.method, 'well-known');
  } finally {
    await site.stop();
    await running.close();
    await rm(dir, { recursive: true });
  }
});
