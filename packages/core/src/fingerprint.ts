// usher-fp-1 fingerprint (LU-18).
//
// Identifies a form by its structure, not its URL. Per element, in document order:
//   signature = first 12 hex chars of sha256(`${control}|${label}|${required ? 1 : 0}`)
// where label is whitespace-normalised and lowercased, and for actions control is the kind
// (submit, button, link) and required is 0. digest = "sha256:" + sha256(signature.join(",")).
// Uses WebCrypto so it runs in Node and in browsers.

export const FINGERPRINT_ALGO = 'usher-fp-1';

export interface FingerprintElement {
  kind: 'field' | 'action';
  control: string;
  label: string;
  required: boolean;
}

export interface Fingerprint {
  algo: typeof FINGERPRINT_ALGO;
  digest: string;
  signature: string[];
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function signatureInput(el: FingerprintElement): string {
  const label = el.label.replace(/\s+/g, ' ').trim().toLowerCase();
  const required = el.kind === 'field' && el.required ? 1 : 0;
  return `${el.control}|${label}|${required}`;
}

export async function fingerprint(elements: readonly FingerprintElement[]): Promise<Fingerprint> {
  const signature = await Promise.all(elements.map(async (el) => (await sha256Hex(signatureInput(el))).slice(0, 12)));
  return { algo: FINGERPRINT_ALGO, digest: `sha256:${await sha256Hex(signature.join(','))}`, signature };
}

/** Jaccard similarity of two signature sets, from 0 (nothing shared) to 1 (same set). */
export function similarity(a: Fingerprint | readonly string[], b: Fingerprint | readonly string[]): number {
  const sa = new Set('signature' in a ? a.signature : a);
  const sb = new Set('signature' in b ? b.signature : b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  return shared / (sa.size + sb.size - shared);
}
