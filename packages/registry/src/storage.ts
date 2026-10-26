// Registry storage (LU-21): an interface with a JSON-file implementation. Postgres comes when we
// deploy (LU-20). Everything stored is structure: maps, rules, sessions of semantic events, keys.

import { mkdir, readFile, readdir, rename, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrivateJwk, PublicJwk, Risk, UsherMap } from '@usher/core';

export interface MapRecord {
  digest: string;
  map: UsherMap;
  added_at: string;
  /** Agent id that submitted it, for maps from agents. */
  submitted_by?: string;
  drift?: { at: string; live_digest: string; score: number };
}

export interface Rules {
  agents: 'allowed' | 'denied';
  /** Risk levels that need the user's confirmation before the agent acts. */
  confirm: Risk[];
  /** Risk levels only the user may act on. */
  human_only: Risk[];
}

/** Interim per-site rules, until the policy format. Later entries win. */
export interface Policy {
  origin: string;
  default?: Partial<Rules>;
  forms?: { intent?: string; path?: string; rules: Partial<Rules> }[];
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
  putSite(site: Site): Promise<void>;

  getPolicy(origin: string): Promise<Policy | undefined>;
  putPolicy(policy: Policy): Promise<void>;

  getSession(id: string): Promise<Session | undefined>;
  putSession(session: Session): Promise<void>;
  appendEvents(id: string, events: SessionEvent[]): Promise<Session | undefined>;

  /** Append-only logs: lookups and their scores, run reports, drift reports. */
  appendLog(name: 'matches' | 'runs' | 'drift', record: object): Promise<void>;
  readLog(name: 'matches' | 'runs' | 'drift'): Promise<object[]>;
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

  putSite(site: Site): Promise<void> {
    return this.write(this.siteFile(site.origin), site);
  }

  private policyFile(origin: string): string {
    return this.file('policies', `${encodeURIComponent(origin)}.json`);
  }

  getPolicy(origin: string): Promise<Policy | undefined> {
    return this.read<Policy>(this.policyFile(origin));
  }

  putPolicy(policy: Policy): Promise<void> {
    return this.write(this.policyFile(policy.origin), policy);
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

  appendLog(name: 'matches' | 'runs' | 'drift', record: object): Promise<void> {
    return this.serial(async () => {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.file(`${name}.jsonl`), `${JSON.stringify(record)}\n`);
    });
  }

  async readLog(name: 'matches' | 'runs' | 'drift'): Promise<object[]> {
    try {
      const text = await readFile(this.file(`${name}.jsonl`), 'utf8');
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }
}
