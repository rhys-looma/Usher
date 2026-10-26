// The site script's page API, as the agent calls it through page.evaluate.

export interface UsherPageApi {
  version: string;
  ready: Promise<void>;
  bind(token: string): Promise<{ ok: boolean; error?: string; session?: string }>;
  confirm(key?: string): boolean;
  handoff(key: string): boolean;
  state(): { state: string; bound: boolean; session: string | null; match: { kind: string } | null };
}

declare global {
  interface Window {
    usher: UsherPageApi;
  }
}
