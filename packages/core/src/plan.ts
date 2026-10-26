// Plans across steps (LU-40): maps joined by leads_to edges into a journey, with the inputs the
// journey needs as semantic keys (required, constraints, options), so an agent can check a whole
// journey's data before it starts and ask its user for anything missing.

import type { Options } from './extract.ts';
import type { MapConstraints, MapField, UsherMap } from './map.ts';
import type { Risk } from './vocabulary.ts';

export interface PlanStep {
  path: string;
  /** Digest of the map for this step. */
  map: string;
  purpose: string;
  /** The action that moves on, and where it leads. */
  advance: { id: string; key: string; label: string; risk: Risk } | null;
  leads_to: string | null;
}

export interface PlanInput {
  key: string;
  label: string;
  control: string;
  /** Required on at least one step (when its condition, if any, holds). */
  required: boolean;
  risk: Risk;
  sensitive?: boolean;
  constraints?: MapConstraints;
  options?: Options;
  shown_if?: MapField['shown_if'];
  /** The steps that ask for it. */
  steps: string[];
}

export interface UsherPlan {
  usher_plan: '0.1';
  origin: string;
  intent: string | null;
  start: string;
  steps: PlanStep[];
  inputs: PlanInput[];
  /** Actions on the way that need the user's confirmation or are theirs alone. */
  consequential: { path: string; key: string; label: string; risk: Risk }[];
  /** Whether the chain reaches a page with no form (the end), rather than an unmapped step. */
  complete: boolean;
  /** Where the chain stopped, when it is not complete. */
  stops_at: string | null;
}

const ADVANCE = ['form.submit', 'nav.next'];

function advanceOf(map: UsherMap) {
  return map.actions.find((a) => a.leads_to && ADVANCE.includes(a.key)) ?? map.actions.find((a) => a.leads_to) ?? map.actions.find((a) => ADVANCE.includes(a.key)) ?? null;
}

/**
 * Composes a plan from the current map for each path, following leads_to from the start. The chain
 * is complete when it reaches a path with no map (the journey's result); it stops without being
 * complete at an advance whose destination isn't known yet.
 */
export function composePlan(start: string, maps: Map<string, UsherMap>): UsherPlan | null {
  const first = maps.get(start);
  if (!first) return null;
  const steps: PlanStep[] = [];
  const inputs = new Map<string, PlanInput>();
  const consequential: UsherPlan['consequential'] = [];
  const seen = new Set<string>();
  let path: string | null = start;
  let complete = false;
  let stops: string | null = null;

  while (path && !seen.has(path)) {
    seen.add(path);
    const map = maps.get(path);
    if (!map) {
      complete = true;
      break;
    }
    const advance = advanceOf(map);
    steps.push({ path, map: map.fingerprint.digest, purpose: map.form.purpose, advance: advance && { id: advance.id, key: advance.key, label: advance.label, risk: advance.risk }, leads_to: advance?.leads_to ?? null });
    for (const f of map.fields) {
      const existing = inputs.get(f.key);
      if (existing) {
        existing.required ||= f.required;
        existing.steps.push(path);
        continue;
      }
      inputs.set(f.key, {
        key: f.key,
        label: f.label,
        control: f.control,
        required: f.required,
        risk: f.risk,
        ...(f.sensitive && { sensitive: true }),
        ...(f.constraints && { constraints: f.constraints }),
        ...(f.options && { options: f.options }),
        ...(f.shown_if && { shown_if: f.shown_if }),
        steps: [path],
      });
    }
    for (const a of map.actions) if (a.risk !== 'safe' && a.key !== 'ui.dismiss') consequential.push({ path, key: a.key, label: a.label, risk: a.risk });
    if (!advance?.leads_to) {
      stops = path;
      break;
    }
    path = advance.leads_to;
  }
  return { usher_plan: '0.1', origin: first.origin, intent: first.form.intent ?? null, start, steps, inputs: [...inputs.values()], consequential, complete, stops_at: complete ? null : stops };
}
