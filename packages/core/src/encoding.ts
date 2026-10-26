// base64url and canonical JSON. WebCrypto-era globals only, so this runs in Node and browsers.

/** Bytes backed by a plain ArrayBuffer, as WebCrypto expects. */
export type Bytes = Uint8Array<ArrayBuffer>;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text);
}

/** JSON with object members sorted by key and no whitespace, so equal values sign equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const members = Object.keys(value)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${members.join(',')}}`;
}

export async function sha256(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}
