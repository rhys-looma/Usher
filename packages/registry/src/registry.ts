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
  type UsherPolicy,
  type ChatFn,
  type ActionRule,
  type EffectiveRules,
  type Risk,
  agentStanding,
  effectiveRules,
  WINDOW_MS,
} from '@usher/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DEFAULT_THRESHOLD, findMatch, type MatchKind, type MatchResult } from './match.ts';
import { RateLimiter } from './rate-limit.ts';
import { RulesError, compileRules } from './rules.ts';
import type { MapRecord, Session, SessionEvent, Site, Storage } from './storage.ts';

/** The knock response's rules: risk-level defaults, and the effective rule for each key on the form. */
export interface Rules {
  agents: 'allowed' | 'denied';
  confirm: Risk[];
  human_only: Risk[];
  actions: Record<string, ActionRule>;
}

/** How long sessions are kept when a site's policy doesn't say. */
export const DEFAULT_RETENTION_DAYS = 90;

export interface RegistryOptions {
  storage: Storage;
  /** Muse Spark, for turning site owners' plain-English rules into policy. */
  chat?: ChatFn;
  model?: string;
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
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const error = (status: number, code: string, message: string): Reply => ({ status, body: { error: code, message } });

export function knockRules(effective: EffectiveRules): Rules {
  return { agents: effective.agent_lane ? 'allowed' : 'denied', confirm: ['consequential'], human_only: ['needs_user'], actions: effective.actions };
}

export class Registry {
  private key?: SigningKey;
  private keySetCache?: KeySet;
  readonly threshold: number;
  // Per site key for drift reports, per secret for session reads.
  private readonly driftLimit = new RateLimiter(60, 60_000);
  private readonly readLimit = new RateLimiter(120, 60_000);
  // Sites' own rate limits, one sliding window per (max, window).
  private readonly policyLimits = new Map<string, RateLimiter>();

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

  async policy(origin: string): Promise<UsherPolicy | undefined> {
    return (await this.storage.getPolicy(origin))?.policy;
  }

  /** Checks the site's rate limits for these uses and counts them if all allow. */
  private withinLimits(effective: EffectiveRules, origin: string, agent: string, uses: string[]): string | null {
    const applicable = effective.rate_limits.filter((l) => uses.includes(l.action));
    const keyed = applicable.map((l) => {
      const id = `${l.max}/${l.window}`;
      let limiter = this.policyLimits.get(id);
      if (!limiter) this.policyLimits.set(id, (limiter = new RateLimiter(l.max, WINDOW_MS[l.window], () => this.now().getTime())));
      return { limit: l, limiter, key: `${origin}|${l.action}|${l.per === 'agent' ? agent : '*'}` };
    });
    const over = keyed.find((k) => !k.limiter.wouldAllow(k.key));
    if (over) return `At most ${over.limit.max} ${over.limit.action} per ${over.limit.per} per ${over.limit.window}.`;
    for (const k of keyed) k.limiter.allow(k.key);
    return null;
  }

  private summary(result: MatchResult): MatchSummary {
    return { kind: result.kind, score: result.score, digest: result.record?.digest ?? null, drifted: Boolean(result.record?.drift) };
  }

  async knock(request: unknown): Promise<Reply> {
    const invalid = knockSchemaErrors('knockRequest', request);
    if (invalid) return error(400, 'invalid_request', invalid);
    const knock = request as { url: string; intent?: string; fingerprint?: Fingerprint; session?: string; confirmed?: string[]; agent: { id: string } };
    const check = await verifySignedRequest(knock, { knownKey: (id) => this.storage.agentKey(id), now: this.now() });
    if (!check.ok) return error(check.error === 'invalid_request' ? 400 : 401, check.error, check.message);
    if (!(await this.storage.agentKey(check.agentId))) await this.storage.putAgentKey(check.agentId, check.jwk);

    const page = new URL(knock.url);
    const match = await this.lookup(page.origin, page.pathname, knock.fingerprint, 'knock');
    const map = match.record?.map ?? null;
    const intent = knock.intent ?? map?.form.intent;
    if (!intent) return error(400, 'invalid_request', 'No map matched this page, so the knock must say its intent.');
    const policy = await this.policy(page.origin);
    const effective = effectiveRules(policy, map, page.pathname);
    if (!effective.agent_lane) return error(403, 'agents_not_allowed', `${page.origin} does not allow agents on this form.`);
    const standing = agentStanding(policy, check.agentId);
    if (standing !== 'allowed') return error(403, 'agent_blocked', `${page.origin} does not allow this agent.`);
    const confirmed = [...new Set(knock.confirmed ?? [])];
    const forbidden = confirmed.filter((k) => effective.actions[k] === 'forbid');
    if (forbidden.length) return error(403, 'action_forbidden', `Agents may not do ${forbidden.join(', ')} on ${page.origin}; that is for the user.`);
    const limited = this.withinLimits(effective, page.origin, check.agentId, ['knock', ...confirmed]);
    if (limited) return error(429, 'rate_limited', `${page.origin}: ${limited}`);
    const rules = knockRules(effective);

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
      {
        ts: at.toISOString(),
        source: 'registry',
        action: 'knock',
        path: page.pathname,
        detail: { match: summary.kind, score: summary.score, map: summary.digest, ...(confirmed.length && { confirmed: confirmed.join(',') }) },
      },
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
      confirm: Object.keys(effective.actions).filter((k) => effective.actions[k] === 'confirm'),
      forbid: Object.keys(effective.actions).filter((k) => effective.actions[k] === 'forbid'),
      ...(confirmed.length && { confirmed }),
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
    return ok({ match: this.summary(match), map, rules: knockRules(effectiveRules(await this.policy(b.origin), map, b.path)) });
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
    if (existing) {
      // The agent that built a map may come back with edges it learned by acting on it.
      const edges = new Map(map.actions.filter((a) => a.leads_to).map((a) => [a.id, a.leads_to!]));
      const learned = existing.submitted_by === check.agentId && existing.map.actions.some((a) => !a.leads_to && edges.has(a.id));
      if (learned) {
        existing.map.actions = existing.map.actions.map((a) => (a.leads_to || !edges.has(a.id) ? a : { ...a, leads_to: edges.get(a.id)! }));
        await this.storage.putMap(existing);
      }
      return ok({ digest: existing.digest, stored: false, ...(learned && { edges: true }) });
    }
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

  /** Deletes sessions older than each site's retention (policy, or the default). */
  async pruneSessions(origin: string): Promise<number> {
    const days = (await this.policy(origin))?.retention?.session_days ?? DEFAULT_RETENTION_DAYS;
    const cutoff = this.now().getTime() - days * 86_400_000;
    let removed = 0;
    for (const session of await this.storage.listSessions(origin)) {
      if (Date.parse(session.created_at) < cutoff) {
        await this.storage.deleteSession(session.id);
        removed++;
      }
    }
    return removed;
  }

  /** Registers an origin and issues its keys: a public site key and a secret key, shown once. */
  async registerSite(body: unknown): Promise<Reply> {
    const origin = (body as { origin?: unknown } | null)?.origin;
    if (typeof origin !== 'string' || !/^https?:\/\/[^/]+$/.test(origin)) return error(400, 'invalid_request', 'Expected { "origin": "https://example.com" }.');
    if (await this.storage.getSite(origin)) return error(409, 'site_exists', `${origin} is already registered.`);
    const siteKey = `usp_${randomId(18)}`;
    const secret = `uss_${randomId(24)}`;
    await this.storage.putSite({ origin, site_key: siteKey, secret_sha256: sha256(secret), created_at: this.now().toISOString() });
    return { status: 201, body: { origin, site_key: siteKey, secret_key: secret } };
  }

  /** The site whose secret key this Authorization header carries, if it is the given origin's. */
  async siteForSecret(origin: string, authorization: string | undefined): Promise<Site | undefined> {
    const secret = /^Bearer\s+(uss_\S+)$/.exec(authorization ?? '')?.[1];
    const site = secret ? await this.storage.getSite(origin) : undefined;
    if (!site || !secret) return undefined;
    const a = Buffer.from(site.secret_sha256, 'hex');
    const b = Buffer.from(sha256(secret), 'hex');
    return a.length === b.length && timingSafeEqual(a, b) ? site : undefined;
  }

  /** Turns the owner's English into a draft policy, held until they confirm it. */
  async proposeRules(origin: string, authorization: string | undefined, body: unknown): Promise<Reply> {
    if (!(await this.siteForSecret(origin, authorization))) return error(401, 'secret_key_required', 'Send the site\'s secret key as Authorization: Bearer.');
    const text = (body as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) return error(400, 'invalid_request', 'Expected { "text": "…" } under 4000 characters.');
    if (!this.options.chat || !this.options.model) return error(503, 'no_model', 'This registry has no model configured for rules.');
    const maps = (await this.storage.mapsForOrigin(origin)).map((r) => r.map);
    try {
      const result = await compileRules(this.options.chat, this.options.model, text.trim(), origin, maps);
      const draft = { id: `r_${randomId(9)}`, origin, text: text.trim(), policy: result.policy, summary: result.summary, model: this.options.model, created_at: this.now().toISOString(), status: 'pending' as const };
      await this.storage.putDraft(draft);
      return { status: 201, body: { ...draft, usage: result.usage, cost_usd: result.cost_usd, latency_ms: result.latency_ms } };
    } catch (err) {
      if (err instanceof RulesError) return error(422, 'invalid_rules', err.message);
      throw err;
    }
  }

  /** Applies a draft the owner has read. Nothing changes until this is called. */
  async confirmRules(origin: string, id: string, authorization: string | undefined): Promise<Reply> {
    if (!(await this.siteForSecret(origin, authorization))) return error(401, 'secret_key_required', 'Send the site\'s secret key as Authorization: Bearer.');
    const draft = await this.storage.getDraft(origin, id);
    if (!draft || draft.status !== 'pending') return error(404, 'not_found', 'No pending draft with that id.');
    for (const other of await this.storage.listDrafts(origin)) {
      if (other.status === 'pending' && other.id !== id) await this.storage.putDraft({ ...other, status: 'superseded' });
    }
    await this.storage.putDraft({ ...draft, status: 'confirmed' });
    const record = { policy: draft.policy, text: draft.text, draft: draft.id, confirmed_at: this.now().toISOString() };
    await this.storage.putPolicy(record);
    return ok(record);
  }

  async getRules(origin: string, authorization: string | undefined): Promise<Reply> {
    if (!(await this.siteForSecret(origin, authorization))) return error(401, 'secret_key_required', 'Send the site\'s secret key as Authorization: Bearer.');
    return ok({ current: (await this.storage.getPolicy(origin)) ?? null, drafts: await this.storage.listDrafts(origin) });
  }

  /** The newest map for a page, so the site script can compare fingerprints locally. */
  async currentMap(origin: string | null, path: string | null): Promise<Reply> {
    if (!origin || !path) return error(400, 'invalid_request', 'Expected ?origin=&path=.');
    const latest = (await this.storage.mapsForOrigin(origin)).filter((r) => r.map.path === path).sort((a, b) => b.added_at.localeCompare(a.added_at))[0];
    return ok(latest ? { digest: latest.digest, signature: latest.map.fingerprint.signature } : { digest: null, signature: null });
  }

  /** A session's log, for its site only: Authorization: Bearer <secret key>. */
  async getSession(sid: string, authorization?: string): Promise<Reply> {
    if (!this.readLimit.allow(authorization ?? 'anonymous')) return error(429, 'rate_limited', 'Too many session reads; slow down.');
    const session = await this.storage.getSession(sid);
    if (!session || !(await this.siteForSecret(session.origin, authorization))) return error(404, 'not_found', 'No such session for this site key.');
    // Events arrive from the page and the agent independently; show them in time order.
    const events = session.events.map((e, i) => [e, i] as const).sort(([a, i], [b, j]) => a.ts.localeCompare(b.ts) || i - j).map(([e]) => e);
    return ok({ ...session, events } satisfies Session);
  }

  /**
   * The site script saw a live form that differs from the registry's map for it. Needs the
   * origin's public site key (Usher-Site-Key). Nothing about the visitor is stored.
   */
  async drift(body: unknown, siteKey: string | undefined): Promise<Reply> {
    const invalid = knockSchemaErrors('driftReport', body);
    if (invalid) return error(400, 'invalid_request', invalid);
    const report = body as { origin: string; path: string; map: string; fingerprint: Fingerprint };
    const site = await this.storage.getSite(report.origin);
    if (!site || site.site_key !== siteKey) return error(401, 'site_key_required', 'Send the site key for this origin as Usher-Site-Key.');
    if (!this.driftLimit.allow(site.site_key)) return error(429, 'rate_limited', 'Too many drift reports.');
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
