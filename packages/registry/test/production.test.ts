// Production settings: what NODE_ENV=production refuses to start without, the load balancer's
// forwarded headers, secure cookies over https, and the privacy notice, robots.txt and security.txt.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientAddress, listeningUrl, requestUrl, startRegistry, type RunningRegistry } from '../src/index.ts';
import { productionProblems, trustProxy } from '../src/production.ts';
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

test('production: the load balancer is trusted by default, and only there', () => {
  assert.equal(trustProxy(READY), true);
  assert.equal(trustProxy({ ...READY, USHER_TRUST_PROXY: '0' }), false);
  assert.equal(trustProxy({}), false);
  assert.equal(trustProxy({ USHER_TRUST_PROXY: '1' }), true);
});

test('forwarded headers: the address the load balancer added, and the scheme it was reached on', () => {
  const req = (headers: Record<string, string>) => ({ headers, url: '/knock', socket: { remoteAddress: '10.0.0.5' } }) as unknown as IncomingMessage;
  // A client can send its own X-Forwarded-For; the load balancer appends the real address last.
  const spoofed = req({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9', 'x-forwarded-proto': 'https', host: 'registry.example' });
  assert.equal(clientAddress(spoofed, true), '203.0.113.9');
  assert.equal(clientAddress(spoofed, false), '10.0.0.5');
  assert.equal(requestUrl(spoofed, true), 'https://registry.example/knock');
  assert.equal(requestUrl(spoofed, false), 'http://registry.example/knock');
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
