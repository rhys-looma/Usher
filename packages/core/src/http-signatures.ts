// HTTP Message Signatures (RFC 9421) as Web Bot Auth profiles them, for agent requests.
//
// An agent signs its requests with its Ed25519 key: Signature-Input names the covered
// components and parameters (created, expires, keyid = the key's RFC 7638 thumbprint, nonce,
// tag="web-bot-auth"), and Signature carries the signature. Signature-Agent, when set, says
// where the agent publishes its keys: a key directory at
// /.well-known/http-message-signatures-directory, itself signed with each key it lists. Request
// bodies are bound with Content-Digest (RFC 9530). The keyid is the same thumbprint Usher already
// uses as the agent id, so a verified signature is a verified agent id.

import { sha256, type Bytes } from './encoding.ts';
import { jwkThumbprint, sign, verifySignature, ReplayCache, type PublicJwk } from './token.ts';
import type { AgentIdentity } from './identity.ts';

export const WEB_BOT_AUTH_TAG = 'web-bot-auth';
export const DIRECTORY_TAG = 'http-message-signatures-directory';
export const KEY_DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
export const KEY_DIRECTORY_TYPE = 'application/http-message-signatures-directory+json';
/** How long a signature is valid for unless the signer says otherwise. */
export const SIGNATURE_TTL_SECONDS = 60;
/** Signatures claiming longer validity than this are refused. */
export const MAX_SIGNATURE_VALIDITY_SECONDS = 3600;
const CLOCK_SKEW_SECONDS = 60;

export type HeaderValue = string | string[] | undefined;

export interface HttpMessage {
  method: string;
  url: string;
  headers: Record<string, HeaderValue>;
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Bytes => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function header(headers: Record<string, HeaderValue>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value : [value]).map((v) => v.trim()).join(', ');
}

/** Content-Digest for a body: sha-256 as a structured byte sequence. */
export async function contentDigest(body: Bytes): Promise<string> {
  return `sha-256=:${toBase64(await sha256(body))}:`;
}

// A component identifier as written in Signature-Input: "@authority", or "@authority";req.
interface Component {
  name: string;
  req: boolean;
}
const parseComponent = (id: string): Component => ({ name: id.replace(/;req$/, ''), req: id.endsWith(';req') });
const serialiseComponent = (c: Component) => `"${c.name}"${c.req ? ';req' : ''}`;

/** A component's value, from the message (or, with ;req, from the request a response answers). */
function componentValue(c: Component, message: HttpMessage, request?: HttpMessage): string | undefined {
  const m = c.req ? request : message;
  if (!m) return undefined;
  const url = new URL(m.url);
  switch (c.name) {
    case '@method':
      return m.method.toUpperCase();
    case '@authority':
      return url.host.toLowerCase();
    case '@path':
      return url.pathname;
    case '@query':
      return url.search || '?';
    case '@target-uri':
      return url.href;
    case '@scheme':
      return url.protocol.replace(/:$/, '');
    default:
      return c.name.startsWith('@') ? undefined : header(m.headers, c.name);
  }
}

function signatureBase(components: Component[], params: string, message: HttpMessage, request?: HttpMessage): string | null {
  const lines: string[] = [];
  for (const c of components) {
    const value = componentValue(c, message, request);
    if (value === undefined) return null;
    lines.push(`${serialiseComponent(c)}: ${value}`);
  }
  lines.push(`"@signature-params": ${params}`);
  return lines.join('\n');
}

/** The signature base for components and a serialised parameter list (exported for test vectors). */
export function signatureBaseFor(componentIds: string[], params: string, message: HttpMessage): string | null {
  return signatureBase(componentIds.map(parseComponent), params, message);
}

export interface SignOptions {
  /** Covered components; @authority always, and signature-agent when it is set. */
  components?: string[];
  /** Where the agent's key directory is (sent as Signature-Agent and covered). */
  signatureAgent?: string;
  tag?: string;
  label?: string;
  ttlSeconds?: number;
  /** Unix seconds. */
  now?: number;
  /** The request a signed response answers (for components with ;req). */
  request?: HttpMessage;
}

/** Signs a message; returns the headers to add (Signature-Input, Signature and Signature-Agent). */
export async function signHttpMessage(message: HttpMessage, identity: AgentIdentity, options: SignOptions = {}): Promise<Record<string, string>> {
  const added: Record<string, string> = {};
  if (options.signatureAgent) added['Signature-Agent'] = `"${options.signatureAgent}"`;
  const headers = { ...message.headers, ...added };
  const ids = [...new Set([...(options.components ?? ['@authority']), ...(options.signatureAgent ? ['signature-agent'] : [])])];
  const components = ids.map(parseComponent);
  const created = options.now ?? Math.floor(Date.now() / 1000);
  const nonce = toBase64(crypto.getRandomValues(new Uint8Array(16)));
  const params = `(${components.map(serialiseComponent).join(' ')});created=${created};expires=${created + (options.ttlSeconds ?? SIGNATURE_TTL_SECONDS)};keyid="${identity.id}";alg="ed25519";nonce="${nonce}";tag="${options.tag ?? WEB_BOT_AUTH_TAG}"`;
  const base = signatureBase(components, params, { ...message, headers }, options.request);
  if (base === null) throw new Error(`Cannot sign: the message lacks one of ${ids.join(', ')}.`);
  const label = options.label ?? 'sig1';
  added['Signature-Input'] = `${label}=${params}`;
  added['Signature'] = `${label}=:${toBase64(await identity.sign(new TextEncoder().encode(base)))}:`;
  return added;
}

/** Splits a structured-field dictionary into members, outside quotes and parentheses. */
function dictionary(value: string): Map<string, string> {
  const members = new Map<string, string>();
  let depth = 0;
  let quoted = false;
  let start = 0;
  const push = (end: number) => {
    const member = value.slice(start, end).trim();
    const eq = member.indexOf('=');
    if (eq > 0) members.set(member.slice(0, eq).trim(), member.slice(eq + 1).trim());
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"' && value[i - 1] !== '\\') quoted = !quoted;
    else if (!quoted && ch === '(') depth++;
    else if (!quoted && ch === ')') depth--;
    else if (!quoted && depth === 0 && ch === ',') {
      push(i);
      start = i + 1;
    }
  }
  push(value.length);
  return members;
}

interface ParsedInput {
  label: string;
  /** The inner list with its parameters, exactly as received (the @signature-params value). */
  raw: string;
  components: Component[];
  params: Record<string, string | number>;
}

function parseInput(label: string, raw: string): ParsedInput | null {
  const m = /^\(([^)]*)\)(.*)$/.exec(raw);
  if (!m) return null;
  const components = [...m[1]!.matchAll(/"([^"]+)"((?:;[a-z]+)*)/g)].map((c) => ({ name: c[1]!, req: c[2]!.includes(';req') }));
  const params: Record<string, string | number> = {};
  for (const p of m[2]!.matchAll(/;([a-z]+)=("(?:[^"\\]|\\.)*"|-?\d+|[A-Za-z0-9_.:/*-]+)/g)) {
    const v = p[2]!;
    params[p[1]!] = v.startsWith('"') ? v.slice(1, -1) : /^-?\d+$/.test(v) ? Number(v) : v;
  }
  return { label, raw, components, params };
}

export type HttpSignatureError = 'no_signature' | 'malformed' | 'expired' | 'missing_component' | 'digest_mismatch' | 'unknown_key' | 'bad_signature' | 'replayed';

export type HttpSignatureCheck =
  | { ok: true; keyid: string; jwk: PublicJwk; signatureAgent: string | null; components: string[]; created: number; expires: number }
  | { ok: false; error: HttpSignatureError; message: string };

export interface VerifyHttpOptions {
  /** The key for a keyid; signatureAgent is the Signature-Agent URL, if the message has one. */
  key(keyid: string, signatureAgent: string | null): Promise<PublicJwk | undefined>;
  tag?: string;
  /** Components the signature must cover. */
  require?: string[];
  /** The body: when non-empty, content-digest must be covered and must match it. */
  body?: Bytes;
  /** Unix seconds. */
  now?: number;
  /** Refuses a keyid and nonce seen before (until the signature expires). */
  nonces?: ReplayCache;
  /** The request a signed response answers (for components with ;req). */
  request?: HttpMessage;
}

/** Whether a message carries a signature with this tag (so a verifier knows to check it). */
export function hasSignature(headers: Record<string, HeaderValue>, tag = WEB_BOT_AUTH_TAG): boolean {
  const input = header(headers, 'signature-input');
  return Boolean(input && input.includes(`tag="${tag}"`));
}

/** The Signature-Agent URL: an sf-string, as Web Bot Auth sends it. */
export function signatureAgentOf(headers: Record<string, HeaderValue>): string | null {
  const value = header(headers, 'signature-agent');
  const m = value && /^"([^"]+)"$/.exec(value);
  return m ? m[1]! : null;
}

export async function verifyHttpMessage(message: HttpMessage, options: VerifyHttpOptions): Promise<HttpSignatureCheck> {
  const fail = (error: HttpSignatureError, text: string): HttpSignatureCheck => ({ ok: false, error, message: text });
  const inputs = header(message.headers, 'signature-input');
  const signatures = header(message.headers, 'signature');
  if (!inputs || !signatures) return fail('no_signature', 'No Signature-Input and Signature headers.');
  const tag = options.tag ?? WEB_BOT_AUTH_TAG;
  const sigs = dictionary(signatures);
  const parsed = [...dictionary(inputs)].map(([label, raw]) => parseInput(label, raw)).find((p) => p?.params.tag === tag);
  if (!parsed) return fail('no_signature', `No signature with tag="${tag}".`);
  const sig = /^:([A-Za-z0-9+/=]+):$/.exec(sigs.get(parsed.label) ?? '');
  const { created, expires, keyid } = parsed.params;
  if (!sig || typeof created !== 'number' || typeof expires !== 'number' || typeof keyid !== 'string') return fail('malformed', 'A signature needs created, expires, keyid and a value.');
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (created > now + CLOCK_SKEW_SECONDS || expires < now - CLOCK_SKEW_SECONDS || expires - created > MAX_SIGNATURE_VALIDITY_SECONDS) {
    return fail('expired', 'The signature is not valid now (created, expires).');
  }
  const covered = parsed.components.map((c) => c.name);
  const signatureAgent = signatureAgentOf(message.headers);
  const required = [...(options.require ?? ['@authority']), ...(header(message.headers, 'signature-agent') !== undefined ? ['signature-agent'] : [])];
  if (options.body?.length) required.push('content-digest');
  const missing = required.filter((r) => !covered.includes(r));
  if (missing.length) return fail('missing_component', `The signature must cover ${missing.join(', ')}.`);
  if (options.body?.length && header(message.headers, 'content-digest') !== (await contentDigest(options.body))) {
    return fail('digest_mismatch', 'Content-Digest does not match the body.');
  }
  const jwk = await options.key(keyid, signatureAgent);
  if (!jwk || (await jwkThumbprint(jwk)) !== keyid) return fail('unknown_key', `No key found for keyid ${keyid}.`);
  const base = signatureBase(parsed.components, parsed.raw, message, options.request);
  let valid = false;
  try {
    valid = base !== null && (await verifySignature(jwk, fromBase64(sig[1]!), new TextEncoder().encode(base)));
  } catch {
    valid = false;
  }
  if (!valid) return fail('bad_signature', 'The signature does not verify.');
  const nonce = parsed.params.nonce;
  if (options.nonces && typeof nonce === 'string' && !options.nonces.accept(`${keyid}|${nonce}`, expires, now)) return fail('replayed', 'This signature was already used.');
  return { ok: true, keyid, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, signatureAgent, components: covered, created, expires };
}

/** The agent's key directory response for a request to it: the JWKS, signed with its key. */
export async function keyDirectoryResponse(identity: AgentIdentity, request: HttpMessage): Promise<{ headers: Record<string, string>; body: string }> {
  const body = JSON.stringify({ keys: [identity.publicJwk] });
  const signed = await signHttpMessage({ method: 'GET', url: request.url, headers: {} }, identity, { components: ['@authority;req'], tag: DIRECTORY_TAG, request, ttlSeconds: 300 });
  return { headers: { 'Content-Type': KEY_DIRECTORY_TYPE, 'Cache-Control': 'max-age=300', ...signed }, body };
}

export interface DirectoryOptions {
  fetch?: typeof fetch;
  /** Allow http:// directories (local development only). */
  allowHttp?: boolean;
  now?: number;
}

/**
 * Fetches a Signature-Agent's key directory and returns the keys it signed for: each listed key
 * must sign the response, so nobody can republish someone else's keys as their own.
 */
export async function fetchKeyDirectory(signatureAgent: string, options: DirectoryOptions = {}): Promise<PublicJwk[]> {
  const base = new URL(signatureAgent);
  if (base.protocol !== 'https:' && !(options.allowHttp && base.protocol === 'http:')) throw new Error('Signature-Agent must be an https URL.');
  const url = base.pathname === KEY_DIRECTORY_PATH ? base.href : new URL(KEY_DIRECTORY_PATH, base.origin).href;
  const res = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(3000), redirect: 'error', headers: { Accept: KEY_DIRECTORY_TYPE } });
  if (!res.ok) throw new Error(`Key directory: HTTP ${res.status}.`);
  const text = await res.text();
  if (text.length > 65_536) throw new Error('Key directory too large.');
  const keys = ((JSON.parse(text) as { keys?: PublicJwk[] }).keys ?? []).filter((k) => k?.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string');
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  const request: HttpMessage = { method: 'GET', url, headers: {} };
  const signed: PublicJwk[] = [];
  // One signature per key, each in its own Signature-Input member.
  const inputs = dictionary(headers['signature-input'] ?? '');
  const sigs = dictionary(headers['signature'] ?? '');
  for (const key of keys) {
    const kid = await jwkThumbprint(key);
    const label = [...inputs].find(([, raw]) => raw.includes(`keyid="${kid}"`))?.[0];
    if (!label) continue;
    const check = await verifyHttpMessage(
      { method: 'GET', url, headers: { 'signature-input': `${label}=${inputs.get(label)}`, signature: `${label}=${sigs.get(label) ?? ''}` } },
      { key: async () => key, tag: DIRECTORY_TAG, require: ['@authority'], request, ...(options.now !== undefined && { now: options.now }) },
    );
    if (check.ok) signed.push({ kty: key.kty, crv: key.crv, x: key.x });
  }
  return signed;
}
