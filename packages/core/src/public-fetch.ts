// A fetch for addresses an outsider chose (a site's claim file, an agent's key directory, a site's
// robots.txt): only public internet addresses, checked at connect time on the address actually
// used, so a hostname that resolves to a private address, or re-resolves to one (DNS rebinding),
// is refused. Never follows redirects; bodies are capped. Node only.

import { lookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export class PrivateAddressError extends Error {
  constructor(address: string) {
    super(`${address} is not a public internet address.`);
    this.name = 'PrivateAddressError';
  }
}

function v4Private(address: string): boolean {
  const [a, b, c] = address.split('.').map(Number) as [number, number, number];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // shared address space (CGNAT)
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Whether an IP address is anything other than a public unicast internet address. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return v4Private(address);
  if (version !== 6) return true;
  const a = address.toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4 inside IPv6: mapped (::ffff:a.b.c.d or ::ffff:hhhh:hhhh), compatible, NAT64.
  const embedded = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(a)?.[1];
  if (embedded) return v4Private(embedded);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)];
    return v4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (a === '::' || a === '::1') return true;
  const first = parseInt(a.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xffc0) === 0xfec0 || // site-local fec0::/10
    (first & 0xff00) === 0xff00 || // multicast
    (first === 0x2001 && parseInt(a.split(':')[1] || '0', 16) === 0x0db8) || // documentation
    first === 0x64 || first === 0x100 // NAT64 local use, discard
  );
}

/** dns.lookup that refuses non-public answers: what the socket connects to is what was checked. */
export function publicLookup(hostname: string, options: LookupOptions, callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void): void {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const bad = addresses.find((a) => isPrivateAddress(a.address));
    if (bad || !addresses.length) return callback(new PrivateAddressError(bad?.address ?? hostname), '');
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

const MAX_BODY = 1_000_000;

/**
 * GET (or HEAD) a public URL. Redirects are returned, never followed. Rejects with
 * PrivateAddressError for anything that isn't on the public internet.
 */
export async function publicFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError(`Unsupported protocol ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host)) throw new PrivateAddressError(host);
  if (/^localhost$|\.localhost$/i.test(host)) throw new PrivateAddressError(host);
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') throw new TypeError('publicFetch only GETs.');
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const req = send(url, { method, headers, lookup: publicLookup as never, signal: init.signal ?? AbortSignal.timeout(10_000) }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) return void req.destroy(new Error('Response too large.'));
        chunks.push(chunk);
      });
      res.on('end', () => {
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const value of [v].flat()) if (value !== undefined) out.append(k, value);
        const status = res.statusCode ?? 502;
        if (status < 200 || status > 599) return reject(new Error(`Unexpected status ${status}.`));
        resolve(new Response([204, 205, 304].includes(status) || method === 'HEAD' ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage ?? '', headers: out }));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
