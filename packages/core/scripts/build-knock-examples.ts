// Regenerates spec/examples/knock with real keys and signatures, so the examples verify.
// Private keys are thrown away; only public keys are written.

import { readFile, writeFile } from 'node:fs/promises';
import { generateAgentIdentity, generateSigningKey, signRequest, signToken, decodeToken, type Fingerprint } from '../src/index.ts';

const spec = new URL('../../../spec/', import.meta.url);
const out = new URL('examples/knock/', spec);
const map = JSON.parse(await readFile(new URL('examples/quote-driver.map.json', spec), 'utf8'));
const fingerprint: Fingerprint = map.fingerprint;
const registry = 'http://localhost:4200';
const site = 'http://localhost:4100';
const now = new Date('2026-10-27T10:00:00Z');
const iat = Math.floor(now.getTime() / 1000);
const sid = 's_Yk3nQ2xV8wLp4tRz';

const { key } = await generateSigningKey();
const { identity } = await generateAgentIdentity();
const write = (name: string, doc: unknown) => writeFile(new URL(`${name}.json`, out), `${JSON.stringify(doc, null, 2)}\n`);

const knock = await signRequest({ usher: '0.1', url: `${site}/quote/driver`, intent: 'quote.car_insurance', fingerprint }, identity, { now });
const token = await signToken(
  { iss: registry, sub: identity.id, origin: site, intent: 'quote.car_insurance', map: fingerprint.digest, sid, iat, exp: iat + 600, jti: 'Qm9vZGxlLWp0aS1leGFtcGxl' },
  key,
);
await write('site-discovery', { usher: '0.1', registry, knock_url: `${registry}/knock`, keys_url: `${registry}/.well-known/usher-keys.json` });
await write('knock-request', knock);
await write('keys', { keys: [key.publicJwk] });
await write('token-claims', decodeToken(token)!.claims);
await write('knock-response', {
  usher: '0.1',
  session: sid,
  token,
  expires_at: new Date((iat + 600) * 1000).toISOString().replace('.000Z', 'Z'),
  keys_url: `${registry}/.well-known/usher-keys.json`,
  events_url: `${registry}/sessions/${sid}/events`,
  match: { kind: 'exact', score: 1, digest: fingerprint.digest, drifted: false },
  map,
  plan: null,
  rules: { agents: 'allowed', confirm: ['consequential'], human_only: ['needs_user'] },
});
console.log('spec/examples/knock regenerated');
