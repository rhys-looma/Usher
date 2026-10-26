import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  KEY_DIRECTORY_PATH,
  ReplayCache,
  contentDigest,
  fetchKeyDirectory,
  generateAgentIdentity,
  keyDirectoryResponse,
  signHttpMessage,
  signatureBaseFor,
  utf8,
  verifyHttpMessage,
  verifySignature,
  type HttpMessage,
} from '../src/index.ts';

test('RFC 9421 B.2.6: the signature base and the Ed25519 test signature', async () => {
  const message: HttpMessage = {
    method: 'POST',
    url: 'https://example.com/foo?param=Value&Pet=dog',
    headers: { Date: 'Tue, 20 Apr 2021 02:07:55 GMT', 'Content-Type': 'application/json', 'Content-Length': '18' },
  };
  const params = '("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"';
  const base = signatureBaseFor(['date', '@method', '@path', '@authority', 'content-type', 'content-length'], params, message)!;
  assert.equal(
    base,
    [
      '"date": Tue, 20 Apr 2021 02:07:55 GMT',
      '"@method": POST',
      '"@path": /foo',
      '"@authority": example.com',
      '"content-type": application/json',
      '"content-length": 18',
      `"@signature-params": ${params}`,
    ].join('\n'),
  );
  const key = { kty: 'OKP', crv: 'Ed25519', x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs' } as const;
  const signature = Uint8Array.from(atob('wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw=='), (c) => c.charCodeAt(0));
  assert.ok(await verifySignature(key, signature, utf8(base)));
});

test('Web Bot Auth: sign, verify, and refuse tampering, stale and replayed signatures', async () => {
  const { identity } = await generateAgentIdentity();
  const body = utf8('{"url":"https://shop.example/quote"}');
  const message: HttpMessage = { method: 'POST', url: 'https://registry.example/knock', headers: { 'Content-Type': 'application/json', 'Content-Digest': await contentDigest(body) } };
  const added = await signHttpMessage(message, identity, { components: ['@method', '@authority', '@path', 'content-digest'], signatureAgent: 'https://agent.example' });
  assert.match(added['Signature-Input']!, /^sig1=\("@method" "@authority" "@path" "content-digest" "signature-agent"\);created=\d+;expires=\d+;keyid="[A-Za-z0-9_-]{43}";alg="ed25519";nonce="[^"]+";tag="web-bot-auth"$/);
  assert.equal(added['Signature-Agent'], '"https://agent.example"');
  const signed = { ...message, headers: { ...message.headers, ...added } };
  const key = async (keyid: string, agent: string | null) => (keyid === identity.id && agent === 'https://agent.example' ? identity.publicJwk : undefined);

  const nonces = new ReplayCache();
  const ok = await verifyHttpMessage(signed, { key, body, nonces });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(ok.ok && ok.keyid, identity.id);
  assert.equal(ok.ok && ok.signatureAgent, 'https://agent.example');

  const again = await verifyHttpMessage(signed, { key, body, nonces });
  assert.equal(!again.ok && again.error, 'replayed');
  const otherBody = await verifyHttpMessage(signed, { key, body: utf8('{"url":"https://evil.example"}') });
  assert.equal(!otherBody.ok && otherBody.error, 'digest_mismatch');
  const otherHost = await verifyHttpMessage({ ...signed, url: 'https://elsewhere.example/knock' }, { key, body });
  assert.equal(!otherHost.ok && otherHost.error, 'bad_signature');
  const late = await verifyHttpMessage(signed, { key, body, now: Math.floor(Date.now() / 1000) + 600 });
  assert.equal(!late.ok && late.error, 'expired');
  const unknown = await verifyHttpMessage(signed, { key: async () => undefined, body });
  assert.equal(!unknown.ok && unknown.error, 'unknown_key');
  const noDigest = await signHttpMessage(message, identity, { components: ['@authority'] });
  const uncovered = await verifyHttpMessage({ ...message, headers: { ...message.headers, ...noDigest } }, { key: async () => identity.publicJwk, body });
  assert.equal(!uncovered.ok && uncovered.error, 'missing_component');
  const none = await verifyHttpMessage(message, { key });
  assert.equal(!none.ok && none.error, 'no_signature');
});

test('key directory: served signed, and only keys that signed it are trusted', async () => {
  const { identity } = await generateAgentIdentity();
  const { identity: stranger } = await generateAgentIdentity();
  let listStranger = false;
  const server = createServer(async (req, res) => {
    if (req.url !== KEY_DIRECTORY_PATH) return void res.writeHead(404).end();
    const response = await keyDirectoryResponse(identity, { method: 'GET', url: `http://${req.headers.host}${req.url}`, headers: {} });
    // A directory that also lists someone else's key, which that key never signed.
    const body = listStranger ? JSON.stringify({ keys: [identity.publicJwk, stranger.publicJwk] }) : response.body;
    res.writeHead(200, response.headers).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    await assert.rejects(() => fetchKeyDirectory(origin), /https/);
    assert.deepEqual(await fetchKeyDirectory(origin, { allowHttp: true }), [identity.publicJwk]);
    listStranger = true;
    assert.deepEqual(await fetchKeyDirectory(`${origin}${KEY_DIRECTORY_PATH}`, { allowHttp: true }), [identity.publicJwk]);
  } finally {
    server.close();
  }
});
