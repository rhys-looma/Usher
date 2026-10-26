// Fingerprint matching (LU-23): exact digest first, then the best signature similarity at or
// above a threshold, then the best map for the same path. Every candidate's score is returned
// so lookups can be logged and the threshold tuned.

import { similarity, type Fingerprint } from '@usher/core';
import type { MapRecord } from './storage.ts';

export type MatchKind = 'exact' | 'near' | 'path' | 'none';

/** Default similarity needed for a near match. Tune from the match log. */
export const DEFAULT_THRESHOLD = 0.3;

export interface Scored {
  digest: string;
  path: string;
  score: number;
}

export interface MatchResult {
  kind: MatchKind;
  score: number;
  record: MapRecord | null;
  scores: Scored[];
}

export function findMatch(
  live: Pick<Fingerprint, 'digest' | 'signature'> | undefined,
  path: string,
  candidates: MapRecord[],
  threshold = DEFAULT_THRESHOLD,
): MatchResult {
  const scores: Scored[] = candidates.map((r) => ({
    digest: r.digest,
    path: r.map.path,
    score: live ? (r.digest === live.digest ? 1 : round(similarity(live.signature, r.map.fingerprint.signature))) : 0,
  }));
  const byDigest = new Map(candidates.map((r) => [r.digest, r]));
  // Highest score first; on a tie, the same path, then the newest map.
  const ranked = scores
    .map((s) => ({ ...s, record: byDigest.get(s.digest)! }))
    .sort((a, b) => b.score - a.score || Number(b.path === path) - Number(a.path === path) || b.record.added_at.localeCompare(a.record.added_at));

  const exact = live && ranked.find((r) => r.digest === live.digest);
  if (exact) return { kind: 'exact', score: 1, record: exact.record, scores };
  const near = ranked.find((r) => live && r.score >= threshold);
  if (near) return { kind: 'near', score: near.score, record: near.record, scores };
  const samePath = ranked.find((r) => r.path === path);
  if (samePath) return { kind: 'path', score: samePath.score, record: samePath.record, scores };
  return { kind: 'none', score: ranked[0]?.score ?? 0, record: null, scores };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
