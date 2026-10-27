// What a request looked like before trusted proxies forwarded it. In production that is two hops:
// CloudFront, which puts the viewer's address in X-Forwarded-For, then the ALB, which appends
// CloudFront's. Anything to the left of those can be written by the client and is ignored.

import type { IncomingMessage } from 'node:http';

const first = (value: string | string[] | undefined) => String(value ?? '').split(',')[0]!.trim();

/**
 * The client address, used in memory for rate limits and never stored: the X-Forwarded-For entry
 * written by the outermost trusted proxy, `hops` from the right. With no trusted hops, the socket's.
 */
export function clientAddress(req: IncomingMessage, hops = 0): string {
  if (hops > 0) {
    const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((a) => a.trim()).filter(Boolean);
    if (chain.length) return chain[Math.max(0, chain.length - hops)]!;
  }
  return req.socket.remoteAddress || 'unknown';
}

/** The scheme the viewer used: CloudFront's header first (it may reach the ALB over http), then the ALB's. */
export function requestScheme(req: IncomingMessage, hops = 0): 'http' | 'https' {
  if (hops > 0) {
    const proto = first(req.headers['cloudfront-forwarded-proto']) || first(req.headers['x-forwarded-proto']);
    if (proto === 'https' || proto === 'http') return proto;
  }
  return 'http';
}

/**
 * The URL the client asked for, as an agent signs it. The Host header arrives unchanged through
 * CloudFront and the ALB; X-Forwarded-Host is not trusted (nothing in that chain sets it).
 */
export function requestUrl(req: IncomingMessage, hops = 0): string {
  return `${requestScheme(req, hops)}://${req.headers.host ?? 'registry'}${req.url ?? '/'}`;
}
