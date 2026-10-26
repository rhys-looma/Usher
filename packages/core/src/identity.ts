// Agent identity and signed requests (LU-22).
//
// An agent's id is the RFC 7638 thumbprint of its Ed25519 public key. Knocks and other agent
// writes are signed over "usher-sig-v1\n" + the canonical JSON of the request without its
// signature, so the same request verifies whether it came over HTTP or as an MCP tool call.
// Only how the registry learns the agent id is specific to this scheme; it can be swapped for
// HTTP Message Signatures (RFC 9421) and Web Bot Auth later.

import { canonicalJson, fromBase64Url, toBase64Url, utf8, type Bytes } from './encoding.ts';
import { generateKeyPair, importPrivateKey, jwkThumbprint, publicPart, sign, verifySignature, type PrivateJwk, type PublicJwk } from './token.ts';

export const SIGNATURE_CONTEXT = 'usher-sig-v1\n';
/** Signed requests older or newer than this are refused. */
export const MAX_REQUEST_SKEW_MS = 5 * 60 * 1000;

export interface AgentIdentity {
  id: string;
  publicJwk: PublicJwk;
  sign(data: Bytes): Promise<Bytes>;
}

export interface SignedFields {
  agent: { id: string; jwk?: PublicJwk };
  ts: string;
  signature: string;
}

export async function importAgentIdentity(privateJwk: PrivateJwk): Promise<AgentIdentity> {
  const key = await importPrivateKey(privateJwk);
  const publicJwk = publicPart(privateJwk);
  return { id: await jwkThumbprint(publicJwk), publicJwk, sign: (data) => sign(key, data) };
}

export async function generateAgentIdentity(): Promise<{ identity: AgentIdentity; privateJwk: PrivateJwk }> {
  const { privateJwk } = await generateKeyPair();
  return { identity: await importAgentIdentity(privateJwk), privateJwk };
}

function signingInput(request: object): Bytes {
  const { signature: _, ...rest } = request as Record<string, unknown>;
  return utf8(SIGNATURE_CONTEXT + canonicalJson(rest));
}

export async function signRequest<T extends object>(
  payload: T,
  identity: AgentIdentity,
  options: { includeJwk?: boolean; now?: Date } = {},
): Promise<T & SignedFields> {
  const unsigned = {
    ...payload,
    agent: { id: identity.id, ...(options.includeJwk !== false && { jwk: identity.publicJwk }) },
    ts: (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  return { ...unsigned, signature: toBase64Url(await identity.sign(signingInput(unsigned))) };
}

export type SignedRequestCheck =
  | { ok: true; agentId: string; jwk: PublicJwk }
  | { ok: false; error: 'invalid_request' | 'bad_signature' | 'unknown_agent' | 'stale_request'; message: string };

export interface VerifyRequestOptions {
  /** A key the verifier already holds for this agent id. */
  knownKey?: (agentId: string) => Promise<PublicJwk | undefined>;
  now?: Date;
}

export async function verifySignedRequest(request: unknown, options: VerifyRequestOptions = {}): Promise<SignedRequestCheck> {
  const r = request as Partial<SignedFields> | null;
  if (!r || typeof r !== 'object' || typeof r.signature !== 'string' || typeof r.ts !== 'string' || typeof r.agent?.id !== 'string') {
    return { ok: false, error: 'invalid_request', message: 'A signed request needs agent.id, ts and signature.' };
  }
  const ts = Date.parse(r.ts);
  if (!Number.isFinite(ts) || Math.abs((options.now ?? new Date()).getTime() - ts) > MAX_REQUEST_SKEW_MS) {
    return { ok: false, error: 'stale_request', message: 'ts must be within 5 minutes of the registry clock.' };
  }
  let jwk = r.agent.jwk;
  if (jwk) {
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || (await jwkThumbprint(jwk)) !== r.agent.id) {
      return { ok: false, error: 'bad_signature', message: 'agent.id is not the thumbprint of agent.jwk.' };
    }
  } else {
    jwk = await options.knownKey?.(r.agent.id);
    if (!jwk) return { ok: false, error: 'unknown_agent', message: 'Unknown agent: include agent.jwk the first time.' };
  }
  let valid = false;
  try {
    valid = await verifySignature(jwk, fromBase64Url(r.signature), signingInput(r));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: 'bad_signature', message: 'The request signature does not verify.' };
  return { ok: true, agentId: r.agent.id, jwk: publicPart(jwk) };
}
