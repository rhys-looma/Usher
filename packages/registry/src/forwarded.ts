// What a request looked like before a trusted load balancer forwarded it.

import type { IncomingMessage } from 'node:http';

/**
 * The client address, used in memory for rate limits and never stored. A load balancer appends the
 * address it saw to whatever X-Forwarded-For the client sent, so only the last entry can be trusted.
 */
export function clientAddress(req: IncomingMessage, trustProxy = false): string {
  const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').pop()!.trim() : '';
  return forwarded || req.socket.remoteAddress || 'unknown';
}

/** The URL the client asked for, as signed by an agent: https behind a load balancer that ends TLS. */
export function requestUrl(req: IncomingMessage, trustProxy = false): string {
  const proto = trustProxy ? String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() : '';
  const host = (trustProxy && String(req.headers['x-forwarded-host'] ?? '').split(',')[0]!.trim()) || req.headers.host || 'registry';
  return `${proto === 'https' ? 'https' : 'http'}://${host}${req.url ?? '/'}`;
}
