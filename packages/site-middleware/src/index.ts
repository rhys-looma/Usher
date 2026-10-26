// Server-side Usher check (LU-26) for Node HTTP handlers.
//
// The site script in the page is a convenience; this is the lock. On a consequential endpoint
// it verifies the token an agent got by knocking, offline, against the registry's cached keys.
//
// Who is checked: requests that identify as automated (a token, an Usher-Agent or
// Signature-Agent header, or a custom signal) and every request to endpoints meant for
// software, such as an API. People using the normal form flow carry none of those and pass
// through unchanged. An automated browser that never identifies itself also passes: Usher is
// not bot detection.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ReplayCache, decodeToken, verifyToken, type KeySet, type PublicJwk, type TokenClaims, type TokenErrorCode } from '@usher/core/token';
import { vocabulary } from '@usher/core/vocabulary';

// The least an action's default risk allows, so a token from a knock on an unmapped page can't
// skip confirmation.
const DEFAULT_RISK = new Map(vocabulary.entries.map((e) => [e.key, e.default_risk]));

export interface UsherCheckOptions {
  /** The registry the site trusts: tokens must be issued by it. */
  registry: string;
  /** The intent this endpoint protects, e.g. quote.car_insurance. */
  intent: string;
  /** The site's origin as browsers see it, or a function of the request. */
  origin: string | ((req: IncomingMessage) => string);
  keysUrl?: string;
  knockUrl?: string;
  /** How long fetched keys are trusted before a refetch. Default 5 minutes. */
  keysTtlMs?: number;
  /** Extra signal that a request comes from an agent. */
  isAgent?: (req: IncomingMessage) => boolean;
  fetch?: typeof fetch;
  replay?: ReplayCache;
  /** The site's public key: when set, refusals are reported to the registry for the dashboard. */
  siteKey?: string;
  now?: () => number;
}

export interface CheckOptions {
  /** A parsed form body, to read a usher_token field added by the site script. */
  form?: URLSearchParams;
  /** Check even if the request does not identify as an agent (for API endpoints). */
  always?: boolean;
  /** The semantic key this endpoint performs, e.g. form.submit, so the site's rules apply. */
  action?: string;
}

export type UsherCheckResult =
  | { status: 'human' }
  | { status: 'ok'; claims: TokenClaims }
  | { status: 'knock_required'; reason: 'missing' | TokenErrorCode | 'keys_unavailable' | 'action_forbidden' | 'confirmation_required'; message: string };

export interface KnockRequiredBody {
  error: 'knock_required';
  knock_url: string;
  origin: string;
  intent: string;
  reason?: string;
}

export const TOKEN_FIELD = 'usher_token';

/** The token from Authorization: Usher, X-Usher-Token or the usher_token form field, in that order. */
export function tokenFrom(req: IncomingMessage, form?: URLSearchParams): string | undefined {
  const auth = /^Usher\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
  const header = req.headers['x-usher-token'];
  return auth ?? (typeof header === 'string' && header ? header : undefined) ?? (form?.get(TOKEN_FIELD) || undefined);
}

export function identifiesAsAgent(req: IncomingMessage): boolean {
  return Boolean(req.headers['usher-agent'] || req.headers['signature-agent']);
}

// Keys fetched from the registry and kept for a while; an unknown kid triggers at most one
// refetch every 30 seconds, so a flood of bad tokens can't hammer the registry.
class KeyCache {
  private keys?: KeySet;
  private fetchedAt = 0;
  private lastMiss = 0;

  constructor(
    private readonly url: string,
    private readonly ttl: number,
    private readonly doFetch: typeof fetch,
  ) {}

  private async refresh(): Promise<void> {
    const res = await this.doFetch(this.url);
    if (!res.ok) throw new Error(`keys: ${res.status}`);
    this.keys = (await res.json()) as KeySet;
    this.fetchedAt = Date.now();
  }

  async get(kid: string): Promise<PublicJwk | undefined> {
    if (!this.keys || Date.now() - this.fetchedAt > this.ttl) await this.refresh();
    let key = this.keys?.keys.find((k) => k.kid === kid);
    if (!key && Date.now() - this.lastMiss > 30_000) {
      this.lastMiss = Date.now();
      await this.refresh();
      key = this.keys?.keys.find((k) => k.kid === kid);
    }
    return key;
  }
}

export function createUsherCheck(options: UsherCheckOptions) {
  const registry = options.registry.replace(/\/$/, '');
  const knockUrl = options.knockUrl ?? `${registry}/knock`;
  const keys = new KeyCache(options.keysUrl ?? `${registry}/.well-known/usher-keys.json`, options.keysTtlMs ?? 300_000, options.fetch ?? fetch);
  const replay = options.replay ?? new ReplayCache();
  const originOf = (req: IncomingMessage) => (typeof options.origin === 'function' ? options.origin(req) : options.origin);

  async function check(req: IncomingMessage, opts: CheckOptions = {}): Promise<UsherCheckResult> {
    const token = tokenFrom(req, opts.form);
    const agent = Boolean(token) || identifiesAsAgent(req) || options.isAgent?.(req) === true;
    if (!agent && !opts.always) return { status: 'human' };
    if (!token) return { status: 'knock_required', reason: 'missing', message: 'Knock at the registry for a token first.' };
    try {
      const result = await verifyToken(token, {
        keys: (kid) => keys.get(kid),
        origin: originOf(req),
        intent: options.intent,
        issuers: [registry],
        replay,
        ...(options.now && { now: options.now() }),
      });
      if (!result.ok) return { status: 'knock_required', reason: result.error, message: result.message };
      const { claims } = result;
      // The site's rules travel in the token: forbidden actions, and ones the user must confirm.
      const floor = opts.action ? DEFAULT_RISK.get(opts.action) : undefined;
      if (opts.action && (claims.forbid?.includes(opts.action) || floor === 'needs_user')) {
        return { status: 'knock_required', reason: 'action_forbidden', message: `Agents may not do ${opts.action} here.` };
      }
      const needsConfirmation = claims.confirm?.includes(opts.action ?? '') || floor === 'consequential';
      if (opts.action && needsConfirmation && !claims.confirmed?.includes(opts.action)) {
        return { status: 'knock_required', reason: 'confirmation_required', message: `Ask your user, then knock with confirmed: ["${opts.action}"].` };
      }
      return { status: 'ok', claims };
    } catch {
      // Fail closed: without keys no token can be accepted.
      return { status: 'knock_required', reason: 'keys_unavailable', message: 'The registry keys could not be fetched.' };
    }
  }

  function knockRequired(req: IncomingMessage, reason?: string): { status: 403; headers: Record<string, string>; body: KnockRequiredBody } {
    return {
      status: 403,
      headers: { 'Content-Type': 'application/json', Link: `<${knockUrl}>; rel="usher-knock"` },
      body: { error: 'knock_required', knock_url: knockUrl, origin: originOf(req), intent: options.intent, ...(reason && { reason }) },
    };
  }

  /** Sends the 403 knock_required response, and reports it to the registry if a site key is set. */
  function reject(req: IncomingMessage, res: ServerResponse, result?: UsherCheckResult, action?: string): void {
    const reason = result?.status === 'knock_required' ? result.reason : undefined;
    const reply = knockRequired(req, reason);
    res.writeHead(reply.status, reply.headers);
    res.end(JSON.stringify(reply.body));
    if (options.siteKey) {
      // Who: the agent id from the token, or what the agent called itself. Nothing about the visitor.
      const token = tokenFrom(req);
      const agent = (token && decodeToken(token)?.claims.sub) || (typeof req.headers['usher-agent'] === 'string' ? req.headers['usher-agent'].slice(0, 100) : undefined);
      const path = new URL(req.url ?? '/', 'http://site').pathname;
      void (options.fetch ?? fetch)(`${registry}/sites/${encodeURIComponent(originOf(req))}/blocked`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Usher-Site-Key': options.siteKey },
        body: JSON.stringify({ path, reason: reason ?? 'knock_required', ...(agent && { agent }), ...(action && { action }) }),
      }).catch(() => undefined);
    }
  }

  return { check, reject, knockRequired, knockUrl };
}
