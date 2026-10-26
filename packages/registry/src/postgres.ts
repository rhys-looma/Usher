// Postgres storage (LU-52): the same Storage interface as the JSON-file store, for deployment.
// DATABASE_URL selects it; migrations in ../migrations run on start.

import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import type { PublicJwk } from '@usher/core';
import type { MapRecord, PolicyRecord, RulesDraft, Session, SessionEvent, Site, Storage, StoredKey } from './storage.ts';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
type LogName = 'matches' | 'runs' | 'drift' | 'blocked';
const LOG_TABLES: Record<LogName, string> = { matches: 'match_log', runs: 'run_reports', drift: 'drift_reports', blocked: 'blocked_attempts' };

const iso = (d: Date | string | null | undefined) => (d instanceof Date ? d.toISOString() : (d ?? undefined));

export interface PostgresOptions {
  connectionString: string;
  /** A schema of its own (tests use one each); public by default. */
  schema?: string;
  max?: number;
}

/** Applies every migration not yet applied, in name order, each in a transaction. */
export async function migrate(pool: pg.Pool, schema: string): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    // One migrator at a time, so two registries starting together don't race.
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`usher-migrate-${schema}`]);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(await readFile(new URL(file, MIGRATIONS), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`usher-migrate-${schema}`]);
  } finally {
    client.release();
  }
  return applied;
}

export class PostgresStorage implements Storage {
  private constructor(
    readonly pool: pg.Pool,
    readonly schema: string,
  ) {}

  static async connect(options: PostgresOptions): Promise<PostgresStorage> {
    const schema = options.schema ?? 'public';
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('bad schema name');
    // The schema is set for every connection at connect time, before any query runs.
    const pool = new pg.Pool({ connectionString: options.connectionString, max: options.max ?? 10, options: `-c search_path=${schema}` });
    await migrate(pool, schema);
    return new PostgresStorage(pool, schema);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async rows<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(sql, params)).rows;
  }

  async signingKeys(): Promise<StoredKey[]> {
    const rows = await this.rows<{ kid: string; created_at: Date; private_jwk: StoredKey['private_jwk'] }>('SELECT kid, created_at, private_jwk FROM signing_keys ORDER BY created_at');
    return rows.map((r) => ({ kid: r.kid, created_at: iso(r.created_at)!, private_jwk: r.private_jwk }));
  }

  async addSigningKey(key: StoredKey): Promise<void> {
    await this.pool.query('INSERT INTO signing_keys (kid, created_at, private_jwk) VALUES ($1, $2, $3) ON CONFLICT (kid) DO NOTHING', [key.kid, key.created_at, key.private_jwk]);
  }

  async agentKey(id: string): Promise<PublicJwk | undefined> {
    return (await this.rows<{ jwk: PublicJwk }>('SELECT jwk FROM agent_keys WHERE agent_id = $1', [id]))[0]?.jwk;
  }

  async putAgentKey(id: string, jwk: PublicJwk): Promise<void> {
    await this.pool.query('INSERT INTO agent_keys (agent_id, jwk) VALUES ($1, $2) ON CONFLICT (agent_id) DO UPDATE SET jwk = EXCLUDED.jwk', [id, jwk]);
  }

  async getMap(origin: string, digest: string): Promise<MapRecord | undefined> {
    return (await this.rows<{ record: MapRecord }>('SELECT record FROM maps WHERE origin = $1 AND digest = $2', [origin, digest]))[0]?.record;
  }

  async putMap(record: MapRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO maps (origin, digest, path, signature, added_at, submitted_by, drifted_at, record) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (origin, digest) DO UPDATE SET path = EXCLUDED.path, signature = EXCLUDED.signature, submitted_by = EXCLUDED.submitted_by, drifted_at = EXCLUDED.drifted_at, record = EXCLUDED.record`,
        [record.map.origin, record.digest, record.map.path, record.map.fingerprint.signature, record.added_at, record.submitted_by ?? null, record.drift?.at ?? null, record],
      );
      await client.query('DELETE FROM edges WHERE origin = $1 AND digest = $2', [record.map.origin, record.digest]);
      for (const a of record.map.actions.filter((a) => a.leads_to)) {
        await client.query('INSERT INTO edges (origin, digest, action_id, action_key, from_path, leads_to) VALUES ($1, $2, $3, $4, $5, $6)', [
          record.map.origin,
          record.digest,
          a.id,
          a.key,
          record.map.path,
          a.leads_to,
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async mapsForOrigin(origin: string): Promise<MapRecord[]> {
    return (await this.rows<{ record: MapRecord }>('SELECT record FROM maps WHERE origin = $1 ORDER BY added_at', [origin])).map((r) => r.record);
  }

  async getSite(origin: string): Promise<Site | undefined> {
    const r = (await this.rows<{ origin: string; site_key: string; secret_sha256: string; created_at: Date }>('SELECT * FROM sites WHERE origin = $1', [origin]))[0];
    return r && { origin: r.origin, site_key: r.site_key, secret_sha256: r.secret_sha256, created_at: iso(r.created_at)! };
  }

  async listSites(): Promise<Site[]> {
    const rows = await this.rows<{ origin: string; site_key: string; secret_sha256: string; created_at: Date }>('SELECT * FROM sites ORDER BY origin');
    return rows.map((r) => ({ origin: r.origin, site_key: r.site_key, secret_sha256: r.secret_sha256, created_at: iso(r.created_at)! }));
  }

  async putSite(site: Site): Promise<void> {
    await this.pool.query(
      'INSERT INTO sites (origin, site_key, secret_sha256, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (origin) DO UPDATE SET site_key = EXCLUDED.site_key, secret_sha256 = EXCLUDED.secret_sha256',
      [site.origin, site.site_key, site.secret_sha256, site.created_at],
    );
  }

  async getPolicy(origin: string): Promise<PolicyRecord | undefined> {
    const r = (await this.rows<{ policy: PolicyRecord['policy']; english: string | null; draft_id: string | null; confirmed_at: Date }>('SELECT * FROM policies WHERE origin = $1', [origin]))[0];
    return r && { policy: r.policy, ...(r.english && { text: r.english }), ...(r.draft_id && { draft: r.draft_id }), confirmed_at: iso(r.confirmed_at)! };
  }

  async putPolicy(record: PolicyRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO policies (origin, policy, english, draft_id, confirmed_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (origin) DO UPDATE SET policy = EXCLUDED.policy, english = EXCLUDED.english, draft_id = EXCLUDED.draft_id, confirmed_at = EXCLUDED.confirmed_at`,
      [record.policy.origin, record.policy, record.text ?? null, record.draft ?? null, record.confirmed_at],
    );
  }

  private draftOf(r: { id: string; origin: string; english: string; policy: RulesDraft['policy']; summary: string; model: string; created_at: Date; status: RulesDraft['status'] }): RulesDraft {
    return { id: r.id, origin: r.origin, text: r.english, policy: r.policy, summary: r.summary, model: r.model, created_at: iso(r.created_at)!, status: r.status };
  }

  async getDraft(origin: string, id: string): Promise<RulesDraft | undefined> {
    const r = (await this.rows<Parameters<PostgresStorage['draftOf']>[0]>('SELECT * FROM rule_drafts WHERE origin = $1 AND id = $2', [origin, id]))[0];
    return r && this.draftOf(r);
  }

  async putDraft(draft: RulesDraft): Promise<void> {
    await this.pool.query(
      `INSERT INTO rule_drafts (id, origin, english, policy, summary, model, created_at, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, policy = EXCLUDED.policy, summary = EXCLUDED.summary`,
      [draft.id, draft.origin, draft.text, draft.policy, draft.summary, draft.model, draft.created_at, draft.status],
    );
  }

  async listDrafts(origin: string): Promise<RulesDraft[]> {
    return (await this.rows<Parameters<PostgresStorage['draftOf']>[0]>('SELECT * FROM rule_drafts WHERE origin = $1 ORDER BY created_at DESC', [origin])).map((r) => this.draftOf(r));
  }

  private eventOf(r: { ts: Date; source: SessionEvent['source']; action: SessionEvent['action']; key: string | null; element: string | null; path: string | null; detail: Record<string, unknown> | null }): SessionEvent {
    return { ts: iso(r.ts)!, source: r.source, action: r.action, ...(r.key && { key: r.key }), ...(r.element && { element: r.element }), ...(r.path && { path: r.path }), ...(r.detail && { detail: r.detail }) };
  }

  async getSession(id: string): Promise<Session | undefined> {
    const s = (await this.rows<{ id: string; origin: string; agent: string; intent: string; created_at: Date }>('SELECT * FROM sessions WHERE id = $1', [id]))[0];
    if (!s) return undefined;
    const events = await this.rows<Parameters<PostgresStorage['eventOf']>[0]>('SELECT ts, source, action, key, element, path, detail FROM session_events WHERE session_id = $1 ORDER BY id', [id]);
    return { id: s.id, origin: s.origin, agent: s.agent, intent: s.intent, created_at: iso(s.created_at)!, events: events.map((e) => this.eventOf(e)) };
  }

  async putSession(session: Session): Promise<void> {
    await this.pool.query('INSERT INTO sessions (id, origin, agent, intent, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING', [
      session.id,
      session.origin,
      session.agent,
      session.intent,
      session.created_at,
    ]);
    if (session.events.length) await this.insertEvents(session.id, session.events);
  }

  private async insertEvents(id: string, events: SessionEvent[]): Promise<void> {
    for (const e of events) {
      await this.pool.query('INSERT INTO session_events (session_id, ts, source, action, key, element, path, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
        id,
        e.ts,
        e.source,
        e.action,
        e.key ?? null,
        e.element ?? null,
        e.path ?? null,
        e.detail ?? null,
      ]);
    }
  }

  async listSessions(origin: string): Promise<Session[]> {
    const ids = await this.rows<{ id: string }>('SELECT id FROM sessions WHERE origin = $1 ORDER BY created_at DESC', [origin]);
    return (await Promise.all(ids.map((r) => this.getSession(r.id)))).filter((s): s is Session => s !== undefined);
  }

  async deleteSession(id: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE id = $1', [id]);
  }

  async appendEvents(id: string, events: SessionEvent[]): Promise<Session | undefined> {
    if (!(await this.rows('SELECT 1 FROM sessions WHERE id = $1', [id])).length) return undefined;
    await this.insertEvents(id, events);
    return this.getSession(id);
  }

  async getCached<T>(kind: string, key: string): Promise<T | undefined> {
    return (await this.rows<{ value: T }>('SELECT value FROM cache WHERE kind = $1 AND key = $2', [kind, key]))[0]?.value;
  }

  async putCached(kind: string, key: string, value: unknown): Promise<void> {
    await this.pool.query('INSERT INTO cache (kind, key, value) VALUES ($1, $2, $3) ON CONFLICT (kind, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [kind, key, JSON.stringify(value)]);
  }

  async appendLog(name: LogName, record: object): Promise<void> {
    const origin = (record as { origin?: unknown }).origin;
    await this.pool.query(`INSERT INTO ${LOG_TABLES[name]} (origin, record) VALUES ($1, $2)`, [typeof origin === 'string' ? origin : null, record]);
  }

  async readLog(name: LogName, origin?: string): Promise<object[]> {
    const where = origin ? 'WHERE origin = $1' : '';
    return (await this.rows<{ record: object }>(`SELECT record FROM ${LOG_TABLES[name]} ${where} ORDER BY id`, origin ? [origin] : [])).map((r) => r.record);
  }

  /** For health checks. */
  async ping(): Promise<boolean> {
    return (await this.rows<{ ok: number }>('SELECT 1 AS ok'))[0]?.ok === 1;
  }
}
