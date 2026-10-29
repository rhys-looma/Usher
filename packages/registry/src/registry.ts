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
  BudgetExceeded,
  type PrivateJwk,
  type PublicJwk,
  publicPart,
  jwkThumbprint,
  type ActionRule,
  type EffectiveRules,
  type RateLimit,
  type Risk,
  agentStanding,
  composePlan,
  browserPlan,
  type BrowserPlan,
  type UsherPlan,
  effectiveRules,
  stricterRule,
  intentLabel,
  words,
  WINDOW_MS,
  ReplayCache,
  fetchKeyDirectory,
  hasSignature,
  verifyHttpMessage,
  type HttpMessage,
  type HttpSignatureCheck,
  RISKS,
  vocabulary,
} from '@usher/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import { publicFetch } from '@usher/core/public-fetch';
import { DEFAULT_THRESHOLD, findMatch, type MatchKind, type MatchResult } from './match.ts';
import { RateLimiter } from './rate-limit.ts';
import type { Resolved } from './client.ts';
import { RulesError, compileRules } from './rules.ts';
import { explainFacts, factsHash, formFacts, type Explanation } from './explain.ts';
import type { MapRecord, Session, SessionEvent, SessionIdentity, Site, Storage } from './storage.ts';

/**
 * Who may see a map. Operator and keeper maps, and verified agent maps, are public; an agent's
 * unverified map is served only to the agent that submitted it, so a wrong or hostile map never
 * reaches another agent.
 */
export function visibleTo(record: MapRecord, agent?: string): boolean {
  return !record.submitted_by || record.map.provenance.verified === true || Boolean(record.verification) || record.submitted_by === agent;
}

/** What two maps of the same structure must agree on: each element's key. */
export function mapKeys(map: UsherMap): string {
  return [...map.fields.map((f) => `${f.id}=${f.key}`), ...map.actions.map((a) => `${a.id}=${a.key}`)].sort().join('|');
}

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
  /** A signing key from configuration (USHER_SIGNING_KEY) instead of one kept in storage. */
  signingKey?: PrivateJwk;
  /** Earlier public keys still published until their tokens expire. */
  retiredKeys?: PublicJwk[];
  /** Called when a form is reported to have drifted (the keeper rebuilds it). */
  onDrift?: (origin: string, path: string) => void;
  /** The model that explains sessions to site owners (Muse Spark, or Spark Open for self-hosters). */
  explainer?: { chat: ChatFn; model: string };
  /** Public URL of the registry, used as the token issuer. A function when it is known only after listening. */
  url: string | (() => string);
  threshold?: number;
  now?: () => Date;
  /** Fetching agents' key directories (Signature-Agent): allow http:// and private hosts (local development only). */
  directories?: { allowHttp?: boolean; fetch?: typeof fetch };
  /**
   * Store maps agents submit and share them with other agents (default true). An agent's map is
   * kept unverified with risk floors, but its keys and locators are the agent's word, so a hostile
   * agent could mislabel a form for everyone: production keeps this off for now (USHER_ACCEPT_MAPS).
   */
  acceptMaps?: boolean;
  /** Maps one agent may submit per hour (default 20). */
  submitLimit?: number;
  /** Checking domain claims: allow localhost and private origins (local development), and test doubles. */
  claims?: { allowPrivate?: boolean; fetch?: typeof fetch; resolveTxt?: (name: string) => Promise<string[][]> };
  /**
   * The demo site whose dashboard anyone can read at /demo/dashboard (USHER_DEMO_DASHBOARD_ORIGIN).
   * Its sessions from agents other than `keepAgents` (ours) are kept 24 hours.
   */
  publicDemo?: { origin: string; keepAgents?: string[] };
}

/** Why a hosted connection can't act on a site that hasn't joined, and what to use instead. */
export function notJoinedMessage(origin: string): string {
  return `Hosted Usher only acts where a site has said yes: ${origin} hasn't joined Usher. To use Usher on any site, run the local server with your own key: npx -y @usher-run/mcp`;
}

/** A site that has joined, as agents are told about it: its name, origin and journeys. */
export interface JoinedSite {
  name: string;
  origin: string;
  demo: boolean;
  /** Listed by Usher's admin, not joined: Usher has mapped it, but the site has no rules, script or token check. */
  listed?: boolean;
  journeys: { start: string; intent: string; label: string; title: string }[];
}

/**
 * A site Usher's admin has opened to hosted Usher without the site joining (/admin/sites): its maps
 * are used, but the site runs no script, checks no token and has set no rules.
 */
export interface ListedSite {
  origin: string;
  name: string;
  /** Journeys the admin named, for pages Usher has no public map of yet (hosted fill maps them as it goes). */
  journeys: { start: string; intent: string }[];
  listed_at: string;
}


/** How long a site's own name for itself is kept before its home page is read again. */
const SITE_NAME_TTL_MS = 86_400_000;

/** Words a site's name often ends with, left out when matching what a person calls it. */
const NAME_SUFFIXES = /\b(motor|motors|insurance|insurers|direct|bank|group|uk|ltd|limited|plc|online)\b/g;
const plainName = (s: string) => s.toLowerCase().replace(NAME_SUFFIXES, ' ').replace(/[^a-z0-9]+/g, '');
/** What people call a product, in the words its intent uses: "PMI" and "medical" are health, "motor" is car. */
const TASK_WORDS: [RegExp, string][] = [
  [/\bpmi\b/gi, 'private medical health insurance'],
  [/\bmedical\b/gi, 'medical health'],
  [/\b(motor|vehicle|auto)\b/gi, '$1 car'],
];
const taskWords = (task: string) => words(TASK_WORDS.reduce((t, [from, to]) => t.replace(from, to), task));

/** A site's own name for itself, from its home page: og:site_name, application-name, or the end of the title. */
export function siteNameFrom(html: string): string | null {
  const meta = (name: string) => new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i').exec(html)?.[1] ?? new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${name}["']`, 'i').exec(html)?.[1];
  const title = /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
  const tail = title?.split(/\s[|·–—-]\s/).pop()?.trim();
  const name = meta('og:site_name') ?? meta('application-name') ?? tail;
  return name ? name.replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim().slice(0, 80) || null : null;
}

/** How long the public demo keeps sessions from other people's agents. */
export const DEMO_SESSION_HOURS = 24;
/** On the public demo, each agent confirms at most five quotes an hour, whatever the site's policy says. */
export const DEMO_SUBMIT_LIMIT: RateLimit = { action: 'form.submit', per: 'agent', max: 5, window: 'hour' };

/** What a registrant publishes to prove they control an origin: either one is enough. */
export interface ClaimInstructions {
  well_known: { url: string; content: { usher_site: '0.1'; site_key: string } };
  dns: { name: string; type: 'TXT'; value: string };
}

export function claimInstructions(site: { origin: string; site_key: string }): ClaimInstructions {
  return {
    well_known: { url: `${site.origin}/.well-known/usher-site.json`, content: { usher_site: '0.1', site_key: site.site_key } },
    dns: { name: `_usher.${new URL(site.origin).hostname}`, type: 'TXT', value: `usher-site=${site.site_key}` },
  };
}

// A key's default risk is the least it can be, whoever wrote the map.
const KEY_FLOOR = new Map(vocabulary.entries.map((e) => [e.key, e.default_risk]));

/** A map with every element's risk raised to at least its key's default (for maps agents share). */
export function floorRisks(map: UsherMap): UsherMap {
  const raise = <T extends { key: string; risk: Risk }>(el: T): T => {
    const floor = KEY_FLOOR.get(el.key);
    return floor && RISKS.indexOf(floor) > RISKS.indexOf(el.risk) ? { ...el, risk: floor } : el;
  };
  return { ...map, fields: map.fields.map(raise), actions: map.actions.map(raise) };
}

/** An unverified registration older than this can be replaced by a new one. */
export const STALE_CLAIM_MS = 24 * 3_600_000;
/** Verified claims are re-checked this often. */
export const RECHECK_MS = 24 * 3_600_000;

/** An agent whose id has been checked, and how. */
type AgentCheck =
  | { ok: true; agentId: string; jwk: PublicJwk; identity: SessionIdentity }
  | { ok: false; error: string; message: string; status: number };

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|\[?f[cd])/i;

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
const error = (status: number, code: string, message: string, extra: object = {}): Reply => ({ status, body: { error: code, message, ...extra } });

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
  private readonly blockedLimit = new RateLimiter(120, 60_000);
  private submitLimiter?: RateLimiter;
  private get submitLimit(): RateLimiter {
    return (this.submitLimiter ??= new RateLimiter(this.options.submitLimit ?? 20, 3_600_000));
  }
  // Sites' own rate limits, one sliding window per (max, window).
  private readonly policyLimits = new Map<string, RateLimiter>();
  // Web Bot Auth: nonces seen until their signatures expire, and agents' key directories.
  private readonly nonces = new ReplayCache();
  private readonly directories = new Map<string, { keys: PublicJwk[]; until: number }>();

  constructor(private readonly options: RegistryOptions) {
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    if (options.onDrift) this.onDrift = options.onDrift;
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
    if (this.options.signingKey) return (this.key = await importSigningKey(this.options.signingKey));
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

  /** A secret for one purpose (signing dashboard cookies), derived from the registry's signing key. */
  async derivedSecret(purpose: string): Promise<string> {
    await this.signingKey();
    const d = this.options.signingKey?.d ?? (await this.storage.signingKeys()).at(-1)!.private_jwk.d;
    return createHash('sha256').update(`usher:${purpose}:${d}`).digest('hex');
  }

  async keySet(): Promise<KeySet> {
    if (!this.keySetCache) {
      const current = await this.signingKey();
      const retired = (this.options.retiredKeys ?? []).map((k) => ({ ...publicPart(k), kid: k.kid ?? '', alg: 'EdDSA' as const, use: 'sig' as const }));
      if (this.options.signingKey) {
        this.keySetCache = { keys: [current.publicJwk, ...retired] };
      } else {
        const stored = await this.storage.signingKeys();
        const keys = await Promise.all(stored.map(async (k) => (await importSigningKey(k.private_jwk)).publicJwk));
        this.keySetCache = { keys: [...keys, ...retired] };
      }
    }
    return this.keySetCache;
  }

  /** Finds the map for a page and logs the lookup with every candidate's score. */
  /** The maps of an origin this caller may see: verified and operator maps, and its own unverified ones. */
  async mapsFor(origin: string, agent?: string): Promise<MapRecord[]> {
    return (await this.storage.mapsForOrigin(origin)).filter((r) => visibleTo(r, agent));
  }

  async lookup(origin: string, path: string, fingerprint: Fingerprint | undefined, via: 'knock' | 'lookup' | 'drift', agent?: string, intent?: string): Promise<MatchResult> {
    // A site with more than one journey (a health quote and a car quote): a knock that says what it
    // came to do is matched only against that journey's maps, so a page can never get another
    // product's map (and a token for the wrong intent).
    const all = await this.mapsFor(origin, agent);
    const forIntent = intent ? all.filter((r) => r.map.form.intent === intent) : [];
    const result = findMatch(fingerprint, path, forIntent.length ? forIntent : all, this.threshold);
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
    // The same limit twice (a site's own and the demo's) counts once.
    const applicable = effective.rate_limits
      .filter((l) => uses.includes(l.action))
      .filter((l, i, all) => all.findIndex((o) => o.action === l.action && o.per === l.per && o.max === l.max && o.window === l.window) === i);
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

  /** A refused agent attempt, for the site's dashboard. Never anything about who the visitor is beyond the agent id. */
  async recordBlocked(entry: { origin: string; path: string; reason: string; source: 'registry' | 'site'; agent?: string; action?: string; hosted?: true }): Promise<void> {
    await this.storage.appendLog('blocked', { ts: this.now().toISOString(), ...entry });
  }

  /** The site's server check reporting a 403 it sent. Needs the site key. */
  async reportBlocked(origin: string, siteKey: string | undefined, body: unknown): Promise<Reply> {
    const site = await this.storage.getSite(origin);
    if (!site || site.site_key !== siteKey) return error(401, 'site_key_required', 'Send the site key for this origin as Usher-Site-Key.');
    if (!this.blockedLimit.allow(site.site_key)) return error(429, 'rate_limited', 'Too many reports.');
    const b = body as { path?: unknown; reason?: unknown; agent?: unknown; action?: unknown } | null;
    const short = (v: unknown) => (typeof v === 'string' && v.length <= 200 ? v : undefined);
    const path = short(b?.path);
    const reason = short(b?.reason);
    if (!path?.startsWith('/') || !reason) return error(400, 'invalid_request', 'Expected { path, reason, agent?, action? }.');
    const agent = short(b?.agent);
    const action = short(b?.action);
    await this.recordBlocked({ origin, path, reason, source: 'site', ...(agent && { agent }), ...(action && { action }) });
    return ok({ recorded: true });
  }

  /** The keys an agent's directory signed for, cached for an hour (failures for a minute). */
  private async directoryKeys(signatureAgent: string): Promise<PublicJwk[]> {
    const cached = this.directories.get(signatureAgent);
    if (cached && cached.until > Date.now()) return cached.keys;
    const allowHttp = this.options.directories?.allowHttp === true;
    let keys: PublicJwk[] = [];
    try {
      if (!allowHttp && PRIVATE_HOST.test(new URL(signatureAgent).hostname)) throw new Error('private host');
      // An agent names its own directory: only the public internet, checked where it connects.
      keys = await fetchKeyDirectory(signatureAgent, { allowHttp, fetch: this.options.directories?.fetch ?? (allowHttp ? fetch : publicFetch) });
    } catch {
      keys = [];
    }
    if (this.directories.size > 10_000) this.directories.clear();
    this.directories.set(signatureAgent, { keys, until: Date.now() + (keys.length ? 3_600_000 : 60_000) });
    return keys;
  }

  /**
   * Checks a Web Bot Auth signature on an agent's request (RFC 9421, tag web-bot-auth). The key
   * comes from the agent's directory (Signature-Agent), from an earlier request, or from the JWK
   * in the body. Null when the request carries no such signature.
   */
  async verifyHttpAgent(message: HttpMessage, body: Uint8Array<ArrayBuffer>): Promise<HttpSignatureCheck | null> {
    if (!hasSignature(message.headers)) return null;
    let bodyJwk: PublicJwk | undefined;
    try {
      bodyJwk = (JSON.parse(new TextDecoder().decode(body)) as { agent?: { jwk?: PublicJwk } } | null)?.agent?.jwk;
    } catch {
      bodyJwk = undefined;
    }
    return verifyHttpMessage(message, {
      require: ['@authority', '@method', '@path'],
      body,
      nonces: this.nonces,
      now: Math.floor(this.now().getTime() / 1000),
      key: async (keyid, signatureAgent) => {
        if (signatureAgent) {
          const keys = await this.directoryKeys(signatureAgent);
          for (const k of keys) if ((await jwkThumbprint(k)) === keyid) return k;
          return undefined;
        }
        return (await this.storage.agentKey(keyid)) ?? bodyJwk;
      },
    });
  }

  /** The agent behind a request: its Web Bot Auth signature if it sent one, else the signed body. */
  /** Checks the agent's signature, and remembers its key unless it is a hosted connection's (`remember` false). */
  private async agentOf(request: unknown, via?: HttpSignatureCheck | null, remember = true): Promise<AgentCheck> {
    let check: AgentCheck;
    if (via) {
      if (!via.ok) return { ok: false, status: 401, error: via.error === 'unknown_key' ? 'unknown_agent' : 'bad_signature', message: `Web Bot Auth: ${via.message}` };
      const claimed = (request as { agent?: { id?: unknown } } | null)?.agent?.id;
      if (claimed !== undefined && claimed !== via.keyid) return { ok: false, status: 401, error: 'bad_signature', message: 'agent.id is not the keyid of the request signature.' };
      check = { ok: true, agentId: via.keyid, jwk: via.jwk, identity: { method: 'web-bot-auth', ...(via.signatureAgent && { signature_agent: via.signatureAgent }) } };
    } else {
      const body = await verifySignedRequest(request, { knownKey: (id) => this.storage.agentKey(id), now: this.now() });
      if (!body.ok) {
        const unsigned = body.error === 'invalid_request' && !(request as { signature?: unknown } | null)?.signature;
        return { ok: false, status: body.error === 'invalid_request' ? (unsigned ? 401 : 400) : 401, error: unsigned ? 'signature_required' : body.error, message: unsigned ? 'Sign the request: a Web Bot Auth HTTP Message Signature, or agent, ts and signature in the body.' : body.message };
      }
      check = { ok: true, agentId: body.agentId, jwk: body.jwk, identity: { method: 'usher-signature' } };
    }
    if (remember && !(await this.storage.agentKey(check.agentId))) await this.storage.putAgentKey(check.agentId, check.jwk);
    return check;
  }

  /** A site's display name: from its own home page once (cached), else its host. */
  async siteName(origin: string, options: { fresh?: boolean } = {}): Promise<string> {
    // Kept a day: a site that renames itself is called by its new name by tomorrow at the latest.
    const cached = options.fresh ? null : await this.storage.getCached<{ name: string; at?: string }>('site-name', origin);
    if (cached && cached.at && this.now().getTime() - Date.parse(cached.at) < SITE_NAME_TTL_MS) return cached.name;
    let name: string | null = null;
    try {
      const get = this.options.claims?.allowPrivate ? fetch : publicFetch;
      // The home page, following up to three redirects that stay on the site.
      let url = `${origin}/`;
      for (let hops = 0; hops < 4; hops++) {
        const res = await get(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (next && new URL(next, url).origin === origin) {
          url = new URL(next, url).href;
          continue;
        }
        if (res.ok) name = siteNameFrom((await res.text()).slice(0, 200_000));
        break;
      }
    } catch {
      name = null;
    }
    const resolved = name ?? new URL(origin).host;
    if (name) await this.storage.putCached('site-name', origin, { name, at: this.now().toISOString() });
    return resolved;
  }

  /** The journeys on a site: each start (a mapped path no other step leads to) and its intent. */
  async journeys(origin: string): Promise<JoinedSite['journeys']> {
    const maps = await this.currentMaps(origin);
    const reached = new Set([...maps.values()].flatMap((m) => m.actions.map((a) => a.leads_to).filter((p): p is string => Boolean(p))));
    const out: JoinedSite['journeys'] = [];
    for (const [path, map] of maps) {
      if (reached.has(path) || !map.form.intent) continue;
      out.push({ start: path, intent: map.form.intent, label: intentLabel(map.form.intent), title: map.form.purpose.replace(/:.*$/, '').trim() });
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }

  /** Every site a hosted connection may act on, with its name and journeys: joined, and listed by the admin. */
  async joinedSites(): Promise<JoinedSite[]> {
    const origins = new Set((await this.storage.listSites()).filter((s) => s.claim).map((s) => s.origin));
    if (this.options.publicDemo) origins.add(this.options.publicDemo.origin);
    const out: JoinedSite[] = [];
    for (const origin of origins) out.push({ name: await this.siteName(origin), origin, demo: origin === this.options.publicDemo?.origin, journeys: await this.journeys(origin) });
    for (const listed of await this.listedSites()) {
      if (origins.has(listed.origin)) continue;
      const mapped = await this.journeys(listed.origin);
      const named = listed.journeys.filter((j) => !mapped.some((m) => m.start === j.start)).map((j) => ({ start: j.start, intent: j.intent, label: intentLabel(j.intent), title: intentLabel(j.intent) }));
      out.push({ name: listed.name, origin: listed.origin, demo: false, listed: true, journeys: [...mapped, ...named].sort((a, b) => a.start.localeCompare(b.start)) });
    }
    return out.filter((s) => s.journeys.length).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Sites the admin has listed for hosted Usher without their joining. */
  async listedSites(): Promise<ListedSite[]> {
    return (await this.storage.getCached<ListedSite[]>('listed-sites', 'all')) ?? [];
  }

  /** Lists a site for hosted Usher (replacing an earlier listing), or unlists it with null. */
  async setListed(origin: string, listing: { name: string; journeys: { start: string; intent: string }[] } | null): Promise<void> {
    const others = (await this.listedSites()).filter((l) => l.origin !== origin);
    await this.storage.putCached('listed-sites', 'all', listing ? [...others, { origin, name: listing.name, journeys: listing.journeys, listed_at: this.now().toISOString() }] : others);
  }

  /**
   * A map hosted Usher's own model built on a site the admin listed: kept as the registry's own
   * (public, schema-checked), so the next fill there needs no model. False anywhere else: joined
   * sites are mapped through their owners, and outside agents' maps stay private until verified.
   */
  async keepListedMap(map: UsherMap): Promise<boolean> {
    const site = await this.storage.getSite(map.origin);
    if (site?.claim || map.origin === this.options.publicDemo?.origin) return false;
    if (!(await this.listedSites()).some((l) => l.origin === map.origin)) return false;
    if (mapSchemaErrors(map)) return false;
    await this.addMap(map);
    return true;
  }

  /**
   * The admin publishes the maps agents built on an origin (hosted fills map pages as they go, each
   * private to its agent until a second agent agrees): the newest unverified one per page, not replaced.
   * Returns how many were published.
   */
  async publishAgentMaps(origin: string): Promise<number> {
    const records = await this.storage.mapsForOrigin(origin);
    const newest = new Map<string, MapRecord>();
    for (const r of records) {
      if (r.replaced) continue;
      const seen = newest.get(r.map.path);
      if (!seen || r.added_at > seen.added_at) newest.set(r.map.path, r);
    }
    const at = this.now().toISOString();
    let published = 0;
    for (const r of newest.values()) {
      if (visibleTo(r)) continue;
      await this.storage.putMap({ ...r, verification: { by: 'admin', at } });
      published++;
    }
    return published;
  }

  /**
   * A site and a task in a person's words, to a journey. The site by display name (with or without
   * words like "Motor"), host, or any URL on it; the task against each journey's intent and title,
   * by words in common, as the compiler's short list does. More than one plausible journey: the
   * choices, never a guess.
   */
  async resolveTask(site: string, task?: string): Promise<Resolved> {
    const joined = await this.joinedSites();
    const said = site.trim();
    let origin: string | null = null;
    try {
      origin = new URL(/^[a-z]+:\/\//i.test(said) ? said : `https://${said}`).origin;
      if (!/\./.test(new URL(origin).hostname) && !/^localhost$/i.test(new URL(origin).hostname)) origin = null;
    } catch {
      origin = null;
    }
    const host = (o: string) => new URL(o).host.replace(/^www\./, '');
    const found =
      joined.find((j) => origin && (j.origin === origin || host(j.origin) === host(origin))) ??
      joined.find((j) => plainName(j.name) === plainName(said) || j.name.toLowerCase() === said.toLowerCase() || host(j.origin).split('.')[0] === plainName(said));
    if (!found) {
      const named = joined.map((j) => `${j.name} (${host(j.origin)})`).join(', ');
      return { status: 'not_joined', message: origin ? notJoinedMessage(origin) : `Hosted Usher only acts where a site has said yes, and "${said}" isn't one of the sites that have joined${named ? ` (${named})` : ''}. To use Usher on any site, run the local server with your own key: npx -y @usher-run/mcp` };
    }
    const choice = (j: JoinedSite['journeys'][number]) => ({ site: found.name, task: j.label, url: `${found.origin}${j.start}`, intent: j.intent });
    const resolved = (j: JoinedSite['journeys'][number]): Resolved => ({ status: 'resolved', url: `${found.origin}${j.start}`, intent: j.intent, site: { name: found.name, origin: found.origin } });
    if (!task?.trim()) return found.journeys.length === 1 ? resolved(found.journeys[0]!) : { status: 'needs_details', message: `${found.name} offers more than one journey: say which.`, choices: found.journeys.map(choice) };
    const want = taskWords(task);
    const scored = found.journeys
      .map((j) => {
        const have = words(`${j.label} ${j.title} ${j.intent.replace(/[._]/g, ' ')}`);
        return { j, score: [...want].filter((w) => have.has(w)).length };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 1 || (scored.length > 1 && scored[0]!.score > scored[1]!.score)) return resolved(scored[0]!.j);
    return { status: 'needs_details', message: scored.length ? `More than one journey on ${found.name} fits "${task}": say which.` : `Nothing on ${found.name} matches "${task}". It offers: ${found.journeys.map((j) => j.label).join(', ')}.`, choices: (scored.length ? scored.map((x) => x.j) : found.journeys).map(choice) };
  }

  /** The public demo site's origin, when this registry has one. */
  get demoOrigin(): string | undefined {
    return this.options.publicDemo?.origin;
  }

  /** Sites a hosted connection may act on: those that have proved their origin, the demo site, and those the admin listed. */
  async joined(origin: string): Promise<boolean> {
    return origin === this.options.publicDemo?.origin || Boolean((await this.storage.getSite(origin))?.claim) || (await this.listedSites()).some((l) => l.origin === origin);
  }

  /**
   * A knock. `as.hosted`: the hosted MCP endpoint knocking in-process for one of its connections,
   * signed with the key it minted for that connection. `as.walkthrough`: the walkthrough mapper
   * knocking for a site's owner, recorded as the agent "walkthrough:<host>". Never reachable over HTTP.
   */
  async knock(request: unknown, via?: HttpSignatureCheck | null, as?: { hosted: true } | { walkthrough: string }): Promise<Reply> {
    const hosted = Boolean(as && 'hosted' in as);
    const walkthrough = as && 'walkthrough' in as ? as.walkthrough : null;
    const invalid = knockSchemaErrors('knockRequest', request);
    if (invalid) return error(400, 'invalid_request', invalid);
    const knock = request as { url: string; intent?: string; fingerprint?: Fingerprint; session?: string; confirmed?: string[] };
    const checked = await this.agentOf(request, via, !as);
    if (!checked.ok) return error(checked.status, checked.error, checked.message);
    const check = hosted ? { ...checked, identity: { method: 'hosted' as const } } : walkthrough ? { ...checked, agentId: `walkthrough:${walkthrough}`, identity: { method: 'walkthrough' as const } } : checked;

    const page = new URL(knock.url);
    if (as && !(await this.joined(page.origin))) return error(403, 'not_joined', notJoinedMessage(page.origin));
    const match = await this.lookup(page.origin, page.pathname, knock.fingerprint, 'knock', check.agentId, knock.intent);
    const map = match.record?.map ?? null;
    const intent = knock.intent ?? map?.form.intent;
    if (!intent) return error(400, 'invalid_request', 'No map matched this page, so the knock must say its intent.');
    const policy = await this.policy(page.origin);
    const effective = effectiveRules(policy, map, page.pathname);
    // The token lasts the journey, so its rules do too: an action is as strict as any page of the
    // site makes it (a declaration on the last page is the person's even when knocking on the first).
    for (const [path, other] of await this.currentMaps(page.origin)) {
      if (path === page.pathname) continue;
      for (const [k, rule] of Object.entries(effectiveRules(policy, other, path).actions)) effective.actions[k] = stricterRule(effective.actions[k] ?? 'allow', rule);
    }
    if (this.options.publicDemo?.origin === page.origin) effective.rate_limits = [...effective.rate_limits, DEMO_SUBMIT_LIMIT];
    const refuse = async (status: number, code: string, message: string, action?: string) => {
      await this.recordBlocked({ origin: page.origin, path: page.pathname, reason: code, source: 'registry', agent: check.agentId, ...(action && { action }), ...(hosted && { hosted: true as const }) });
      return error(status, code, message);
    };
    if (!effective.agent_lane) return refuse(403, 'agents_not_allowed', `${page.origin} does not allow agents on this form.`);
    const standing = agentStanding(policy, check.agentId, hosted);
    if (standing !== 'allowed') return refuse(403, 'agent_blocked', hosted && policy?.agents?.hosted === 'block' ? `${page.origin} does not allow hosted agents. Run Usher locally with your own key instead: npx -y @usher-run/mcp` : `${page.origin} does not allow this agent.`);
    const confirmed = [...new Set(knock.confirmed ?? [])];
    const forbidden = confirmed.filter((k) => effective.actions[k] === 'forbid');
    if (forbidden.length) return refuse(403, 'action_forbidden', `Agents may not do ${forbidden.join(', ')} on ${page.origin}; that is for the user.`, forbidden.join(','));
    const limited = this.withinLimits(effective, page.origin, check.agentId, ['knock', ...confirmed]);
    if (limited) return refuse(429, 'rate_limited', `${page.origin}: ${limited}`, confirmed.join(',') || 'knock');
    const rules = knockRules(effective);

    let session = knock.session ? await this.storage.getSession(knock.session) : undefined;
    if (knock.session && (!session || session.agent !== check.agentId || session.origin !== page.origin)) {
      return error(400, 'invalid_request', 'That session does not belong to this agent and site.');
    }
    const at = this.now();
    if (!session) {
      session = { id: `s_${randomId(12)}`, origin: page.origin, agent: check.agentId, intent, created_at: at.toISOString(), events: [], identity: check.identity };
      await this.storage.putSession(session);
    }
    const summary = this.summary(match);
    await this.storage.appendEvents(session.id, [
      {
        ts: at.toISOString(),
        source: 'registry',
        action: 'knock',
        path: page.pathname,
        detail: { match: summary.kind, score: summary.score, map: summary.digest, identity: check.identity.method, ...(confirmed.length && { confirmed: confirmed.join(',') }) },
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
      ...(hosted && { act: { sub: 'hosted' as const } }),
      cnf: { jwk: check.jwk },
    };
    const token = await signToken(claims, await this.signingKey());
    // For an assistant driving its own browser: open this, and the site script binds the token.
    const entry = new URL(page.href);
    entry.searchParams.set('usher', token);
    return ok({
      usher: '0.1',
      session: session.id,
      token,
      expires_at: new Date(claims.exp * 1000).toISOString().replace('.000Z', 'Z'),
      keys_url: `${this.url}/.well-known/usher-keys.json`,
      events_url: `${this.url}/sessions/${session.id}/events`,
      entry_url: entry.href,
      match: summary,
      map,
      plan: null,
      rules,
    });
  }

  /** Public lookup for the site script: which map this page is, and the rules for it. */
  async lookupPage(body: unknown, authorization?: string): Promise<Reply> {
    const b = body as { origin?: unknown; path?: unknown; fingerprint?: unknown } | null;
    if (typeof b?.origin !== 'string' || typeof b.path !== 'string' || knockSchemaErrors('fingerprint', b.fingerprint)) {
      return error(400, 'invalid_request', 'Expected origin, path and an usher-fp-1 fingerprint.');
    }
    // The site script sends the agent's bound token: that agent also sees its own unverified maps.
    const token = /^Usher\s+(\S+)$/.exec(authorization ?? '')?.[1];
    const claims = token ? await verifyToken(token, { keys: await this.keySet(), issuers: [this.url], now: Math.floor(this.now().getTime() / 1000) }) : null;
    const agent = claims?.ok && claims.claims.origin === b.origin ? claims.claims.sub : undefined;
    const intent = claims?.ok && claims.claims.origin === b.origin ? claims.claims.intent : undefined;
    const match = await this.lookup(b.origin, b.path, b.fingerprint as Fingerprint, 'lookup', agent, intent);
    const map = match.record?.map ?? null;
    return ok({ match: this.summary(match), map, rules: knockRules(effectiveRules(await this.policy(b.origin), map, b.path)) });
  }

  async getMap(origin: string, digest: string, agent?: string): Promise<Reply> {
    const found = await this.storage.getMap(origin, digest);
    const record = found && visibleTo(found, agent) ? found : undefined;
    return record ? ok({ map: record.map, added_at: record.added_at, drift: record.drift ?? null }) : error(404, 'not_found', `No map ${digest}.`);
  }

  /** A signed request from an agent carrying a map it built. */
  async submitMap(request: unknown, via?: HttpSignatureCheck | null): Promise<Reply> {
    if (this.options.acceptMaps === false) return error(403, 'maps_closed', 'This registry is not accepting maps from agents for now. Use the map you built yourself.');
    const check = await this.agentOf(request, via);
    if (!check.ok) return error(check.status, check.error, check.message);
    const map = (request as { map?: UsherMap }).map;
    const invalid = mapSchemaErrors(map);
    if (invalid || !map) return error(400, 'invalid_map', invalid ?? 'No map.');
    if (!this.submitLimit.allow(check.agentId)) return error(429, 'rate_limited', 'Too many maps from this agent; try again in an hour.');
    const existing = await this.storage.getMap(map.origin, map.fingerprint.digest);
    // Another agent's own map for the same structure: agreeing keys count towards verifying it.
    if (existing && existing.submitted_by && existing.submitted_by !== check.agentId && !visibleTo(existing)) {
      const agreed = mapKeys(existing.map) === mapKeys(map);
      if (agreed && !existing.agreements?.includes(check.agentId)) existing.agreements = [...(existing.agreements ?? []), check.agentId];
      if (!agreed) existing.disagreements = (existing.disagreements ?? 0) + 1;
      await this.storage.putMap(existing);
      return ok({ digest: existing.digest, stored: false, agreed });
    }
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
    // An agent's map is kept unverified, with no risk below its key's default.
    const record: MapRecord = { digest: map.fingerprint.digest, map: { ...floorRisks(map), provenance: { ...map.provenance, verified: false } }, added_at: this.now().toISOString(), submitted_by: check.agentId };
    await this.storage.putMap(record);
    // The keeper may rebuild the form itself and verify it (for the sites it visits).
    this.onUnverifiedMap?.(record);
    return { status: 201, body: { digest: record.digest, stored: true, verified: false } };
  }

  /** Set by the server when a keeper runs: a new agent map is rebuilt and compared. */
  onUnverifiedMap?: (record: MapRecord) => void;

  /** Set by the server when a keeper runs: the sites it visits, where it alone verifies maps. */
  keeperVisits?: (origin: string) => boolean;

  /**
   * Whether an agent can confirm another agent's map: it publishes its keys (Web Bot Auth with a
   * Signature-Agent directory), or it has completed a run on another site before. A fresh key made
   * to agree with oneself has neither.
   */
  private async established(check: { agentId: string; identity: SessionIdentity }, origin: string): Promise<boolean> {
    if (check.identity.method === 'web-bot-auth' && check.identity.signature_agent) return true;
    const runs = (await this.storage.readLog('runs')) as { agent?: string; outcome?: string; url?: string }[];
    return runs.some((r) => {
      if (r.agent !== check.agentId || r.outcome !== 'completed' || typeof r.url !== 'string') return false;
      try {
        return new URL(r.url).origin !== origin;
      } catch {
        return false;
      }
    });
  }

  /**
   * The keeper's own map for a form an agent got wrong: it replaces the agent's (which was never
   * served to anyone else), verified, so a bad first submission can't hold the form's fast path.
   */
  async replaceWithKeeperMap(map: UsherMap): Promise<void> {
    const at = this.now().toISOString();
    await this.storage.putMap({ digest: map.fingerprint.digest, map: { ...map, provenance: { ...map.provenance, verified: true } }, added_at: at, verification: { by: 'keeper', at } });
  }

  /** Makes an agent's map verified, and so public. */
  async verifyMap(origin: string, digest: string, by: 'agent' | 'keeper', verifier?: string): Promise<boolean> {
    const record = await this.storage.getMap(origin, digest);
    if (!record || record.verification) return false;
    record.verification = { by, ...(verifier && { verifier }), at: this.now().toISOString() };
    record.map = { ...record.map, provenance: { ...record.map.provenance, verified: true } };
    await this.storage.putMap(record);
    return true;
  }

  /** Set by the server when a keeper runs: drift reports trigger a check of that form. */
  onDrift?: (origin: string, path: string) => void;

  /**
   * Stores a new version of a form's map and marks the old one replaced (it is kept). The new
   * version is current: it is the newest for its path.
   */
  async replaceMap(old: MapRecord, map: UsherMap): Promise<void> {
    const at = this.now().toISOString();
    const existing = await this.storage.getMap(map.origin, map.fingerprint.digest);
    // A form that changed back gets its earlier version again, clean: no drift, not replaced.
    // Built by the keeper itself, so public whoever first submitted the form's earlier version.
    await this.storage.putMap({ digest: map.fingerprint.digest, map: existing?.map ?? map, added_at: at, ...(existing?.submitted_by && { submitted_by: existing.submitted_by }), verification: existing?.verification ?? { by: 'keeper', at } });
    await this.storage.putMap({ ...old, replaced: { at, by: map.fingerprint.digest } });
    await this.storage.appendLog('drift', { ts: at, origin: map.origin, path: map.path, map: old.digest, rebuilt: map.fingerprint.digest, changed_at: old.drift?.at ?? null });
  }

  /** Seeds or replaces a map directly (operator use, not over the public API). */
  async addMap(map: UsherMap): Promise<void> {
    const invalid = mapSchemaErrors(map);
    if (invalid) throw new Error(`Invalid map: ${invalid}`);
    await this.storage.putMap({ digest: map.fingerprint.digest, map, added_at: this.now().toISOString() });
  }

  /** A signed run report from the agent that owns the session. */
  async reportRun(request: unknown, via?: HttpSignatureCheck | null, as?: { hosted: true }): Promise<Reply> {
    const check = await this.agentOf(request, via, !as?.hosted);
    if (!check.ok) return error(check.status, check.error, check.message);
    const run = request as { session?: string; url?: string; outcome?: string; summary?: Record<string, unknown> };
    const session = typeof run.session === 'string' ? await this.storage.getSession(run.session) : undefined;
    if (!session || session.agent !== check.agentId) return error(404, 'not_found', 'No such session for this agent.');
    const { signature: _s, agent: _a, ...report } = request as Record<string, unknown>;
    await this.storage.appendLog('runs', { ...report, agent: check.agentId, received_at: this.now().toISOString() });
    const path = typeof run.url === 'string' ? new URL(run.url).pathname : undefined;
    // A completed run by an agent whose own maps agreed with another agent's maps of the pages it
    // went through verifies those maps: two independent agents, the same keys, and it worked. The
    // confirming agent must be established, and on sites the keeper visits the keeper decides.
    if (run.outcome === 'completed' && !this.keeperVisits?.(session.origin) && (await this.established(check, session.origin))) {
      const pages = new Set([...session.events.filter((e) => e.action === 'knock' && e.path).map((e) => e.path!), ...(path ? [path] : [])]);
      for (const record of await this.storage.mapsForOrigin(session.origin)) {
        if (pages.has(record.map.path) && !visibleTo(record) && record.submitted_by !== check.agentId && record.agreements?.includes(check.agentId)) await this.verifyMap(session.origin, record.digest, 'agent', check.agentId);
      }
    }
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
  /** Sessions for origins nobody registered: nobody can read them, so they go after the default retention. */
  async pruneUnregisteredSessions(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - DEFAULT_RETENTION_DAYS * 86_400_000).toISOString();
    return this.storage.deleteSessionsBefore(cutoff, (await this.storage.listSites()).map((s) => s.origin));
  }

  async pruneSessions(origin: string): Promise<number> {
    const days = (await this.policy(origin))?.retention?.session_days ?? DEFAULT_RETENTION_DAYS;
    const cutoff = this.now().getTime() - days * 86_400_000;
    // On the public demo, other people's agents' sessions go after a day.
    const demo = this.options.publicDemo?.origin === origin ? this.options.publicDemo : undefined;
    const demoCutoff = this.now().getTime() - DEMO_SESSION_HOURS * 3_600_000;
    let removed = 0;
    for (const session of await this.storage.listSessions(origin)) {
      const created = Date.parse(session.created_at);
      if (created < cutoff || (demo && !demo.keepAgents?.includes(session.agent) && created < demoCutoff)) {
        await this.storage.deleteSession(session.id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Registers an origin with keys from configuration, if it isn't registered, and counts it as
   * claimed: the operator who configured the keys controls the deployment (development only).
   */
  async ensureSite(origin: string, siteKey: string, secret: string): Promise<void> {
    if (!(await this.storage.getSite(origin))) await this.storage.putSite({ origin, site_key: siteKey, secret_sha256: sha256(secret), created_at: this.now().toISOString() });
    await this.claimForDevelopment(origin);
  }

  /**
   * Usher's own site: the front page's interest form carries the tag like any other site's.
   * Registered on first use (its secret key is not kept; "lost your secret key" re-issues one after
   * a claim check), and claimed by the well-known file the registry serves for itself.
   */
  async ownSite(): Promise<Site> {
    const origin = new URL(this.url).origin;
    const site = await this.storage.getSite(origin);
    if (site) return site;
    await this.registerSite({ origin });
    return (await this.storage.getSite(origin))!;
  }

  /** Marks a registered origin as claimed without a check (development keys, local seeding). */
  async claimForDevelopment(origin: string): Promise<void> {
    const site = await this.storage.getSite(origin);
    const at = this.now().toISOString();
    if (site && !site.claim) await this.storage.putSite({ ...site, claim: { method: 'dev', verified_at: at, checked_at: at } });
  }

  /**
   * Registers an origin and issues its keys: a public site key and a secret key, shown once. The
   * site then proves it controls the origin (verifySite); until it does, nothing is shown to it.
   * An unverified registration older than a day can be replaced, so a squatter can't hold an origin.
   */
  async registerSite(body: unknown): Promise<Reply> {
    const origin = (body as { origin?: unknown } | null)?.origin;
    if (typeof origin !== 'string' || !/^https?:\/\/[^/]+$/.test(origin)) return error(400, 'invalid_request', 'Expected { "origin": "https://example.com" }.');
    const existing = await this.storage.getSite(origin);
    if (existing && (existing.claim || this.now().getTime() - Date.parse(existing.created_at) < STALE_CLAIM_MS)) {
      return error(409, 'site_exists', existing.claim ? `${origin} is already registered and claimed.` : `${origin} has a registration waiting to be claimed; it can be replaced after ${new Date(Date.parse(existing.created_at) + STALE_CLAIM_MS).toISOString()}.`);
    }
    const siteKey = `usp_${randomId(18)}`;
    const secret = `uss_${randomId(24)}`;
    const site = { origin, site_key: siteKey, secret_sha256: sha256(secret), created_at: this.now().toISOString() };
    await this.storage.putSite(site);
    return { status: 201, body: { origin, site_key: siteKey, secret_key: secret, claimed: false, claim: claimInstructions(site) } };
  }

  /** Checks the two proofs of control, well-known file first. */
  private async checkClaim(site: Site): Promise<{ method: 'well-known' | 'dns' | null; tried: { method: string; result: string }[] }> {
    const instructions = claimInstructions(site);
    const tried: { method: string; result: string }[] = [];
    const host = new URL(site.origin).hostname;
    if (!this.options.claims?.allowPrivate && PRIVATE_HOST.test(host)) {
      return { method: null, tried: [{ method: 'well-known', result: 'a private or local address can only be claimed with development keys' }] };
    }
    try {
      // The registrant chose this origin: only the public internet, checked where it connects.
      const res = await (this.options.claims?.fetch ?? (this.options.claims?.allowPrivate ? fetch : publicFetch))(instructions.well_known.url, { signal: AbortSignal.timeout(5000), redirect: 'error', headers: { Accept: 'application/json' } });
      const text = res.ok ? await res.text() : '';
      const body = text.length < 10_000 ? (JSON.parse(text || 'null') as { site_key?: unknown } | null) : null;
      if (body?.site_key === site.site_key) return { method: 'well-known', tried };
      tried.push({ method: 'well-known', result: res.ok ? 'the file does not contain this site key' : `HTTP ${res.status}` });
    } catch (err) {
      tried.push({ method: 'well-known', result: err instanceof SyntaxError ? 'not JSON' : 'could not be fetched' });
    }
    try {
      const resolveTxt = this.options.claims?.resolveTxt ?? (async (name: string) => (await import('node:dns/promises')).resolveTxt(name));
      const records = (await resolveTxt(instructions.dns.name)).map((parts) => parts.join(''));
      if (records.includes(instructions.dns.value)) return { method: 'dns', tried };
      tried.push({ method: 'dns', result: records.length ? 'no TXT record with this site key' : 'no TXT records' });
    } catch {
      tried.push({ method: 'dns', result: 'no TXT records' });
    }
    return { method: null, tried };
  }

  /** The site proves it controls its origin. Needs the secret key (or an authenticated dashboard). */
  async verifySite(origin: string, authorization: string | undefined): Promise<Reply> {
    if (!(await this.siteForSecret(origin, authorization))) return error(401, 'secret_key_required', 'Send the site\'s secret key as Authorization: Bearer.');
    return this.verifySiteFor(origin);
  }

  /**
   * A new secret key for a site whose owner lost theirs, only after a fresh check of the domain
   * claim (whatever was proved before): whoever can publish the file or the DNS record controls
   * the origin. The old key stops working. Shown once, like the first.
   */
  async reissueSecret(origin: string): Promise<Reply> {
    const site = await this.storage.getSite(origin);
    if (!site) return error(404, 'not_found', `${origin} is not registered.`);
    const { method, tried } = await this.checkClaim(site);
    if (!method) return error(422, 'claim_not_found', `Neither proof was found: ${tried.map((t) => `${t.method}: ${t.result}`).join('; ')}.`, { claim: claimInstructions(site), tried });
    const secret = `uss_${randomId(24)}`;
    const at = this.now().toISOString();
    await this.storage.putSite({ ...site, secret_sha256: sha256(secret), claim: { method, verified_at: at, checked_at: at } });
    return ok({ origin, site_key: site.site_key, secret_key: secret });
  }

  async verifySiteFor(origin: string): Promise<Reply> {
    const site = await this.storage.getSite(origin);
    if (!site) return error(404, 'not_found', `${origin} is not registered.`);
    if (site.claim) return ok({ claimed: true, method: site.claim.method, verified_at: site.claim.verified_at });
    const { method, tried } = await this.checkClaim(site);
    if (!method) return error(422, 'claim_not_found', `Neither proof was found: ${tried.map((t) => `${t.method}: ${t.result}`).join('; ')}.`, { claim: claimInstructions(site), tried });
    const at = this.now().toISOString();
    await this.storage.putSite({ ...site, claim: { method, verified_at: at, checked_at: at } });
    return ok({ claimed: true, method, verified_at: at });
  }

  /**
   * Re-checks claims older than a day. A check that fails counts against the claim; the third in a
   * row withdraws it, and the dashboard shows nothing until the site proves control again.
   */
  async recheckClaims(): Promise<{ checked: number; withdrawn: string[] }> {
    const withdrawn: string[] = [];
    let checked = 0;
    for (const site of await this.storage.listSites()) {
      const claim = site.claim;
      if (!claim || claim.method === 'dev' || this.now().getTime() - Date.parse(claim.checked_at) < RECHECK_MS) continue;
      checked++;
      const { method } = await this.checkClaim(site);
      if (method) {
        await this.storage.putSite({ ...site, claim: { method, verified_at: claim.verified_at, checked_at: this.now().toISOString() } });
        continue;
      }
      const failures = (claim.failures ?? 0) + 1;
      if (failures >= 3) {
        const { claim: _, ...unclaimed } = site;
        await this.storage.putSite(unclaimed);
        withdrawn.push(site.origin);
      } else {
        // checked_at stays, so the next run tries again.
        await this.storage.putSite({ ...site, claim: { ...claim, failures } });
      }
    }
    return { checked, withdrawn };
  }

  /** The site for this secret, if it has also proved control of its origin. */
  private async claimedSite(origin: string, authorization: string | undefined): Promise<Reply | null> {
    const site = await this.siteForSecret(origin, authorization);
    if (!site) return error(401, 'secret_key_required', 'Send the site\'s secret key as Authorization: Bearer.');
    if (!site.claim) return error(403, 'claim_required', `Prove you control ${origin} first: publish the well-known file or the DNS record, then POST /sites/<origin>/verify.`, { claim: claimInstructions(site) });
    return null;
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
    const refused = await this.claimedSite(origin, authorization);
    if (refused) return refused;
    return this.proposeRulesFor(origin, (body as { text?: unknown } | null)?.text);
  }

  /** As proposeRules, for a caller that has already authenticated the site (the dashboard). */
  async proposeRulesFor(origin: string, text: unknown): Promise<Reply> {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) return error(400, 'invalid_request', 'Expected { "text": "…" } under 4000 characters.');
    if (!this.options.chat || !this.options.model) return error(503, 'no_model', 'Rules in plain English need a model, and none is set up here yet.');
    const maps = (await this.mapsFor(origin)).map((r) => r.map);
    try {
      const result = await compileRules(this.options.chat, this.options.model, text.trim(), origin, maps);
      const draft = { id: `r_${randomId(9)}`, origin, text: text.trim(), policy: result.policy, summary: result.summary, model: this.options.model, created_at: this.now().toISOString(), status: 'pending' as const };
      await this.storage.putDraft(draft);
      return { status: 201, body: { ...draft, usage: result.usage, cost_usd: result.cost_usd, latency_ms: result.latency_ms } };
    } catch (err) {
      if (err instanceof RulesError) return error(422, 'invalid_rules', err.message);
      if (err instanceof BudgetExceeded) return error(503, 'budget_reached', err.message);
      return error(502, 'model_error', `The model could not be reached or failed: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`);
    }
  }

  /** The demo site everyone may watch, if this registry has one. */
  get publicDemo(): { origin: string; keepAgents?: string[] } | undefined {
    return this.options.publicDemo;
  }

  /** What Muse Spark makes of some rules for an origin's forms, without storing or applying anything. */
  async previewRules(origin: string, text: unknown): Promise<Reply> {
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) return error(400, 'invalid_request', 'Write the rules in under 1000 characters.');
    if (!this.options.chat || !this.options.model) return error(503, 'no_model', 'Rules in plain English need a model, and none is set up here yet.');
    const maps = (await this.mapsFor(origin)).map((r) => r.map);
    try {
      const result = await compileRules(this.options.chat, this.options.model, text.trim(), origin, maps);
      return ok({ text: text.trim(), policy: result.policy, summary: result.summary, model: this.options.model });
    } catch (err) {
      if (err instanceof RulesError) return error(422, 'invalid_rules', err.message);
      if (err instanceof BudgetExceeded) return error(503, 'budget_reached', err.message);
      return error(502, 'model_error', 'The model could not be reached or failed.');
    }
  }

  /** Applies a draft the owner has read. Nothing changes until this is called. */
  async confirmRules(origin: string, id: string, authorization: string | undefined): Promise<Reply> {
    const refused = await this.claimedSite(origin, authorization);
    if (refused) return refused;
    return this.confirmRulesFor(origin, id);
  }

  async confirmRulesFor(origin: string, id: string): Promise<Reply> {
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
    const refused = await this.claimedSite(origin, authorization);
    if (refused) return refused;
    return ok({ current: (await this.storage.getPolicy(origin)) ?? null, drafts: await this.storage.listDrafts(origin) });
  }

  /** A plan for a journey starting at this page, from the current maps and their edges. */
  async getPlan(input: string | null): Promise<Reply> {
    let page: URL;
    try {
      page = new URL(input ?? '');
    } catch {
      return error(400, 'invalid_request', 'Expected ?url= with the first page of the journey.');
    }
    const maps = await this.currentMaps(page.origin);
    const plan = composePlan(page.pathname, maps);
    if (!plan) return error(404, 'not_found', `No map for ${page.origin}${page.pathname} yet: knock, or read the page.`);
    // Each input the person alone answers carries the site's rule for it, so an agent knows before
    // it knocks whether the site permits it to enter the person's own answer.
    const policy = await this.policy(page.origin);
    for (const input of plan.inputs) {
      if (input.risk !== 'needs_user') continue;
      const rule = input.steps.map((path) => effectiveRules(policy, maps.get(path) ?? null, path).actions[input.key]).find((r) => r !== undefined);
      if (rule) input.rule = rule;
    }
    return ok(plan);
  }

  /**
   * The plan for an assistant driving its own browser (core browser-plan.ts), from the journey's
   * published maps: never compiled on request. The url may be the journey's first page, any page on
   * it, or the site's home page (the journey for the intent is chosen). Unmapped: null, and the ask
   * is counted so the admin can see what agents want mapped.
   */
  async browserPlanFor(input: string, intent?: string): Promise<{ plan: UsherPlan; maps: Map<string, UsherMap>; view: BrowserPlan } | null> {
    const url = new URL(input);
    const maps = await this.currentMaps(url.origin);
    let start: string | null = maps.has(url.pathname) ? url.pathname : null;
    // A page within a journey: start from the journey that reaches it.
    const reached = new Set([...maps.values()].flatMap((m) => m.actions.map((a) => a.leads_to).filter((p): p is string => Boolean(p))));
    if (start && reached.has(start)) {
      const first = (await this.journeys(url.origin)).find((j) => composePlan(j.start, maps)?.steps.some((s) => s.path === start));
      if (first) start = first.start;
    }
    if (!start) {
      const journeys = await this.journeys(url.origin);
      const want = intent ?? '';
      start = (journeys.find((j) => j.intent === want) ?? (journeys.length === 1 ? journeys[0] : undefined))?.start ?? null;
      if (!start && !journeys.length) {
        const listed = (await this.listedSites()).find((l) => l.origin === url.origin);
        start = listed?.journeys.find((j) => !intent || j.intent === intent)?.start ?? null;
      }
    }
    const plan = start ? composePlan(start, maps) : null;
    if (!plan) {
      const key = `${url.origin}|${intent ?? ''}`;
      const seen = (await this.storage.getCached<{ origin: string; intent: string | null; asks: number; last: string }>('plan-asks', key)) ?? { origin: url.origin, intent: intent ?? null, asks: 0, last: '' };
      await this.storage.putCached('plan-asks', key, { ...seen, asks: seen.asks + 1, last: this.now().toISOString() });
      const index = new Set((await this.storage.getCached<string[]>('plan-asks', 'index')) ?? []);
      if (!index.has(key)) await this.storage.putCached('plan-asks', 'index', [...index, key].slice(-500));
      return null;
    }
    const site = await this.storage.getSite(url.origin);
    const joined = url.origin === this.options.publicDemo?.origin || Boolean(site?.claim);
    const listed = (await this.listedSites()).find((l) => l.origin === url.origin);
    const policy = joined ? await this.storage.getPolicy(url.origin) : undefined;
    // On a joined site, what it enforces on each step: what only the person may do is marked so.
    const actions = joined ? Object.fromEntries(plan.steps.map((s) => [s.path, effectiveRules(policy?.policy, maps.get(s.path) ?? null, s.path).actions])) : undefined;
    const view = browserPlan(plan, maps, { name: listed?.name ?? (await this.siteName(url.origin)), joined, ...(policy?.text && { siteRules: policy.text }), ...(actions && { actions }) });
    return { plan, maps, view };
  }

  /** What agents asked plans for that Usher hasn't mapped, most asked first (the admin's list). */
  async planAsks(): Promise<{ origin: string; intent: string | null; asks: number; last: string }[]> {
    const index = (await this.storage.getCached<string[]>('plan-asks', 'index')) ?? [];
    const rows = await Promise.all(index.map((k) => this.storage.getCached<{ origin: string; intent: string | null; asks: number; last: string }>('plan-asks', k)));
    return rows.filter((r): r is NonNullable<typeof r> => Boolean(r)).sort((a, b) => b.asks - a.asks);
  }

  /** For /healthz: is storage reachable? */
  async health(): Promise<{ ok: boolean; storage: string }> {
    const kind = this.storage.constructor.name === 'PostgresStorage' ? 'postgres' : 'file';
    try {
      const ping = (this.storage as { ping?: () => Promise<boolean> }).ping;
      const ok = ping ? await ping.call(this.storage) : (await this.storage.listSites(), true);
      return { ok, storage: kind };
    } catch {
      return { ok: false, storage: kind };
    }
  }

  /** The newest map for each path on an origin. */
  async currentMaps(origin: string): Promise<Map<string, UsherMap>> {
    const latest = new Map<string, MapRecord>();
    for (const r of await this.mapsFor(origin)) {
      const seen = latest.get(r.map.path);
      if (!seen || r.added_at > seen.added_at) latest.set(r.map.path, r);
    }
    return new Map([...latest].map(([path, r]) => [path, r.map]));
  }

  /** Cached explanations for each form on an origin. */
  async explanations(origin: string): Promise<Explanation[]> {
    const found = await Promise.all([...(await this.currentMaps(origin)).keys()].map((path) => this.storage.getCached<Explanation>('explanations', `${origin}|${path}`)));
    return found.filter((e): e is Explanation => e !== undefined).sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Explains the last day's agent sessions on each form (or the 20 most recent, if quieter),
   * reusing a cached explanation when nothing has changed. Returns an error message or null.
   */
  async explainOrigin(origin: string): Promise<string | null> {
    if (!this.options.explainer) return 'Explanations need a model, and none is set up here yet.';
    const all = await this.storage.listSessions(origin);
    const dayAgo = new Date(this.now().getTime() - 86_400_000).toISOString();
    const recent = all.filter((s) => s.created_at >= dayAgo);
    const sessions = recent.length ? recent : all.slice(0, 20);
    if (!sessions.length) return 'No agent sessions to explain yet.';
    const blocked = ((await this.storage.readLog('blocked')) as { origin: string; path: string; reason: string }[]).filter((b) => b.origin === origin);
    try {
      for (const [path, map] of await this.currentMaps(origin)) {
        const facts = formFacts(map, sessions, blocked);
        if (!facts.sessions && !Object.keys(facts.refused_attempts as object).length) continue;
        const key = `${origin}|${path}`;
        const cached = await this.storage.getCached<Explanation>('explanations', key);
        if (cached?.facts_sha256 === factsHash(facts)) continue;
        const result = await explainFacts(this.options.explainer.chat, this.options.explainer.model, facts);
        await this.storage.putCached('explanations', key, {
          path,
          text: result.text,
          sessions: facts.sessions as number,
          model: this.options.explainer.model,
          created_at: this.now().toISOString(),
          facts_sha256: result.facts_sha256,
        } satisfies Explanation);
      }
      return null;
    } catch (err) {
      return `The explanation could not be made: ${err instanceof Error ? err.message.slice(0, 160) : 'model error'}`;
    }
  }

  /** One agent session in a few sentences, per page it visited. */
  async explainSession(origin: string, sid: string, regenerate = false): Promise<Explanation | null> {
    const session = await this.storage.getSession(sid);
    if (!session || session.origin !== origin || !this.options.explainer) return null;
    const cached = await this.storage.getCached<Explanation>('session-explanations', sid);
    if (cached && !regenerate) return cached;
    const maps = await this.currentMaps(origin);
    const pages = [...new Set(session.events.map((e) => e.path).filter((p): p is string => !!p))].filter((p) => maps.has(p));
    const facts = { one_agent_session: true, pages: pages.map((p) => formFacts(maps.get(p)!, [session], [])) };
    const result = await explainFacts(this.options.explainer.chat, this.options.explainer.model, facts);
    const explanation: Explanation = { path: pages.join(', '), text: result.text, sessions: 1, model: this.options.explainer.model, created_at: this.now().toISOString(), facts_sha256: result.facts_sha256 };
    await this.storage.putCached('session-explanations', sid, explanation);
    return explanation;
  }

  /** The newest map for a page, so the site script can compare fingerprints locally. */
  async currentMap(origin: string | null, path: string | null): Promise<Reply> {
    if (!origin || !path) return error(400, 'invalid_request', 'Expected ?origin=&path=.');
    const latest = (await this.mapsFor(origin)).filter((r) => r.map.path === path).sort((a, b) => b.added_at.localeCompare(a.added_at))[0];
    return ok(latest ? { digest: latest.digest, signature: latest.map.fingerprint.signature } : { digest: null, signature: null });
  }

  /** A session's log, for its site only: Authorization: Bearer <secret key>. */
  async getSession(sid: string, authorization?: string): Promise<Reply> {
    if (!this.readLimit.allow(authorization ?? 'anonymous')) return error(429, 'rate_limited', 'Too many session reads; slow down.');
    const session = await this.storage.getSession(sid);
    if (!session || !(await this.siteForSecret(session.origin, authorization))) return error(404, 'not_found', 'No such session for this site key.');
    const refused = await this.claimedSite(session.origin, authorization);
    if (refused) return refused;
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
    // An exact match to a version that was replaced: the form changed back, so the current one drifted.
    if (match.kind === 'exact' && !match.record?.replaced) return ok({ drifted: false, current: match.record?.digest });
    record.drift = { at: this.now().toISOString(), live_digest: report.fingerprint.digest, score };
    await this.storage.putMap(record);
    await this.storage.appendLog('drift', { ts: record.drift.at, origin: report.origin, path: report.path, map: record.digest, live: report.fingerprint.digest, score });
    this.onDrift?.(report.origin, report.path);
    return ok({ drifted: true, score });
  }
}
