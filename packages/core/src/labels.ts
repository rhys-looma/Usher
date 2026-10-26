// Labels and the label validator (LU-49).
//
// Labels are what a labeller (a model or a person) returns: meaning only. The validator
// checks them against the extraction and the vocabulary and returns structured errors, so
// they can be fed back to a model. Labels never carry locators or selectors; the code
// locates.

import type { ExtractedElement } from './extract.ts';
import { CUSTOM_KEY, RISKS, vocabulary as defaultVocabulary, type Risk, type Vocabulary, type VocabularyEntry } from './vocabulary.ts';

export type ConditionOp = 'equals' | 'not_equals' | 'in' | 'checked' | 'filled';

export const CONDITION_OPS: readonly ConditionOp[] = ['equals', 'not_equals', 'in', 'checked', 'filled'];

export interface LabelCondition {
  /** Extracted id of the field this element depends on. */
  field_id: string;
  op: ConditionOp;
  /** An option value (equals, not_equals), option values (in), or null (checked, filled). */
  value: string | string[] | null;
}

export interface ElementLabel {
  id: string;
  key: string;
  risk: Risk;
  shown_if: LabelCondition | null;
}

export interface Labels {
  form: { purpose: string; intent: string };
  elements: ElementLabel[];
  /** The action that moves to the next step or submits the form. */
  advance_action_id: string | null;
}

export interface LabelError {
  /** JSON path into the labels, e.g. `elements[3].shown_if.value`. */
  path: string;
  code: string;
  message: string;
}

export interface RiskClamp {
  id: string;
  key: string;
  labelled: Risk;
  final: Risk;
  reason: 'key_default' | 'sensitive';
}

export interface Exclusion {
  id: string;
  label: string;
  reason: 'hidden_without_condition';
}

/** A condition with its field resolved to that field's key, as the map expresses it. */
export interface ResolvedCondition {
  field: string;
  op: ConditionOp;
  value?: string | string[];
}

export interface ResolvedLabel {
  id: string;
  key: string;
  risk: Risk;
  sensitive: boolean;
  shown_if?: ResolvedCondition;
}

export interface ResolvedLabels {
  form: { purpose: string; intent: string };
  /** In extraction order; excluded elements left out. */
  elements: ResolvedLabel[];
  advance_action_id: string | null;
}

export type LabelValidation =
  | { ok: true; labels: ResolvedLabels; errors: []; clamps: RiskClamp[]; excluded: Exclusion[] }
  | { ok: false; errors: LabelError[]; clamps: RiskClamp[]; excluded: Exclusion[] };

const RANK: Record<Risk, number> = { safe: 0, consequential: 1, needs_user: 2 };

/** The stricter of two risks. */
export function stricter(a: Risk, b: Risk): Risk {
  return RANK[a] >= RANK[b] ? a : b;
}

const INTENT = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

type Shape = Record<string, 'string' | 'object' | 'array' | 'nullable'>;

const SHAPES = {
  root: { form: 'object', elements: 'array', advance_action_id: 'nullable' },
  form: { purpose: 'string', intent: 'string' },
  element: { id: 'string', key: 'string', risk: 'string', shown_if: 'nullable' },
  condition: { field_id: 'string', op: 'string', value: 'nullable' },
} satisfies Record<string, Shape>;

const HINT = 'Labels carry meaning only (key, risk, shown_if); locators and selectors come from the extractor.';

export function validateLabels(raw: unknown, elements: readonly ExtractedElement[], vocab: Vocabulary = defaultVocabulary): LabelValidation {
  const errors: LabelError[] = [];
  const clamps: RiskClamp[] = [];
  const excluded: Exclusion[] = [];
  const err = (path: string, code: string, message: string) => errors.push({ path, code, message });

  // Shape: exactly the properties the Labels type defines, nothing more.
  function shaped(value: unknown, shape: Shape, path: string): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      err(path || '$', 'invalid_type', `Expected an object.`);
      return false;
    }
    let ok = true;
    for (const prop of Object.keys(value)) {
      if (!(prop in shape)) {
        err(`${path ? `${path}.` : ''}${prop}`, 'unknown_property', `"${prop}" is not part of the labels format. ${HINT}`);
        ok = false;
      }
    }
    for (const [prop, type] of Object.entries(shape)) {
      const v = (value as Record<string, unknown>)[prop];
      const at = `${path ? `${path}.` : ''}${prop}`;
      if (v === undefined) {
        err(at, 'missing_property', `"${prop}" is required${type === 'nullable' ? ' (use null when it does not apply)' : ''}.`);
        ok = false;
      } else if (type === 'string' && typeof v !== 'string') {
        err(at, 'invalid_type', 'Expected a string.');
        ok = false;
      } else if (type === 'array' && !Array.isArray(v)) {
        err(at, 'invalid_type', 'Expected an array.');
        ok = false;
      } else if (type === 'object' && (typeof v !== 'object' || v === null || Array.isArray(v))) {
        err(at, 'invalid_type', 'Expected an object.');
        ok = false;
      }
    }
    return ok;
  }

  const byId = new Map(elements.map((e) => [e.id, e]));
  const entries = new Map<string, VocabularyEntry>(vocab.entries.map((e) => [e.key, e]));

  if (!shaped(raw, SHAPES.root, '')) return { ok: false, errors, clamps, excluded };
  const formOk = shaped(raw.form, SHAPES.form, 'form');
  const form = raw.form as { purpose: string; intent: string };
  if (formOk) {
    if (!form.purpose.trim() || form.purpose.length > 200) err('form.purpose', 'invalid_purpose', 'Purpose must be 1 to 200 characters.');
    if (!INTENT.test(form.intent)) err('form.intent', 'invalid_intent', `Intent "${form.intent}" must be dotted lowercase, e.g. quote.car_insurance.`);
  }

  // First pass: ids, keys and risk.
  interface Pending {
    index: number;
    label: ElementLabel;
    element: ExtractedElement;
    entry?: VocabularyEntry;
  }
  const pending: Pending[] = [];
  const seen = new Set<string>();
  // Ids mentioned at all, even by a malformed label, so one mistake isn't also reported as missing.
  const mentioned = new Set<string>();
  (raw.elements as unknown[]).forEach((item, index) => {
    const path = `elements[${index}]`;
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id === 'string') mentioned.add(id);
    if (!shaped(item, SHAPES.element, path)) return;
    const label = item as unknown as ElementLabel;
    const element = byId.get(label.id);
    if (!element) {
      err(`${path}.id`, 'unknown_id', `No extracted element has id "${label.id}".`);
      return;
    }
    if (seen.has(label.id)) {
      err(`${path}.id`, 'duplicate_id', `${label.id} is labelled more than once.`);
      return;
    }
    seen.add(label.id);
    if (!RISKS.includes(label.risk)) err(`${path}.risk`, 'invalid_risk', `Risk must be one of ${RISKS.join(', ')}.`);
    if (label.shown_if !== null) shaped(label.shown_if, SHAPES.condition, `${path}.shown_if`);

    const entry = entries.get(label.key);
    if (!entry && !CUSTOM_KEY.test(label.key)) {
      err(`${path}.key`, 'unknown_key', `"${label.key}" is not in the vocabulary. Use a vocabulary key, or custom.<slug> (lowercase, digits, underscores) only when nothing fits.`);
    } else if (entry && entry.kind !== element.kind) {
      err(`${path}.key`, 'key_kind_mismatch', `${label.id} is ${element.kind === 'field' ? 'a field' : 'an action'} but "${label.key}" is ${entry.kind === 'field' ? 'a field' : 'an action'} key.`);
    }
    pending.push({ index, label, element, ...(entry && { entry }) });
  });

  for (const element of elements) {
    if (element.visible && !mentioned.has(element.id)) {
      err('elements', 'missing_label', `${element.id} ("${element.label}") is visible but has no label. Label every visible element exactly once.`);
    }
  }

  // Hidden elements with no condition are likely honeypots: leave them out of the map.
  const included = new Map<string, Pending>();
  for (const p of pending) {
    if (!p.element.visible && p.label.shown_if === null) {
      excluded.push({ id: p.element.id, label: p.element.label, reason: 'hidden_without_condition' });
    } else {
      included.set(p.element.id, p);
    }
  }
  for (const element of elements) {
    if (!element.visible && !seen.has(element.id)) excluded.push({ id: element.id, label: element.label, reason: 'hidden_without_condition' });
  }

  // Field keys must be unique: conditions refer to fields by key.
  const fieldKeys = new Map<string, string>();
  for (const p of included.values()) {
    if (p.element.kind !== 'field') continue;
    const other = fieldKeys.get(p.label.key);
    if (other) err(`elements[${p.index}].key`, 'duplicate_key', `"${p.label.key}" is already used by ${other}. Each field needs its own key.`);
    else fieldKeys.set(p.label.key, p.element.id);
  }

  // Second pass: conditions and final risk.
  const resolved: ResolvedLabel[] = [];
  for (const element of elements) {
    const p = included.get(element.id);
    if (!p) continue;
    const { label, entry, index } = p;
    const path = `elements[${index}]`;

    let risk = RISKS.includes(label.risk) ? label.risk : 'safe';
    const sensitive = entry?.sensitive === true;
    if (entry) {
      const final = stricter(risk, entry.default_risk);
      if (final !== risk) clamps.push({ id: label.id, key: label.key, labelled: risk, final, reason: 'key_default' });
      risk = final;
    }
    if (sensitive && risk !== 'needs_user') {
      clamps.push({ id: label.id, key: label.key, labelled: risk, final: 'needs_user', reason: 'sensitive' });
      risk = 'needs_user';
    }

    const out: ResolvedLabel = { id: label.id, key: label.key, risk, sensitive };
    const cond = label.shown_if;
    if (cond && typeof cond === 'object' && typeof cond.field_id === 'string' && typeof cond.op === 'string') {
      const c = resolveCondition(cond, `${path}.shown_if`, label.id);
      if (c) out.shown_if = c;
    }
    resolved.push(out);
  }

  function resolveCondition(cond: LabelCondition, path: string, selfId: string): ResolvedCondition | undefined {
    const target = byId.get(cond.field_id);
    if (!target) return void err(`${path}.field_id`, 'condition_unknown_field', `No extracted element has id "${cond.field_id}".`);
    if (target.kind !== 'field') return void err(`${path}.field_id`, 'condition_not_field', `${cond.field_id} is an action; conditions depend on fields.`);
    if (cond.field_id === selfId) return void err(`${path}.field_id`, 'condition_self', 'An element cannot depend on itself.');
    const targetLabel = included.get(cond.field_id);
    if (!targetLabel) return void err(`${path}.field_id`, 'condition_unlabelled_field', `${cond.field_id} is not labelled (or is excluded), so it has no key to refer to.`);
    if (!CONDITION_OPS.includes(cond.op)) return void err(`${path}.op`, 'invalid_op', `Op must be one of ${CONDITION_OPS.join(', ')}.`);

    const key = targetLabel.label.key;
    const optionValues = target.options?.items.map((o) => o.value);
    const listed = optionValues ? ` Option values: ${optionValues.join(', ')}${target.options!.truncated ? ' (truncated)' : ''}.` : '';

    switch (cond.op) {
      case 'checked':
      case 'filled':
        if (cond.value !== null) return void err(`${path}.value`, 'condition_value_forbidden', `"${cond.op}" takes no value; use null.`);
        if (cond.op === 'checked' && target.control !== 'checkbox') {
          return void err(`${path}.op`, 'condition_op_control', `"checked" needs a checkbox; ${cond.field_id} is ${target.control}.`);
        }
        return { field: key, op: cond.op };
      case 'equals':
      case 'not_equals':
      case 'in': {
        // Conditions compare against option values from the page, never free text.
        if (!optionValues) return void err(`${path}.op`, 'condition_op_control', `"${cond.op}" needs a select or radio field; ${cond.field_id} is ${target.control}.`);
        if (cond.op === 'in') {
          if (!Array.isArray(cond.value) || cond.value.length === 0 || cond.value.some((v) => typeof v !== 'string')) {
            return void err(`${path}.value`, 'condition_value_required', `"in" needs a non-empty array of option values.${listed}`);
          }
        } else if (typeof cond.value !== 'string') {
          return void err(`${path}.value`, 'condition_value_required', `"${cond.op}" needs one option value.${listed}`);
        }
        const values = Array.isArray(cond.value) ? cond.value : [cond.value];
        const unknown = values.filter((v) => !optionValues.includes(v));
        if (unknown.length) return void err(`${path}.value`, 'condition_value_not_option', `${unknown.map((v) => `"${v}"`).join(', ')} is not an option of ${cond.field_id}.${listed}`);
        return { field: key, op: cond.op, value: cond.value };
      }
    }
  }

  const advance = raw.advance_action_id;
  if (advance !== null) {
    if (typeof advance !== 'string') err('advance_action_id', 'invalid_type', 'Expected an element id or null.');
    else if (byId.get(advance)?.kind !== 'action') err('advance_action_id', 'advance_not_action', `"${advance}" is not an extracted action.`);
    else if (!included.has(advance)) err('advance_action_id', 'advance_not_labelled', `${advance} must also be labelled.`);
  }

  if (errors.length) return { ok: false, errors, clamps, excluded };
  return {
    ok: true,
    labels: { form: { purpose: form.purpose.trim(), intent: form.intent }, elements: resolved, advance_action_id: advance as string | null },
    errors: [],
    clamps,
    excluded,
  };
}
