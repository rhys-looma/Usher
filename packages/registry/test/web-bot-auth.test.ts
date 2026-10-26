import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEY_DIRECTORY_PATH, contentDigest, decodeToken, generateAgentIdentity, keyDirectoryResponse, signHttpMessage, signRequest, utf8, type AgentIdentity } from '@usher/core';
import { RegistryClient, seed, startRegistry, type RunningRegistry } from '../src/index.ts';
import { testStorage } from './storage-helper.ts';

const ORIGIN = 'http://localhost:4100';
let dir: string;
let registry: RunningRegistry;
let directory: Server;
let directoryUrl: string;
let published: AgentIdentity;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-wba-'));
  registry = await startRegistry({ storage: await testStorage(dir), directories: { allowHttp: true } });
  await seed(registry.registry, 'mock-site', ORIGIN);
  // An agent operator's key directory.
  published = (await generateAgentIdentity()).identity;
  directory = createServer(async (req, res) => {
    if (req.url !== KEY_DIRECTORY_PATH) return void res.writeHead(404).end();
    const r = await keyDirectoryResponse(published, { method: 'GET', url: `http://${req.headers.host}${req.url}`, headers: {} });
    res.writeHead(200, r.headers).end(r.body);
  });
  await new Promise<void>((r) => directory.listen(0, '127.0.0.1', r));
  directoryUrl = `http://localhost:${(directory.address() as AddressInfo).port}`;
});
after(async () => {
  directory.close();
  await registry.close();
  await rm(dir, { recursive: true });
});

const knockBody = { usher: '0.1', url: `${ORIGIN}/quote/driver`, intent: 'quote.car_insurance' };

/** A knock signed only with HTTP Message Signatures, the way any Web Bot Auth agent would send it. */
async function webBotAuthKnock(identity: AgentIdentity, body: object, options: { signatureAgent?: string; sendBody?: string } = {}) {
  const text = JSON.stringify(body);
  const url = `${registry.url}/knock`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Content-Digest': await contentDigest(utf8(text)) };
  Object.assign(headers, await signHttpMessage({ method: 'POST', url, headers }, identity, { components: ['@method', '@authority', '@path', 'content-digest'], ...(options.signatureAgent && { signatureAgent: options.signatureAgent }) }));
  const res = await fetch(url, { method: 'POST', headers, body: options.sendBody ?? text });
  return { status: res.status, body: (await res.json()) as { session?: string; token?: string; error?: string } };
}

const sessionIdentity = async (sid: string) => (await registry.registry.storage.getSession(sid))?.identity;

test('the registry client signs with Web Bot Auth; the token carries the agent key (cnf)', async () => {
  const { identity } = await generateAgentIdentity();
  const knock = await new RegistryClient(registry.url, identity).knock({ url: `${ORIGIN}/quote/driver`, intent: 'quote.car_insurance' });
  assert.deepEqual(await sessionIdentity(knock.session), { method: 'web-bot-auth' });
  assert.deepEqual(decodeToken(knock.token)!.claims.cnf, { jwk: identity.publicJwk });
});

test('the signed knock body still works on its own (the fallback)', async () => {
  const { identity } = await generateAgentIdentity();
  const knock = await new RegistryClient(registry.url, identity, { httpSignatures: false }).knock({ url: `${ORIGIN}/quote/driver`, intent: 'quote.car_insurance' });
  assert.deepEqual(await sessionIdentity(knock.session), { method: 'usher-signature' });
});

test('a key from the agent\'s directory (Signature-Agent), with no key in the knock', async () => {
  const r = await webBotAuthKnock(published, knockBody, { signatureAgent: directoryUrl });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await sessionIdentity(r.body.session!), { method: 'web-bot-auth', signature_agent: directoryUrl });
  // A key the directory never listed is not trusted through it.
  const stranger = (await generateAgentIdentity()).identity;
  const refused = await webBotAuthKnock(stranger, knockBody, { signatureAgent: directoryUrl });
  assert.deepEqual([refused.status, refused.body.error], [401, 'unknown_agent']);
});

test('a key supplied in the knock; refusals for unknown keys, a mismatched id, a changed body and no signature', async () => {
  const { identity } = await generateAgentIdentity();
  const unknown = await webBotAuthKnock(identity, knockBody);
  assert.deepEqual([unknown.status, unknown.body.error], [401, 'unknown_agent']);
  const supplied = await webBotAuthKnock(identity, { ...knockBody, agent: { id: identity.id, jwk: identity.publicJwk } });
  assert.equal(supplied.status, 200, JSON.stringify(supplied.body));
  // Known from now on: no key needed.
  assert.equal((await webBotAuthKnock(identity, knockBody)).status, 200);

  const other = (await generateAgentIdentity()).identity;
  const mismatch = await webBotAuthKnock(identity, { ...knockBody, agent: { id: other.id, jwk: other.publicJwk } });
  assert.deepEqual([mismatch.status, mismatch.body.error], [401, 'bad_signature']);
  const changed = await webBotAuthKnock(identity, knockBody, { sendBody: JSON.stringify({ ...knockBody, intent: 'account.delete' }) });
  assert.deepEqual([changed.status, changed.body.error], [401, 'bad_signature']);
  const unsigned = await fetch(`${registry.url}/knock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(knockBody) });
  assert.deepEqual([unsigned.status, ((await unsigned.json()) as { error: string }).error], [401, 'signature_required']);
  // Both schemes together must name the same agent.
  const both = await signRequest(knockBody, other);
  const crossed = await webBotAuthKnock(identity, both);
  assert.deepEqual([crossed.status, crossed.body.error], [401, 'bad_signature']);
});
