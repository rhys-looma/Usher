// The registry (LU-21): knocks, map lookup and submission, sessions, run reports, drift reports
// and the published key set. Transport-free: the HTTP server and tests call these methods.

import {
  TOKEN_LIFETIME_SECONDS,
  generateSigningKey,
  importSigningKey,
  knockSchemaErrors,
  mapSchemaErrors,
  randomId,
  signToken,
  verifySignedRequest,
  verifyToken,
  type Fingerprint,
  type KeySet,
  type SigningKey,
  type TokenClaims,
  type UsherMap,
} from '@usher/core';
import { DEFAULT_THRESHOLD, findMatch, type MatchKind, type MatchResult } from './match.ts';
import type { MapRecord, Policy, Rules, Session, SessionEvent, Storage } from './storage.ts';

export const DEFAULT_RULES: Rules = { agents: 'allowed', confirm: ['consequential'], human_only: ['needs_user'] };

export interface RegistryOptions {
  storage: Storage;
  /** Public URL of the registry, used as the token issuer. A function when it is known only after listening. */
  url: string | (() => string);
  threshold?: number;
  now?: () => Date;
}

export interface Reply {
  status: number;
  body: unknown;
}

export interface MatchSummary {
  kind: MatchKind;
  score: number;
  digest: string | null;
  drifted: boolean;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const error = (status: number, code: string, message: string): Reply => ({ status, body: { error: code, message } });

export function resolveRules(policy: Policy | undefined, intent: string | undefined, path: string): Rules {
  let rules: Rules = { ...DEFAULT_RULES, ...policy?.default };
  for (const form of policy?.forms ?? []) {
    if ((form.intent === undefined || form.intent === intent) && (form.path === undefined || form.path === path)) rules = { ...rules, ...form.rules };
  }
  return rules;
}

export class Registry {
  private key?: SigningKey;
  private keySetCache?: KeySet;
  readonly threshold: number;

  constructor(private readonly options: RegistryOptions) {
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
  }

  get url(): string {
    return typeof this.options.url === 'function' ? this.options.url() : this.options.url;
  }

  get storage(): Storage {
    return this.options.storage;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** The current signing key, created and stored on first use. */
  async signingKey(): Promise<SigningKey> {
    if (this.key) return this.key;
    const stored = await this.storage.signingKeys();
    const latest = stored.at(-1);
    if (latest) {
      this.key = await importSigningKey(latest.private_jwk);
    } else {
      const { key, privateJwk } = await generateSigningKey();
      await this.storage.addSigningKey({ kid: key.kid, created_at: this.now().toISOString(), private_jwk: privateJwk });
      this.key = key;
    }
    return this.key;
  }

  async keySet(): Promise<KeySet> {
    if (!this.keySetCache) {
      await this.signingKey();
      const stored = await this.storage.signingKeys();
      const keys = await Promise.all(stored.map(async (k) => (await importSigningKey(k.private_jwk)).publicJwk));
      this.keySetCache = { keys };
    }
    return this.keySetCache;
  }

  /** Finds the map for a page and logs the lookup with every candidate's score. */
  async lookup(origin: string, path: string, fingerprint: Fingerprint | undefined, via: 'knock' | 'lookup' | 'drift'): Promise<MatchResult> {
    const result = findMatch(fingerprint, path, await this.storage.mapsForOrigin(origin), this.threshold);
    await this.storage.appendLog('matches', {
      ts: this.now().toISOString(),
      via,
      origin,
      path,
      live: fingerprint?.digest ?? null,
      kind: result.kind,
      score: result.score,
      matched: result.record?.digest ?? null,
      threshold: this.threshold,
      scores: result.scores,
    });
    return result;
  }

  private summary(result: MatchResult): MatchSummary {
    return { kind: result.kind, score: result.score, digest: result.record?.digest ?? null, drifted: Boolean(result.record?.drift) };
  }

  async knock(request: unknown): Promise<Reply> {
    const invalid = knockSchemaErrors('knockRequest', request);
    if (invalid) return error(400, 'invalid_request', invalid);
    const knock = request as { url: string; intent?: string; fingerprint?: Fingerprint; session?: string; agent: { id: string } };
    const check = await verifySignedRequest(knock, { knownKey: (id) => this.storage.agentKey(id), now: this.now() });
    if (!check.ok) return error(check.error === 'invalid_request' ? 400 : 401, check.error, check.message);
    if (!(await this.storage.agentKey(check.agentId))) await this.storage.putAgentKey(check.agentId, check.jwk);

    const page = new URL(knock.url);
    const match = await this.lookup(page.origin, page.pathname, knock.fingerprint, 'knock');
    const map = match.record?.map ?? null;
    const intent = knock.intent ?? map?.form.intent;
    if (!intent) return error(400, 'invalid_request', 'No map matched this page, so the knock must say its intent.');
    const rules = resolveRules(await this.storage.getPolicy(page.origin), intent, page.pathname);
    if (rules.agents === 'denied') return error(403, 'agents_not_allowed', `${page.origin} does not allow agents on this form.`);

    let session = knock.session ? await this.storage.getSession(knock.session) : undefined;
    if (knock.session && (!session || session.agent !== check.agentId || session.origin !== page.origin)) {
      return error(400, 'invalid_request', 'That session does not belong to this agent and site.');
    }
    const at = this.now();
    if (!session) {
      session = { id: `s_${randomId(12)}`, origin: page.origin, agent: check.agentId, intent, created_at: at.toISOString(), events: [] };
      await this.storage.putSession(session);
    }
    const summary = this.summary(match);
    await this.storage.appendEvents(session.id, [
      { ts: at.toISOString(), source: 'registry', action: 'knock', path: page.pathname, detail: { match: summary.kind, score: summary.score, map: summary.digest } },
    ]);

    const iat = Math.floor(at.getTime() / 1000);
    const claims: Omit<TokenClaims, 'kid'> = {
      iss: this.url,
      sub: check.agentId,
      origin: page.origin,
      intent,
      map: summary.digest,
      sid: session.id,
      iat,
      exp: iat + TOKEN_LIFETIME_SECONDS,
      jti: randomId(16),
    };
    return ok({
      usher: '0.1',
      session: session.id,
      token: await signToken(claims, await this.signingKey()),
      expires_at: new Date(claims.exp * 1000).toISOString().replace('.000Z', 'Z'),
      keys_url: `${this.url}/.well-known/usher-keys.json`,
      events_url: `${this.url}/sessions/${session.id}/events`,
      match: summary,
      map,
      plan: null,
      rules,
    });
  }

  /** Public lookup for the site script: which map this page is, and the rules for it. */
  async lookupPage(body: unknown): Promise<Reply> {
    const b = body as { origin?: unknown; path?: unknown; fingerprint?: unknown } | null;
    if (typeof b?.origin !== 'string' || typeof b.path !== 'string' || knockSchemaErrors('fingerprint', b.fingerprint)) {
      return error(400, 'invalid_request', 'Expected origin, path and an usher-fp-1 fingerprint.');
    }
    const match = await this.lookup(b.origin, b.path, b.fingerprint as Fingerprint, 'lookup');
    const map = match.record?.map ?? null;
    return ok({ match: this.summary(match), map, rules: resolveRules(await this.storage.getPolicy(b.origin), map?.form.intent, b.path) });
  }

  async getMap(origin: string, digest: string): Promise<Reply> {
    const record = await this.storage.getMap(origin, digest);
    return record ? ok({ map: record.map, added_at: record.added_at, drift: record.drift ?? null }) : error(404, 'not_found', `No map ${digest}.`);
  }

  /** A signed request from an agent carrying a map it built. */
  async submitMap(request: unknown): Promise<Reply> {
    const check = await verifySignedRequest(request, { knownKey: (id) => this.storage.agentKey(id), now: this.now() });
    if (!check.ok) return error(check.error === 'invalid_request' ? 400 : 401, check.error, check.message);
    const map = (request as { map?: UsherMap }).map;
    const invalid = mapSchemaErrors(map);
    if (invalid || !map) return error(400, 'invalid_map', invalid ?? 'No map.');
    if (!(await this.storage.agentKey(check.agentId))) await this.storage.putAgentKey(check.agentId, check.jwk);
    const existing = await this.storage.getMap(map.origin, map.fingerprint.digest);
    if (existing) return ok({ digest: existing.digest, stored: false });
    const record: MapRecord = { digest: map.fingerprint.digest, map: { ...map, provenance: { ...map.provenance, verified: false } }, added_at: this.now().toISOString(), submitted_by: check.agentId };
    await this.storage.putMap(record);
    return { status: 201, body: { digest: record.digest, stored: true } };
  }

  /** Seeds or replaces a map directly (operator use, not over the public API). */
  async addMap(map: UsherMap): Promise<void> {
    const invalid = mapSchemaErrors(map);
    if (invalid) throw new Error(`Invalid map: ${invalid}`);
    await this.storage.putMap({ digest: map.fingerprint.digest, map, added_at: this.now().toISOString() });
  }

  /** A signed run report from the agent that owns the session. */
  async reportRun(request: unknown): Promise<Reply> {
    const check = await verifySignedRequest(request, { knownKey: (id) => this.storage.agentKey(id), now: this.now() });
    if (!check.ok) return error(check.error === 'invalid_request' ? 400 : 401, check.error, check.message);
    const run = request as { session?: string; url?: string; outcome?: string; summary?: Record<string, unknown> };
    const session = typeof run.session === 'string' ? await this.storage.getSession(run.session) : undefined;
    if (!session || session.agent !== check.agentId) return error(404, 'not_found', 'No such session for this agent.');
    const { signature: _s, agent: _a, ...report } = request as Record<string, unknown>;
    await this.storage.appendLog('runs', { ...report, agent: check.agentId, received_at: this.now().toISOString() });
    const path = typeof run.url === 'string' ? new URL(run.url).pathname : undefined;
    await this.storage.appendEvents(session.id, [
      { ts: this.now().toISOString(), source: 'agent', action: 'run', ...(path && { path }), detail: { outcome: run.outcome ?? 'unknown', ...run.summary } },
    ]);
    return ok({ recorded: true });
  }

  /** Events from the site script or the agent, authorised by the session's token. */
  async appendEvents(sid: string, authorization: string | undefined, body: unknown): Promise<Reply> {
    const token = /^Usher\s+(\S+)$/.exec(authorization ?? '')?.[1];
    if (!token) return error(401, 'token_required', 'Send the session token as Authorization: Usher <token>.');
    const verified = await verifyToken(token, { keys: await this.keySet(), issuers: [this.url], now: Math.floor(this.now().getTime() / 1000) });
    if (!verified.ok) return error(401, verified.error, verified.message);
    if (verified.claims.sid !== sid) return error(403, 'wrong_session', 'The token belongs to another session.');
    const invalid = knockSchemaErrors('events', body);
    if (invalid) return error(400, 'invalid_events', invalid);
    const session = await this.storage.appendEvents(sid, (body as { events: SessionEvent[] }).events);
    if (!session) return error(404, 'not_found', 'No such session.');
    return ok({ recorded: (body as { events: unknown[] }).events.length });
  }

  async getSession(sid: string): Promise<Reply> {
    const session = await this.storage.getSession(sid);
    return session ? ok(session satisfies Session) : error(404, 'not_found', 'No such session.');
  }

  /** The site script saw a live form that differs from the registry's map for it. */
  async drift(body: unknown): Promise<Reply> {
    const invalid = knockSchemaErrors('driftReport', body);
    if (invalid) return error(400, 'invalid_request', invalid);
    const report = body as { origin: string; path: string; map: string; fingerprint: Fingerprint };
    const record = await this.storage.getMap(report.origin, report.map);
    if (!record) return error(404, 'not_found', 'No such map for that origin.');
    if (record.digest === report.fingerprint.digest) return ok({ drifted: false });
    // Score it ourselves rather than trusting the reporter.
    const match = await this.lookup(report.origin, report.path, report.fingerprint, 'drift');
    const score = match.scores.find((s) => s.digest === record.digest)?.score ?? 0;
    if (match.kind === 'exact') return ok({ drifted: false, current: match.record?.digest });
    record.drift = { at: this.now().toISOString(), live_digest: report.fingerprint.digest, score };
    await this.storage.putMap(record);
    await this.storage.appendLog('drift', { ts: record.drift.at, origin: report.origin, path: report.path, map: record.digest, live: report.fingerprint.digest, score });
    return ok({ drifted: true, score });
  }
}
