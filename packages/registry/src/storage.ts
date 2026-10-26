// Registry storage (LU-21): an interface with a JSON-file implementation. Postgres comes when we
// deploy (LU-20). Everything stored is structure: maps, rules, sessions of semantic events, keys.

import { mkdir, readFile, readdir, rename, rm, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PolicyIssue, PrivateJwk, PublicJwk, UsherMap, UsherPolicy } from '@usher/core';

export interface MapRecord {
  digest: string;
  map: UsherMap;
  added_at: string;
  /** Agent id that submitted it, for maps from agents. */
  submitted_by?: string;
  drift?: { at: string; live_digest: string; score: number };
  /** Replaced by a newer version after the form changed. */
  replaced?: { at: string; by: string };
}

/** A site's confirmed policy, with the English it was written in when there was one. */
export interface PolicyRecord {
  policy: UsherPolicy;
  text?: string;
  draft?: string;
  confirmed_at: string;
}

/** A policy proposed from plain English, waiting for the site owner to confirm it. */
export interface RulesDraft {
  id: string;
  origin: string;
  text: string;
  policy: UsherPolicy;
  /** Model notes on how it read the text. */
  summary: string;
  model: string;
  created_at: string;
  status: 'pending' | 'confirmed' | 'superseded';
}

export type EventAction = 'knock' | 'fill' | 'select' | 'choose' | 'check' | 'uncheck' | 'click' | 'submit' | 'held' | 'confirm' | 'handoff' | 'run';

export interface SessionEvent {
  ts: string;
  source: 'site' | 'agent' | 'registry';
  action: EventAction;
  key?: string;
  element?: string;
  path?: string;
  detail?: Record<string, unknown>;
}

export interface Session {
  id: string;
  origin: string;
  agent: string;
  intent: string;
  created_at: string;
  events: SessionEvent[];
}

/** A registered site. The site key is public (it sits in the script tag); the secret is stored hashed. */
export interface Site {
  origin: string;
  site_key: string;
  secret_sha256: string;
  created_at: string;
}

export interface StoredKey {
  kid: string;
  created_at: string;
  private_jwk: PrivateJwk;
}

export interface Storage {
  signingKeys(): Promise<StoredKey[]>;
  addSigningKey(key: StoredKey): Promise<void>;

  agentKey(id: string): Promise<PublicJwk | undefined>;
  putAgentKey(id: string, jwk: PublicJwk): Promise<void>;

  /** Maps belong to an origin: the same structure on two sites is two maps. */
  getMap(origin: string, digest: string): Promise<MapRecord | undefined>;
  putMap(record: MapRecord): Promise<void>;
  mapsForOrigin(origin: string): Promise<MapRecord[]>;

  getSite(origin: string): Promise<Site | undefined>;
  listSites(): Promise<Site[]>;
  putSite(site: Site): Promise<void>;

  getPolicy(origin: string): Promise<PolicyRecord | undefined>;
  putPolicy(record: PolicyRecord): Promise<void>;
  getDraft(origin: string, id: string): Promise<RulesDraft | undefined>;
  putDraft(draft: RulesDraft): Promise<void>;
  listDrafts(origin: string): Promise<RulesDraft[]>;

  getSession(id: string): Promise<Session | undefined>;
  putSession(session: Session): Promise<void>;
  listSessions(origin: string): Promise<Session[]>;
  deleteSession(id: string): Promise<void>;
  appendEvents(id: string, events: SessionEvent[]): Promise<Session | undefined>;

  /** Small cached values by kind and key (compiled labels by fingerprint, explanations). */
  getCached<T>(kind: string, key: string): Promise<T | undefined>;
  putCached(kind: string, key: string, value: unknown): Promise<void>;

  /** Append-only logs: lookups and their scores, run reports, drift reports, blocked attempts. */
  appendLog(name: 'matches' | 'runs' | 'drift' | 'blocked', record: object): Promise<void>;
  /** A log in order, optionally only one origin's entries. */
  readLog(name: 'matches' | 'runs' | 'drift' | 'blocked', origin?: string): Promise<object[]>;

  close?(): Promise<void>;
}

// Files under one directory: keys.json, agents.json, maps/<hex>.json, policies/<host>.json,
// sessions/<id>.json and <log>.jsonl. Writes go through a temporary file and a rename, one at
// a time, so a crash never leaves half a file.
export class FileStorage implements Storage {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<string, unknown>();

  constructor(readonly dir: string) {}

  private file(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read<T>(path: string): Promise<T | undefined> {
    if (this.cache.has(path)) return structuredClone(this.cache.get(path)) as T;
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as T;
      this.cache.set(path, value);
      return structuredClone(value);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  private write(path: string, value: unknown): Promise<void> {
    return this.serial(async () => {
      await mkdir(join(path, '..'), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
      await rename(tmp, path);
      this.cache.set(path, structuredClone(value));
    });
  }

  async signingKeys(): Promise<StoredKey[]> {
    return (await this.read<StoredKey[]>(this.file('keys.json'))) ?? [];
  }

  async addSigningKey(key: StoredKey): Promise<void> {
    await this.write(this.file('keys.json'), [...(await this.signingKeys()), key]);
  }

  async agentKey(id: string): Promise<PublicJwk | undefined> {
    return (await this.read<Record<string, PublicJwk>>(this.file('agents.json')))?.[id];
  }

  async putAgentKey(id: string, jwk: PublicJwk): Promise<void> {
    const agents = (await this.read<Record<string, PublicJwk>>(this.file('agents.json'))) ?? {};
    await this.write(this.file('agents.json'), { ...agents, [id]: jwk });
  }

  private mapFile(origin: string, digest: string): string {
    return this.file('maps', encodeURIComponent(origin), `${digest.replace(/^sha256:/, '')}.json`);
  }

  getMap(origin: string, digest: string): Promise<MapRecord | undefined> {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return Promise.resolve(undefined);
    return this.read<MapRecord>(this.mapFile(origin, digest));
  }

  putMap(record: MapRecord): Promise<void> {
    return this.write(this.mapFile(record.map.origin, record.digest), record);
  }

  async mapsForOrigin(origin: string): Promise<MapRecord[]> {
    let files: string[];
    try {
      files = await readdir(this.file('maps', encodeURIComponent(origin)));
    } catch {
      return [];
    }
    const records = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => this.read<MapRecord>(this.file('maps', encodeURIComponent(origin), f))));
    return records.filter((r): r is MapRecord => r !== undefined);
  }

  private siteFile(origin: string): string {
    return this.file('sites', `${encodeURIComponent(origin)}.json`);
  }

  getSite(origin: string): Promise<Site | undefined> {
    return this.read<Site>(this.siteFile(origin));
  }

  async listSites(): Promise<Site[]> {
    const files = await readdir(this.file('sites')).catch(() => [] as string[]);
    const sites = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => this.read<Site>(this.file('sites', f))));
    return sites.filter((s): s is Site => s !== undefined);
  }

  putSite(site: Site): Promise<void> {
    return this.write(this.siteFile(site.origin), site);
  }

  private policyFile(origin: string): string {
    return this.file('policies', `${encodeURIComponent(origin)}.json`);
  }

  getPolicy(origin: string): Promise<PolicyRecord | undefined> {
    return this.read<PolicyRecord>(this.policyFile(origin));
  }

  putPolicy(record: PolicyRecord): Promise<void> {
    return this.write(this.policyFile(record.policy.origin), record);
  }

  private draftFile(origin: string, id: string): string {
    if (!/^r_[A-Za-z0-9_-]+$/.test(id)) throw new Error('bad draft id');
    return this.file('drafts', encodeURIComponent(origin), `${id}.json`);
  }

  getDraft(origin: string, id: string): Promise<RulesDraft | undefined> {
    if (!/^r_[A-Za-z0-9_-]+$/.test(id)) return Promise.resolve(undefined);
    return this.read<RulesDraft>(this.draftFile(origin, id));
  }

  putDraft(draft: RulesDraft): Promise<void> {
    return this.write(this.draftFile(draft.origin, draft.id), draft);
  }

  async listDrafts(origin: string): Promise<RulesDraft[]> {
    const dir = this.file('drafts', encodeURIComponent(origin));
    const files = await readdir(dir).catch(() => [] as string[]);
    const drafts = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => this.read<RulesDraft>(join(dir, f))));
    return drafts.filter((d): d is RulesDraft => d !== undefined).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  private sessionFile(id: string): string {
    if (!/^s_[A-Za-z0-9_-]+$/.test(id)) throw new Error('bad session id');
    return this.file('sessions', `${id}.json`);
  }

  getSession(id: string): Promise<Session | undefined> {
    if (!/^s_[A-Za-z0-9_-]+$/.test(id)) return Promise.resolve(undefined);
    return this.read<Session>(this.sessionFile(id));
  }

  putSession(session: Session): Promise<void> {
    return this.write(this.sessionFile(session.id), session);
  }

  async listSessions(origin: string): Promise<Session[]> {
    const files = await readdir(this.file('sessions')).catch(() => [] as string[]);
    const sessions = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => this.read<Session>(this.file('sessions', f))));
    return sessions.filter((s): s is Session => s?.origin === origin).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  deleteSession(id: string): Promise<void> {
    return this.serial(async () => {
      const path = this.sessionFile(id);
      this.cache.delete(path);
      await rm(path, { force: true });
    });
  }

  appendEvents(id: string, events: SessionEvent[]): Promise<Session | undefined> {
    // Read and write inside the queue so concurrent appends never lose events.
    return this.serial(async () => {
      const session = await this.getSession(id);
      if (!session) return undefined;
      session.events.push(...events);
      const path = this.sessionFile(id);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(`${path}.tmp`, `${JSON.stringify(session, null, 2)}\n`);
      await rename(`${path}.tmp`, path);
      this.cache.set(path, structuredClone(session));
      return session;
    });
  }

  private cacheFile(kind: string, key: string): string {
    return this.file('cache', kind.replace(/[^a-z0-9-]/gi, '_'), `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
  }

  getCached<T>(kind: string, key: string): Promise<T | undefined> {
    return this.read<T>(this.cacheFile(kind, key));
  }

  putCached(kind: string, key: string, value: unknown): Promise<void> {
    return this.write(this.cacheFile(kind, key), value);
  }

  appendLog(name: 'matches' | 'runs' | 'drift' | 'blocked', record: object): Promise<void> {
    return this.serial(async () => {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.file(`${name}.jsonl`), `${JSON.stringify(record)}\n`);
    });
  }

  async readLog(name: 'matches' | 'runs' | 'drift' | 'blocked', origin?: string): Promise<object[]> {
    try {
      const text = await readFile(this.file(`${name}.jsonl`), 'utf8');
      const all = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { origin?: string });
      return origin ? all.filter((r) => r.origin === origin) : all;
    } catch {
      return [];
    }
  }
}
