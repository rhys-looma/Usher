// Production settings: what NODE_ENV=production refuses to start without, the load balancer's
// forwarded headers, secure cookies over https, and the privacy notice, robots.txt and security.txt.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientAddress, listeningUrl, requestScheme, requestUrl, startRegistry, type RunningRegistry } from '../src/index.ts';
import { productionProblems, proxyHops } from '../src/production.ts';
import { testStorage } from './storage-helper.ts';

const READY = {
  NODE_ENV: 'production',
  REGISTRY_PUBLIC_URL: 'https://registry.example',
  DATABASE_URL: 'postgres://u:p@db.internal:5432/usher',
  USHER_SIGNING_KEY: '{"kty":"OKP"}',
  USHER_DAILY_MODEL_BUDGET_USD: '5',
  USHER_ADMIN_KEY: 'a'.repeat(32),
  USHER_CONTACT_EMAIL: 'security@registry.example',
};

test('production: a complete environment has no problems', () => {
  assert.deepEqual(productionProblems(READY), []);
});

test('production: each missing or unsafe setting is named', () => {
  for (const name of ['REGISTRY_PUBLIC_URL', 'DATABASE_URL', 'USHER_SIGNING_KEY', 'USHER_DAILY_MODEL_BUDGET_USD', 'USHER_ADMIN_KEY', 'USHER_CONTACT_EMAIL'] as const) {
    const { [name]: _, ...env } = READY;
    assert.ok(productionProblems(env).some((p) => p.startsWith(`${name} is required`)), name);
  }
  const problems = (env: Record<string, string>) => productionProblems({ ...READY, ...env }).join('\n');
  assert.match(problems({ REGISTRY_PUBLIC_URL: 'http://registry.example' }), /must be an https origin/);
  assert.match(problems({ USHER_DAILY_MODEL_BUDGET_USD: '0' }), /positive number/);
  assert.match(problems({ USHER_ADMIN_KEY: 'short' }), /at least 32/);
  assert.match(problems({ USHER_ALLOW_PRIVATE: '1' }), /local demos only/);
  assert.match(problems({ USHER_DEV_SITE_KEY: 'usp_x' }), /local development only/);
});

test('production: CloudFront and the ALB are trusted by default, and only there', () => {
  assert.equal(proxyHops(READY), 2);
  assert.equal(proxyHops({ ...READY, TRUSTED_PROXY_HOPS: '1' }), 1);
  assert.equal(proxyHops({ ...READY, TRUSTED_PROXY_HOPS: '0' }), 0);
  assert.equal(proxyHops({}), 0);
  assert.throws(() => proxyHops({ TRUSTED_PROXY_HOPS: 'two' }), /whole number/);
});

test('forwarded headers: the viewer CloudFront saw, and the scheme the viewer used', () => {
  const req = (headers: Record<string, string>) => ({ headers, url: '/knock', socket: { remoteAddress: '10.0.0.5' } }) as unknown as IncomingMessage;
  // The client sent its own X-Forwarded-For; CloudFront appended the viewer, the ALB appended CloudFront.
  const viaCloudFront = req({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9, 130.176.0.1', 'cloudfront-forwarded-proto': 'https', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example', host: 'registry.example' });
  assert.equal(clientAddress(viaCloudFront, 2), '203.0.113.9');
  assert.equal(clientAddress(viaCloudFront, 1), '130.176.0.1', 'ALB only');
  assert.equal(clientAddress(viaCloudFront, 0), '10.0.0.5');
  assert.equal(clientAddress(req({ 'x-forwarded-for': '203.0.113.9' }), 2), '203.0.113.9', 'fewer hops than expected: the left-most');
  // CloudFront may reach the ALB over http: its own header wins.
  assert.equal(requestScheme(viaCloudFront, 2), 'https');
  assert.equal(requestScheme(req({ 'x-forwarded-proto': 'https' }), 1), 'https');
  assert.equal(requestScheme(viaCloudFront, 0), 'http');
  assert.equal(requestUrl(viaCloudFront, 2), 'https://registry.example/knock', 'Host as sent, never X-Forwarded-Host');
});

let dir: string;
let registry: RunningRegistry;
let local: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-production-'));
  registry = await startRegistry({ storage: await testStorage(dir), url: 'https://registry.example', web: { contact: 'security@registry.example' } });
  // Served on a local port; its public URL is https.
  local = listeningUrl(registry.server);
});
after(async () => {
  await registry.close();
  await rm(dir, { recursive: true });
});

test('privacy notice: what is stored, what never is, and who to ask', async () => {
  const res = await fetch(`${local}/privacy`);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /mailto:security@registry\.example/);
  for (const said of [/site&#39;s address, your email address and your note|site's address, your email address and your note/, /never reads or sends what anyone types/, /deleted after 90 days/, /never stored/, /strictly necessary/]) assert.match(text, said);
});

test('robots.txt allows everything; security.txt names the contact and expires within a year', async () => {
  assert.equal(await (await fetch(`${local}/robots.txt`)).text(), 'User-agent: *\nAllow: /\n');
  const security = await (await fetch(`${local}/.well-known/security.txt`)).text();
  assert.match(security, /^Contact: mailto:security@registry\.example$/m);
  assert.match(security, /^Canonical: https:\/\/registry\.example\/\.well-known\/security\.txt$/m);
  const expires = new Date(/^Expires: (.+)$/m.exec(security)![1]!);
  assert.ok(expires.getTime() > Date.now() && expires.getTime() < Date.now() + 365 * 86_400_000);
});

test('dashboard cookie is Secure when the registry is served over https', async () => {
  const reply = await registry.registry.registerSite({ origin: 'https://cookie.example' });
  const { secret_key } = reply.body as { secret_key: string };
  const res = await fetch(`${local}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: 'https://cookie.example', secret: secret_key }) });
  assert.match(res.headers.get('set-cookie') ?? '', /; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
});

test('cache headers: static things long, versioned for ever, everything dynamic no-store', async () => {
  const cache = async (path: string, init?: RequestInit) => (await fetch(`${local}${path}`, init)).headers.get('cache-control');
  const version = (await (await fetch(`${local}/usher/version.json`)).json().catch(() => ({}))) as { path?: string };
  if (version.path) assert.equal(await cache(version.path), 'public, max-age=31536000, immutable');
  for (const path of ['/robots.txt', '/.well-known/security.txt', '/og.png']) assert.match((await cache(path)) ?? '', /^public, max-age=86400$/, path);
  for (const path of ['/.well-known/usher-site.json', '/spec/map.md']) assert.match((await cache(path)) ?? '', /^public, max-age=3600$/, path);
  for (const path of ['/', '/privacy', '/dashboard', '/sites/new', '/viewer', '/healthz', '/no-such-page']) assert.equal(await cache(path), 'no-store', path);
  assert.equal(await cache('/knock', { method: 'POST', body: '{}' }), 'no-store');
  assert.equal(await cache('/sessions/s_x', {}), 'no-store');
});

test('the map viewer is off unless asked for, and production refuses it', async () => {
  const front = await (await fetch(`${local}/`)).text();
  assert.doesNotMatch(front, /Try it|action="\/viewer"/);
  for (const init of [{}, { method: 'POST', body: new URLSearchParams({ url: 'https://example.com/' }) }]) {
    const res = await fetch(`${local}/viewer`, init);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /switched off/);
  }
  assert.match(productionProblems({ ...READY, USHER_VIEWER: '1' }).join('\n'), /map viewer stays off in production/);
});

test('HEAD answers like GET, without a body', async () => {
  for (const path of ['/', '/privacy', '/robots.txt', '/healthz']) {
    const [head, get] = await Promise.all([fetch(`${local}${path}`, { method: 'HEAD' }), fetch(`${local}${path}`)]);
    assert.equal(head.status, get.status, path);
    assert.equal(head.headers.get('content-type'), get.headers.get('content-type'), path);
    assert.equal(head.headers.get('cache-control'), get.headers.get('cache-control'), path);
    assert.equal((await head.arrayBuffer()).byteLength, 0, path);
  }
});
