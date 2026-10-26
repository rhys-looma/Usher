// HTTP client for the registry, signing as an agent. Used by the MCP server and the agent.

import { signRequest, type AgentIdentity, type Fingerprint, type UsherMap } from '@usher/core';

export interface KnockInput {
  url: string;
  intent?: string;
  fingerprint?: Fingerprint;
  session?: string;
  /** Keys the user has confirmed, for a knock made just before acting on them. */
  confirmed?: string[];
}

export interface RunReport {
  session: string;
  url: string;
  outcome: 'completed' | 'stopped' | 'failed';
  summary?: Record<string, unknown>;
}

export class RegistryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${status} ${code}: ${message}`);
    this.name = 'RegistryError';
  }
}

export class RegistryClient {
  constructor(
    readonly url: string,
    private readonly identity: AgentIdentity,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      ...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) throw new RegistryError(res.status, json.error ?? 'error', json.message ?? res.statusText);
    return json as T;
  }

  private sign<T extends object>(payload: T) {
    return signRequest(payload, this.identity);
  }

  async knock(input: KnockInput): Promise<KnockResponse> {
    const url = new URL(input.url);
    const payload = {
      usher: '0.1',
      url: url.origin + url.pathname,
      ...(input.intent && { intent: input.intent }),
      ...(input.fingerprint && { fingerprint: input.fingerprint }),
      ...(input.session && { session: input.session }),
      ...(input.confirmed?.length && { confirmed: input.confirmed }),
    };
    return this.call('POST', '/knock', await this.sign(payload));
  }

  lookup(origin: string, path: string, fingerprint: Fingerprint): Promise<{ match: KnockResponse['match']; map: UsherMap | null }> {
    return this.call('POST', '/maps/lookup', { origin, path, fingerprint });
  }

  getMap(origin: string, digest: string): Promise<{ map: UsherMap }> {
    return this.call('GET', `/maps/${digest}?origin=${encodeURIComponent(origin)}`);
  }

  async submitMap(map: UsherMap): Promise<{ digest: string; stored: boolean }> {
    return this.call('POST', '/maps', await this.sign({ map }));
  }

  async reportRun(report: RunReport): Promise<{ recorded: boolean }> {
    return this.call('POST', '/runs', await this.sign(report));
  }
}

export interface KnockResponse {
  usher: '0.1';
  session: string;
  token: string;
  expires_at: string;
  keys_url: string;
  events_url: string;
  match: { kind: 'exact' | 'near' | 'path' | 'none'; score: number; digest: string | null; drifted: boolean };
  map: UsherMap | null;
  plan: null;
  rules: { agents: 'allowed' | 'denied'; confirm: string[]; human_only: string[]; actions: Record<string, 'allow' | 'confirm' | 'forbid'> };
}
