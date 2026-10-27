// Prompt and per-request output schema for the labelling model (LU-19).
//
// The model sees the compact extraction and a screenshot, and returns Labels: meaning only.
// It never sees or writes locators.

import type { ExtractedForm } from '../extract.ts';
import { CONDITION_OPS, type LabelError } from '../labels.ts';
import { RISKS, vocabulary as defaultVocabulary, type Vocabulary } from '../vocabulary.ts';
import { shortlist } from './shortlist.ts';

export function systemPrompt(vocab: Vocabulary = defaultVocabulary): string {
  const rows = vocab.entries.map((e) => `| ${e.key} | ${e.kind} | ${e.default_risk}${e.sensitive ? ', sensitive' : ''} | ${e.meaning} |`);
  return `You label web forms for Usher, an open protocol that lets AI agents use website forms quickly and safely.

## What you are building
A map describes one state of one web form: what each field and action means, and which actions matter. Agents use the map instead of reading the raw page. Deterministic code has already extracted every element and will locate them; your job is to label meaning only. Never output selectors, CSS, XPath, ids from the page, or any value a person might type.

## Input
- The extraction: every field and action in document order, with an element id (e1, e2…), control type, label, whether it is required, options for selects and radio groups (first 20 plus the total), validation constraints, whether it is visible, and candidates: the vocabulary keys whose meaning is closest to it, best first, found by code.
- A screenshot of the form.

## Output
- form.purpose: a short description of what the form is for, under 100 characters, e.g. "Car insurance quote: driver details".
- form.intent: dotted lowercase, e.g. quote.car_insurance, booking.table, contact.message, account.signup.
- elements: one entry per element you label, with its id, key, risk and shown_if.
- advance_action_id: the action that moves the journey forward or submits the form (Continue, Next, Submit, Get my quote), or null if there is none.

## Keys
- Choose each element's key from its candidates: the most specific candidate whose meaning fits (person.first_name rather than person.full_name for a first-name box; contact.mobile for a mobile number). The first candidate is not always right; read the meanings.
- Never invent a custom key when a vocabulary key fits.
- nav.next and form.submit are the form's own way forward. A link that leads away from the form, to another page or service, is neither.
- Only when none of the candidates fits, use custom.<slug> (lowercase letters, digits and underscores, e.g. custom.how_did_you_hear). An element with no candidates usually needs one.
- Field keys go on fields and action keys on actions. Each field gets its own key.

## Risk
- safe: reversible, no effect outside the session (typing in a field, moving to the next step). Agents act freely.
- consequential: has an effect the user should know about (requesting a quote, sending a message, creating a booking). Agents act only if the user's instruction covers it and the site's rules allow it.
- needs_user: commits the user legally or financially, or needs their own judgement (declarations, consent, payment, passwords). Agents never act; they hand to the user.
Each key has a default risk. Never label an element less strict than its key's default. Sensitive keys are always needs_user.

## Conditions (shown_if)
Some elements only appear when another field has a certain answer; these are usually hidden (visible: false) in the extraction. Give them shown_if with field_id set to the controlling field's id and:
- op equals or not_equals with one option value, or op in with a list of option values. Values must be option values from the extraction (the value, not the label).
- op checked (a checkbox is ticked) or filled (a field has any answer), with value null.
Use shown_if: null for elements that are always shown.

## Which elements to label
- Label every visible element exactly once.
- Label a hidden element only when it is conditional, with its shown_if.
- Leave out hidden elements that have no condition: they are usually honeypots meant to catch bots.

## Vocabulary
| key | kind | default risk | meaning |
| --- | --- | --- | --- |
${rows.join('\n')}`;
}

/** The extraction as the model sees it: no boxes, ids from the page, names or locators. */
export function compactExtraction(form: ExtractedForm, page: { path: string; title: string }): object {
  return {
    page,
    groups: form.groups,
    elements: form.elements.map((e) => ({
      id: e.id,
      kind: e.kind,
      control: e.control,
      label: e.label,
      ...(e.group && { group: e.group }),
      required: e.required,
      ...(e.options && { options: e.options }),
      ...(e.constraints && { constraints: e.constraints }),
      visible: e.visible,
      candidates: shortlist({ kind: e.kind, control: e.control, label: e.label, ...(e.options && { options: e.options.items.map((o) => o.label) }), ...(e.placeholder && { placeholder: e.placeholder }), ...(e.autocomplete && { autocomplete: e.autocomplete }) }),
    })),
  };
}

export function userPrompt(extraction: object): string {
  return `Label this form. The screenshot shows how it looks.\n\nExtraction:\n${JSON.stringify(extraction)}`;
}

export function retryPrompt(errors: LabelError[]): string {
  return `Those labels failed validation. Fix every error below and return the complete corrected labels.\n\n${JSON.stringify(errors, null, 1)}`;
}

/** JSON Schema for the labels of this form, in the strict structured-output subset. */
export function labelsSchema(form: ExtractedForm): Record<string, unknown> {
  const ids = form.elements.map((e) => e.id);
  const fieldIds = form.elements.filter((e) => e.kind === 'field').map((e) => e.id);
  const actionIds = form.elements.filter((e) => e.kind === 'action').map((e) => e.id);
  const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
  const nullable = (schema: Record<string, unknown> | null) => (schema ? { anyOf: [schema, { type: 'null' }] } : { type: 'null' });

  const condition = fieldIds.length
    ? object({
        field_id: { type: 'string', enum: fieldIds },
        op: { type: 'string', enum: [...CONDITION_OPS] },
        value: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }, { type: 'null' }] },
      })
    : null;

  return object({
    form: object({ purpose: { type: 'string' }, intent: { type: 'string' } }),
    elements: {
      type: 'array',
      items: object({
        id: { type: 'string', enum: ids },
        key: { type: 'string' },
        risk: { type: 'string', enum: [...RISKS] },
        shown_if: nullable(condition),
      }),
    },
    advance_action_id: nullable(actionIds.length ? { type: 'string', enum: actionIds } : null),
  });
}
