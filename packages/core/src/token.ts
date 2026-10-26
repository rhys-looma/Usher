// Usher tokens (LU-22): compact JWS signed with Ed25519, verified offline against the
// registry's published key set. WebCrypto only, so the same code runs in the registry, the
// site's server and the site script in the browser.

import { canonicalJson, fromBase64Url, sha256, toBase64Url, utf8, type Bytes } from './encoding.ts';

export interface PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid?: string;
  alg?: 'EdDSA';
  use?: 'sig';
}

export interface PrivateJwk extends PublicJwk {
  d: string;
}

export interface KeySet {
  keys: PublicJwk[];
}

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  /** As published in the key set. */
  publicJwk: PublicJwk & { kid: string; alg: 'EdDSA'; use: 'sig' };
}

export interface TokenClaims {
  /** Registry URL. */
  iss: string;
  kid: string;
  /** Agent id. */
  sub: string;
  /** Site origin the token is for: its audience. */
  origin: string;
  intent: string;
  /** Digest of the matched map, or null. */
  map: string | null;
  /** Session id. */
  sid: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface TokenHeader {
  alg: 'EdDSA';
  typ: 'usher+jwt';
  kid: string;
}

/** Tokens live ten minutes. */
export const TOKEN_LIFETIME_SECONDS = 600;
const CLOCK_SKEW_SECONDS = 60;
const ED25519 = { name: 'Ed25519' } as const;

/** RFC 7638 thumbprint of an Ed25519 public key: base64url SHA-256 of its required members. */
export async function jwkThumbprint(jwk: PublicJwk): Promise<string> {
  return toBase64Url(await sha256(utf8(canonicalJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))));
}

export function publicPart(jwk: PublicJwk): PublicJwk {
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
}

export function importPublicKey(jwk: PublicJwk): Promise<CryptoKey> {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new Error('not an Ed25519 public key');
  return globalThis.crypto.subtle.importKey('jwk', publicPart(jwk), ED25519, false, ['verify']);
}

/** A new Ed25519 key pair. The private JWK is what a caller stores; it never leaves its owner. */
export async function generateKeyPair(): Promise<{ privateKey: CryptoKey; publicJwk: PublicJwk; privateJwk: PrivateJwk }> {
  const pair = (await globalThis.crypto.subtle.generateKey(ED25519, true, ['sign', 'verify'])) as CryptoKeyPair;
  const exported = (await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey)) as { x: string; d: string };
  return { privateKey: pair.privateKey, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: exported.x }, privateJwk: { kty: 'OKP', crv: 'Ed25519', x: exported.x, d: exported.d } };
}

export async function importPrivateKey(jwk: PrivateJwk): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d }, ED25519, false, ['sign']);
}

async function asSigningKey(privateKey: CryptoKey, jwk: PublicJwk): Promise<SigningKey> {
  const kid = await jwkThumbprint(jwk);
  return { kid, privateKey, publicJwk: { ...publicPart(jwk), kid, alg: 'EdDSA', use: 'sig' } };
}

/** A registry signing key; its kid is the key's thumbprint. */
export async function generateSigningKey(): Promise<{ key: SigningKey; privateJwk: PrivateJwk }> {
  const pair = await generateKeyPair();
  return { key: await asSigningKey(pair.privateKey, pair.publicJwk), privateJwk: pair.privateJwk };
}

export async function importSigningKey(jwk: PrivateJwk): Promise<SigningKey> {
  return asSigningKey(await importPrivateKey(jwk), jwk);
}

export async function sign(privateKey: CryptoKey, data: Bytes): Promise<Bytes> {
  return new Uint8Array(await globalThis.crypto.subtle.sign(ED25519, privateKey, data));
}

export async function verifySignature(jwk: PublicJwk, signature: Bytes, data: Bytes): Promise<boolean> {
  return globalThis.crypto.subtle.verify(ED25519, await importPublicKey(jwk), signature, data);
}

const encodeJson = (value: unknown) => toBase64Url(utf8(JSON.stringify(value)));

export async function signToken(claims: Omit<TokenClaims, 'kid'>, key: SigningKey): Promise<string> {
  const header: TokenHeader = { alg: 'EdDSA', typ: 'usher+jwt', kid: key.kid };
  const input = `${encodeJson(header)}.${encodeJson({ ...claims, kid: key.kid })}`;
  return `${input}.${toBase64Url(await sign(key.privateKey, utf8(input)))}`;
}

/** Header and claims without verifying anything. Never trust the result on its own. */
export function decodeToken(token: string): { header: TokenHeader; claims: TokenClaims } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const decode = (s: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(s)));
    return { header: decode(parts[0]!), claims: decode(parts[1]!) };
  } catch {
    return null;
  }
}

/** Remembers accepted token ids until they expire, so each token works once. */
export class ReplayCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly max = 50_000) {}

  /** True the first time a jti is offered (and records it); false for a replay. */
  accept(jti: string, exp: number, now: number = Math.floor(Date.now() / 1000)): boolean {
    // Entries are in insertion order and tokens share one lifetime, so expired ids are at the
    // front: drop them, and the oldest when full.
    for (const [id, until] of this.seen) {
      if (until >= now && this.seen.size < this.max) break;
      this.seen.delete(id);
    }
    if (this.seen.has(jti)) return false;
    this.seen.set(jti, exp + CLOCK_SKEW_SECONDS);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

export type TokenErrorCode =
  | 'malformed'
  | 'unknown_kid'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_issuer'
  | 'wrong_origin'
  | 'wrong_intent'
  | 'replayed';

export type TokenVerification = { ok: true; claims: TokenClaims } | { ok: false; error: TokenErrorCode; message: string };

export interface VerifyOptions {
  /** The registry's key set, or a lookup by kid (which may refetch on a miss). */
  keys: KeySet | ((kid: string) => Promise<PublicJwk | undefined>);
  /** The verifier's own origin; the token must be for it. */
  origin?: string;
  /** The intent the verifier protects. */
  intent?: string;
  /** Registries the verifier trusts. */
  issuers?: string[];
  /** Records the jti; a token seen before fails as replayed. */
  replay?: ReplayCache;
  /** Seconds since the epoch. */
  now?: number;
}

export async function verifyToken(token: string, options: VerifyOptions): Promise<TokenVerification> {
  const fail = (error: TokenErrorCode, message: string): TokenVerification => ({ ok: false, error, message });
  const decoded = decodeToken(token);
  if (!decoded) return fail('malformed', 'Not a three-part token.');
  const { header, claims } = decoded;
  if (header.alg !== 'EdDSA' || header.typ !== 'usher+jwt' || typeof header.kid !== 'string') return fail('malformed', 'Unexpected token header.');
  if (claims.kid !== header.kid) return fail('malformed', 'Header and claims name different keys.');
  for (const name of ['iss', 'sub', 'origin', 'intent', 'sid', 'jti'] as const) {
    if (typeof claims[name] !== 'string') return fail('malformed', `Claim ${name} is missing.`);
  }
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) return fail('malformed', 'Claims iat and exp must be integers.');

  const jwk = typeof options.keys === 'function' ? await options.keys(header.kid) : options.keys.keys.find((k) => k.kid === header.kid);
  if (!jwk) return fail('unknown_kid', `No published key has kid ${header.kid}.`);
  const [h, p, s] = token.split('.') as [string, string, string];
  let valid = false;
  try {
    valid = await verifySignature(jwk, fromBase64Url(s), utf8(`${h}.${p}`));
  } catch {
    valid = false;
  }
  if (!valid) return fail('bad_signature', 'The signature does not verify.');

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (claims.exp <= now - CLOCK_SKEW_SECONDS) return fail('expired', 'The token has expired; knock again.');
  if (claims.iat > now + CLOCK_SKEW_SECONDS) return fail('not_yet_valid', 'The token was issued in the future.');
  if (options.issuers && !options.issuers.includes(claims.iss)) return fail('wrong_issuer', `Tokens from ${claims.iss} are not trusted here.`);
  if (options.origin !== undefined && claims.origin !== options.origin) return fail('wrong_origin', `The token is for ${claims.origin}, not ${options.origin}.`);
  if (options.intent !== undefined && claims.intent !== options.intent) return fail('wrong_intent', `The token allows ${claims.intent}, not ${options.intent}.`);
  if (options.replay && !options.replay.accept(claims.jti, claims.exp, now)) return fail('replayed', 'This token has already been used.');
  return { ok: true, claims };
}

/** A random token or session id. */
export function randomId(bytes = 16): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}
