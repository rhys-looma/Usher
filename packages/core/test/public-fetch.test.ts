// The fetch for addresses outsiders choose: public internet only, checked on the address actually
// connected to, redirects returned rather than followed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PrivateAddressError, isPrivateAddress, publicFetch, publicLookup } from '../src/public-fetch.ts';

test('private, local, reserved and embedded addresses are not public', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '169.254.170.2', '100.64.0.1', '0.0.0.0', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::10.0.0.1', '2001:db8::1', 'not-an-ip']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(a), false, a);
});

test('a hostname that resolves to a private address is refused when connecting', async () => {
  const err = await new Promise<Error | null>((resolve) => publicLookup('localhost', {}, (e) => resolve(e)));
  assert.ok(err instanceof PrivateAddressError);
});

test('private literals and localhost are refused before any request', async () => {
  let hits = 0;
  const server = createServer((_, res) => (hits++, res.end('secret')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::1]:${port}/`, 'http://169.254.169.254/latest/meta-data/']) {
      await assert.rejects(publicFetch(url), PrivateAddressError, url);
    }
    await assert.rejects(publicFetch('file:///etc/passwd'), TypeError);
    await assert.rejects(publicFetch('https://example.com/', { method: 'POST' }), TypeError);
    assert.equal(hits, 0);
  } finally {
    server.close();
  }
});
