// Map assembly (LU-49): extraction + locators + fingerprint + validated labels → an Usher map
// that validates against spec/map.schema.json.

import type { Constraints, ExtractedGroup, Options } from './extract.ts';
import type { Fingerprint } from './fingerprint.ts';
import type { ScannedForm } from './inpage.ts';
import type { ConditionOp, LabelValidation } from './labels.ts';
import type { Locator } from './locators.ts';
import type { Risk } from './vocabulary.ts';

export interface MapConstraints extends Constraints {
  format?: string;
}

export interface MapField {
  id: string;
  key: string;
  label: string;
  control: string;
  required: boolean;
  risk: Risk;
  sensitive?: boolean;
  constraints?: MapConstraints;
  options?: Options;
  group?: string;
  /** One part of a date split across fields: the parts share one key and one group. */
  part?: 'day' | 'month' | 'year';
  shown_if?: { field: string; op: ConditionOp; value?: string | string[] };
  locators: Locator[];
}

export interface MapAction {
  id: string;
  key: string;
  label: string;
  kind: string;
  risk: Risk;
  locators: Locator[];
  leads_to?: string;
}

export interface Provenance {
  source: 'compiled' | 'site' | 'agent';
  compiler?: string;
  created_at: string;
  verified: boolean;
}

export interface UsherMap {
  usher: '0.1';
  origin: string;
  path: string;
  fingerprint: Fingerprint;
  form: { purpose: string; intent?: string; step?: number };
  groups?: ExtractedGroup[];
  fields: MapField[];
  actions: MapAction[];
  provenance: Provenance;
}

export interface MergeInput {
  form: ScannedForm;
  fingerprint: Fingerprint;
  validation: LabelValidation;
  origin: string;
  /** Path pattern; `:param` marks a variable segment. */
  path: string;
  provenance: Provenance;
  /** Step number within a journey, when known. */
  step?: number;
  /** Path the advance action leads to, once known. */
  leadsTo?: string;
}

// Formats an agent needs to know that the control type implies.
const FORMATS: Record<string, string> = { date: 'date', email: 'email' };

export function mergeMap(input: MergeInput): UsherMap {
  const { validation } = input;
  if (!validation.ok) throw new Error(`Cannot build a map from labels with ${validation.errors.length} validation error(s).`);
  const labels = validation.labels;
  const byId = new Map(input.form.elements.map((e) => [e.id, e]));

  const fields: MapField[] = [];
  const actions: MapAction[] = [];
  for (const label of labels.elements) {
    const el = byId.get(label.id)!;
    if (el.kind === 'action') {
      const action: MapAction = { id: el.id, key: label.key, label: el.label, kind: el.control, risk: label.risk, locators: el.locators };
      if (input.leadsTo && label.id === labels.advance_action_id) action.leads_to = input.leadsTo;
      actions.push(action);
      continue;
    }
    const format = FORMATS[el.control];
    const constraints: MapConstraints = { ...el.constraints, ...(format && { format }) };
    // Property order follows spec/examples, so maps diff cleanly.
    const field: MapField = {
      id: el.id,
      key: label.key,
      label: el.label,
      control: el.control,
      required: el.required,
      risk: label.risk,
      ...(label.sensitive && { sensitive: true }),
      ...(Object.keys(constraints).length > 0 && { constraints }),
      ...(el.options && { options: el.options }),
      ...(el.group && { group: el.group }),
      ...(el.part && { part: el.part }),
      ...(label.shown_if && { shown_if: label.shown_if }),
      locators: el.locators,
    };
    fields.push(field);
  }

  const used = new Set(fields.map((f) => f.group).filter(Boolean));
  const groups = input.form.groups.filter((g) => used.has(g.id));
  const form: UsherMap['form'] = { purpose: labels.form.purpose, intent: labels.form.intent };
  if (input.step !== undefined) form.step = input.step;

  return {
    usher: '0.1',
    origin: input.origin,
    path: input.path,
    fingerprint: input.fingerprint,
    form,
    ...(groups.length > 0 && { groups }),
    fields,
    actions,
    provenance: input.provenance,
  };
}
