// Prints a new token signing key for USHER_SIGNING_KEY: a private Ed25519 JWK with its kid.
// Keep it secret (a secrets manager, not the repository). Its public half is what
// /.well-known/usher-keys.json publishes.
import { generateSigningKey } from '@usher/core';

const { key, privateJwk } = await generateSigningKey();
console.log(JSON.stringify({ ...privateJwk, kid: key.kid, alg: 'EdDSA', use: 'sig' }));
