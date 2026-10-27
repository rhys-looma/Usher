// HTTP client for the registry, signing as an agent. Used by the MCP server and the agent.

// Narrow imports: this client is bundled into @usher-run/mcp, which must not pull in the compiler.
import type { AgentIdentity, Fingerprint, UsherMap, UsherPlan } from '@usher/core';
import { utf8 } from '@usher/core/encoding';
import { contentDigest, signHttpMessage } from '@usher/core/http-signatures';
import { signRequest } from '@usher/core/identity';

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

export interface ClientOptions {
  /** Sign requests with Web Bot Auth HTTP Message Signatures as well as in the body (default true). */
  httpSignatures?: boolean;
  /** Where this agent publishes its key directory, sent as Signature-Agent. */
  signatureAgent?: string;
}

export class RegistryClient {
  constructor(
    readonly url: string,
    private readonly identity: AgentIdentity,
    private readonly options: ClientOptions = {},
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.url}${path}`;
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = text === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Digest': await contentDigest(utf8(text)) };
    if (text !== undefined && this.options.httpSignatures !== false) {
      const signatureAgent = this.options.signatureAgent ?? process.env.USHER_SIGNATURE_AGENT;
      Object.assign(headers, await signHttpMessage({ method, url, headers }, this.identity, { components: ['@method', '@authority', '@path', 'content-digest'], ...(signatureAgent && { signatureAgent }) }));
    }
    const res = await fetch(url, { method, headers, ...(text !== undefined && { body: text }) });
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

  getPlan(url: string): Promise<UsherPlan> {
    return this.call('GET', `/plans?url=${encodeURIComponent(url)}`);
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
