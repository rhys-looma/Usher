import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetExceeded, budgeted, generateSigningKey, type ChatFn, type SpendLedger } from '@usher/core';
import { Viewer, startRegistry, type RunningRegistry } from '../src/index.ts';
import { testStorage } from './storage-helper.ts';

async function withRegistry(options: Partial<Parameters<typeof startRegistry>[0]>, fn: (r: RunningRegistry, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'usher-hard-'));
  const running = await startRegistry({ storage: await testStorage(dir), web: {}, ...options });
  try {
    await fn(running, dir);
  } finally {
    await running.close();
    await rm(dir, { recursive: true });
  }
}

test('/healthz reports storage and the site script version', async () => {
  const script = join(tmpdir(), `usher-script-${Date.now()}.js`);
  await writeFile(script, 'console.log("usher")');
  await withRegistry({ siteScript: script }, async (r) => {
    const res = await fetch(`${r.url}/healthz`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.storage, process.env.DATABASE_URL ? 'postgres' : 'file');
    assert.match(body.site_script, /^[0-9a-f]{12}$/);
  });
  await rm(script);
});

test('the site script: a versioned path cached for a year, the plain one for five minutes', async () => {
  const script = join(tmpdir(), `usher-script-${Date.now()}.js`);
  await writeFile(script, 'console.log("usher")');
  await withRegistry({ siteScript: script }, async (r) => {
    const { version, path } = await (await fetch(`${r.url}/usher/version.json`)).json();
    const versioned = await fetch(`${r.url}${path}`);
    assert.equal(versioned.status, 200);
    assert.match(versioned.headers.get('cache-control')!, /max-age=31536000, immutable/);
    assert.equal(versioned.headers.get('etag'), `"${version}"`);
    const plain = await fetch(`${r.url}/usher.js`);
    assert.match(plain.headers.get('cache-control')!, /max-age=300/);
    assert.equal((await fetch(`${r.url}/usher/000000000000.js`)).status, 404, 'an old version is not served as the new one');
  });
  await rm(script);
});

test('CORS only where the site script needs it; security headers everywhere', async () => {
  await withRegistry({}, async (r) => {
    const preflight = (path: string, method: string) => fetch(`${r.url}${path}`, { method: 'OPTIONS', headers: { Origin: 'https://site.example', 'Access-Control-Request-Method': method } });
    for (const [path, method] of [['/maps/lookup', 'POST'], ['/drift', 'POST'], ['/sessions/s_abc/events', 'POST'], ['/maps/current', 'GET']]) {
      const res = await preflight(path!, method!);
      assert.equal(res.status, 204, path);
      assert.equal(res.headers.get('access-control-allow-origin'), '*', path);
    }
    for (const [path, method] of [['/knock', 'POST'], ['/sites', 'POST'], ['/dashboard/login', 'POST']]) {
      const res = await preflight(path!, method!);
      assert.equal(res.headers.get('access-control-allow-origin'), null, path);
    }
    const home = await fetch(`${r.url}/`);
    assert.match(home.headers.get('content-security-policy')!, /default-src 'none'.*frame-ancestors 'none'/);
    assert.equal(home.headers.get('x-frame-options'), 'DENY');
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    const big = await fetch(`${r.url}/knock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(300_000) }) });
    assert.equal(big.status, 400, 'bodies over 256 KB are refused');
  });
});

test('per-address rate limits on knocks and drift reports', async () => {
  await withRegistry({ limits: { knock: 3, drift: 2 } }, async (r) => {
    const knock = () => fetch(`${r.url}/knock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((res) => res.status);
    assert.deepEqual([await knock(), await knock(), await knock(), await knock()], [400, 400, 400, 429]);
    const drift = () => fetch(`${r.url}/drift`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((res) => res.status);
    assert.deepEqual([await drift(), await drift(), await drift()], [400, 400, 429]);
  });
});

test('a signing key from configuration is the one tokens use and the one published', async () => {
  const { key, privateJwk } = await generateSigningKey();
  const retired = (await generateSigningKey()).key.publicJwk;
  await withRegistry({ signingKey: privateJwk, retiredKeys: [retired] }, async (r) => {
    const keys = await (await fetch(`${r.url}/.well-known/usher-keys.json`)).json();
    assert.deepEqual(keys.keys.map((k: { kid: string }) => k.kid), [key.kid, retired.kid]);
    assert.equal((await r.registry.storage.signingKeys()).length, 0, 'nothing written to storage');
  });
});

test('a hard daily cap on model spend', async () => {
  const days = new Map<string, number>();
  const ledger: SpendLedger = { spent: async (d) => days.get(d) ?? 0, add: async (d, usd) => void days.set(d, (days.get(d) ?? 0) + usd) };
  let calls = 0;
  const chat: ChatFn = async () => (calls++, { content: '{}', usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000, cached_tokens: 0 }, latency_ms: 1, response: {} });
  let today = new Date('2026-10-27T10:00:00Z');
  const capped = budgeted(chat, 2, ledger, () => today);
  const request = { model: 'muse-spark-1.3', temperature: 0, messages: [], response_format: { type: 'json_schema' as const, json_schema: { name: 'x', strict: true as const, schema: {} } } };
  await capped(request);
  await capped(request);
  await assert.rejects(() => capped(request), (e: unknown) => e instanceof BudgetExceeded && /\$2\.00\) is used up/.test(e.message));
  assert.equal(calls, 2, 'no call once the cap is reached');
  today = new Date('2026-10-28T00:01:00Z');
  await capped(request);
  assert.equal(calls, 3, 'a new day, a new budget');
});

test('the viewer refuses private addresses by default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usher-viewer-'));
  const viewer = new Viewer({ storage: await testStorage(dir) });
  for (const url of ['http://127.0.0.1:4100/', 'http://localhost/', 'http://10.0.0.5/', 'http://192.168.1.1/']) {
    const r = await viewer.compile(url, 'test');
    assert.deepEqual([r.ok, !r.ok && r.reason], [false, 'private_address'], url);
  }
  await rm(dir, { recursive: true });
});
