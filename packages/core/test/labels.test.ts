import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stricter, validateLabels, type ExtractedElement, type LabelValidation } from '../src/index.ts';

// A small synthetic extraction covering each kind of element the rules care about.
function el(id: string, kind: 'field' | 'action', control: string, label: string, extra: Partial<ExtractedElement> = {}): ExtractedElement {
  return { id, kind, tag: 'input', control: control as ExtractedElement['control'], required: false, label, labelSource: 'label-for', box: { x: 0, y: 0, width: 100, height: 20 }, visible: true, ...extra };
}
const yesNo = { items: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], total: 2, truncated: false };
const cover = { items: [{ value: 'comprehensive', label: 'Comprehensive' }, { value: 'third-party', label: 'Third party' }, { value: 'tpft', label: 'TPFT' }], total: 3, truncated: false };

const elements: ExtractedElement[] = [
  el('e1', 'field', 'text', 'First name'),
  el('e2', 'field', 'radio', 'Any claims?', { options: yesNo }),
  el('e3', 'field', 'date', 'Claim date', { visible: false }),
  el('e4', 'field', 'text', 'Leave this empty', { visible: false }),
  el('e5', 'field', 'checkbox', 'I confirm this is true'),
  el('e6', 'field', 'password', 'Password'),
  el('e7', 'field', 'select', 'Cover', { options: cover }),
  el('e8', 'action', 'submit', 'Get my quote'),
  el('e9', 'action', 'link', 'Back'),
];

type RawLabel = { id: string; key: string; risk: string; shown_if: unknown; [extra: string]: unknown };

function labels(overrides: Record<string, Partial<RawLabel> | null> = {}, extra: Record<string, unknown> = {}) {
  const base: Record<string, RawLabel> = {
    e1: { id: 'e1', key: 'person.first_name', risk: 'safe', shown_if: null },
    e2: { id: 'e2', key: 'person.claims.has_any', risk: 'safe', shown_if: null },
    e3: { id: 'e3', key: 'person.claims.date', risk: 'safe', shown_if: { field_id: 'e2', op: 'equals', value: 'yes' } },
    e5: { id: 'e5', key: 'consent.declaration', risk: 'needs_user', shown_if: null },
    e6: { id: 'e6', key: 'account.password', risk: 'needs_user', shown_if: null },
    e7: { id: 'e7', key: 'policy.cover_level', risk: 'safe', shown_if: null },
    e8: { id: 'e8', key: 'form.submit', risk: 'consequential', shown_if: null },
    e9: { id: 'e9', key: 'nav.back', risk: 'safe', shown_if: null },
  };
  for (const [id, o] of Object.entries(overrides)) {
    if (o === null) delete base[id];
    else base[id] = { ...(base[id] ?? { id, key: 'custom.thing', risk: 'safe', shown_if: null }), ...o } as RawLabel;
  }
  return { form: { purpose: 'Car insurance quote', intent: 'quote.car_insurance' }, elements: Object.values(base), advance_action_id: 'e8', ...extra };
}

function codes(v: LabelValidation): string[] {
  return v.errors.map((e) => e.code);
}

function only(v: LabelValidation, code: string, path?: string): void {
  assert.equal(v.ok, false);
  assert.deepEqual(codes(v), [code], JSON.stringify(v.errors));
  if (path) assert.equal(v.errors[0]!.path, path);
  assert.ok(v.errors[0]!.message.length > 10);
}

test('valid labels resolve: keys, final risk, sensitivity and conditions by key', () => {
  const v = validateLabels(labels(), elements);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepEqual(v.labels.form, { purpose: 'Car insurance quote', intent: 'quote.car_insurance' });
  assert.equal(v.labels.advance_action_id, 'e8');
  assert.deepEqual(
    v.labels.elements.map((l) => [l.id, l.key, l.risk, l.sensitive]),
    [
      ['e1', 'person.first_name', 'safe', false],
      ['e2', 'person.claims.has_any', 'safe', false],
      ['e3', 'person.claims.date', 'safe', false],
      ['e5', 'consent.declaration', 'needs_user', false],
      ['e6', 'account.password', 'needs_user', true],
      ['e7', 'policy.cover_level', 'safe', false],
      ['e8', 'form.submit', 'consequential', false],
      ['e9', 'nav.back', 'safe', false],
    ],
  );
  assert.deepEqual(v.labels.elements[2]!.shown_if, { field: 'person.claims.has_any', op: 'equals', value: 'yes' });
  assert.deepEqual(v.clamps, []);
});

test('ids: unknown and duplicate ids are errors', () => {
  only(validateLabels(labels({ e99: { id: 'e99', key: 'custom.x' } }), elements), 'unknown_id', 'elements[8].id');
  const dup = labels();
  dup.elements.push({ ...dup.elements[0]! });
  only(validateLabels(dup, elements), 'duplicate_id');
});

test('every visible element must be labelled', () => {
  const v = validateLabels(labels({ e1: null, e9: null }), elements);
  assert.deepEqual(codes(v), ['missing_label', 'missing_label']);
  assert.match(v.errors[0]!.message, /e1 \("First name"\)/);
});

test('keys: vocabulary or custom.<slug>, on the right kind of element', () => {
  only(validateLabels(labels({ e1: { key: 'person.firstname' } }), elements), 'unknown_key', 'elements[0].key');
  only(validateLabels(labels({ e1: { key: 'custom.Bad-Slug' } }), elements), 'unknown_key');
  only(validateLabels(labels({ e1: { key: 'custom.nickname.extra' } }), elements), 'unknown_key');
  assert.ok(validateLabels(labels({ e1: { key: 'custom.nickname' } }), elements).ok);
  assert.ok(validateLabels(labels({ e9: { key: 'custom.go_back' } }), elements).ok, 'custom keys fit either kind');
  only(validateLabels(labels({ e1: { key: 'nav.next' } }), elements), 'key_kind_mismatch');
  only(validateLabels(labels({ e9: { key: 'person.first_name' } }), elements), 'key_kind_mismatch');
});

test('field keys are unique so conditions can refer to them', () => {
  only(validateLabels(labels({ e1: { key: 'person.claims.has_any' } }), elements), 'duplicate_key');
  // Actions may share a key.
  assert.ok(validateLabels(labels({ e9: { key: 'form.submit', risk: 'consequential' } }), elements).ok);
});

test('risk: the stricter of labelled and key default wins, and clamps are recorded', () => {
  assert.equal(stricter('safe', 'consequential'), 'consequential');
  assert.equal(stricter('needs_user', 'consequential'), 'needs_user');
  const v = validateLabels(labels({ e5: { risk: 'safe' }, e8: { risk: 'safe' }, e9: { risk: 'consequential' } }), elements);
  assert.ok(v.ok);
  const risk = (id: string) => v.labels.elements.find((l) => l.id === id)!.risk;
  assert.equal(risk('e5'), 'needs_user');
  assert.equal(risk('e8'), 'consequential');
  assert.equal(risk('e9'), 'consequential', 'stricter than default is kept');
  assert.deepEqual(v.clamps, [
    { id: 'e5', key: 'consent.declaration', labelled: 'safe', final: 'needs_user', reason: 'key_default' },
    { id: 'e8', key: 'form.submit', labelled: 'safe', final: 'consequential', reason: 'key_default' },
  ]);
  only(validateLabels(labels({ e1: { risk: 'low' } }), elements), 'invalid_risk');
});

test('sensitive keys are always needs_user; custom keys default to safe', () => {
  const v = validateLabels(labels({ e6: { risk: 'safe' }, e1: { key: 'custom.nickname', risk: 'consequential' } }), elements);
  assert.ok(v.ok);
  const e6 = v.labels.elements.find((l) => l.id === 'e6')!;
  assert.equal(e6.risk, 'needs_user');
  assert.equal(e6.sensitive, true);
  assert.deepEqual(v.clamps, [{ id: 'e6', key: 'account.password', labelled: 'safe', final: 'needs_user', reason: 'key_default' }]);
  assert.equal(v.labels.elements[0]!.risk, 'consequential');
});

test('shown_if must reference a real, labelled field', () => {
  const cond = (shown_if: unknown) => labels({ e3: { shown_if } });
  only(validateLabels(cond({ field_id: 'e42', op: 'equals', value: 'yes' }), elements), 'condition_unknown_field', 'elements[2].shown_if.field_id');
  only(validateLabels(cond({ field_id: 'e8', op: 'equals', value: 'yes' }), elements), 'condition_not_field');
  only(validateLabels(cond({ field_id: 'e3', op: 'filled', value: null }), elements), 'condition_self');
  only(validateLabels(cond({ field_id: 'e4', op: 'filled', value: null }), elements), 'condition_unlabelled_field');
  only(validateLabels(cond({ field_id: 'e2', op: 'matches', value: 'yes' }), elements), 'invalid_op');
});

test('shown_if values must be real option values; checked and filled take none', () => {
  const cond = (shown_if: unknown) => labels({ e3: { shown_if } });
  only(validateLabels(cond({ field_id: 'e2', op: 'equals', value: 'Yes' }), elements), 'condition_value_not_option', 'elements[2].shown_if.value');
  only(validateLabels(cond({ field_id: 'e2', op: 'not_equals', value: null }), elements), 'condition_value_required');
  only(validateLabels(cond({ field_id: 'e7', op: 'in', value: 'comprehensive' }), elements), 'condition_value_required');
  only(validateLabels(cond({ field_id: 'e7', op: 'in', value: ['comprehensive', 'fully-comp'] }), elements), 'condition_value_not_option');
  // Free-text fields have no options: comparing against typed text would put values in the map.
  only(validateLabels(cond({ field_id: 'e1', op: 'equals', value: 'Sam' }), elements), 'condition_op_control');
  only(validateLabels(cond({ field_id: 'e1', op: 'checked', value: null }), elements), 'condition_op_control');
  only(validateLabels(cond({ field_id: 'e5', op: 'checked', value: 'yes' }), elements), 'condition_value_forbidden');

  const ok = (shown_if: unknown, expected: unknown) => {
    const v = validateLabels(cond(shown_if), elements);
    assert.ok(v.ok, JSON.stringify(v.errors));
    assert.deepEqual(v.labels.elements[2]!.shown_if, expected);
  };
  ok({ field_id: 'e7', op: 'in', value: ['comprehensive', 'tpft'] }, { field: 'policy.cover_level', op: 'in', value: ['comprehensive', 'tpft'] });
  ok({ field_id: 'e5', op: 'checked', value: null }, { field: 'consent.declaration', op: 'checked' });
  ok({ field_id: 'e1', op: 'filled', value: null }, { field: 'person.first_name', op: 'filled' });
  ok({ field_id: 'e2', op: 'not_equals', value: 'no' }, { field: 'person.claims.has_any', op: 'not_equals', value: 'no' });
});

test('labels cannot carry locators, selectors or anything else the type does not define', () => {
  const v1 = validateLabels(labels({ e1: { locators: [{ by: 'css', value: '#first' }] } }), elements);
  only(v1, 'unknown_property', 'elements[0].locators');
  assert.match(v1.errors[0]!.message, /locators and selectors come from the extractor/);
  only(validateLabels(labels({ e1: { selector: '#first' } }), elements), 'unknown_property', 'elements[0].selector');
  only(validateLabels(labels({}, { css: 'form' }), elements), 'unknown_property', 'css');
  only(validateLabels(labels({ e3: { shown_if: { field_id: 'e2', op: 'equals', value: 'yes', xpath: '//input' } } }), elements), 'unknown_property', 'elements[2].shown_if.xpath');
  const withForm = labels();
  (withForm.form as Record<string, unknown>).url = 'https://quote.example';
  only(validateLabels(withForm, elements), 'unknown_property', 'form.url');
});

test('shape errors: missing properties and wrong types', () => {
  only(validateLabels(labels({ e1: { shown_if: undefined } }), elements), 'missing_property', 'elements[0].shown_if');
  only(validateLabels(labels({ e1: { key: 7 as unknown as string } }), elements), 'invalid_type', 'elements[0].key');
  only(validateLabels('labels', elements), 'invalid_type', '$');
  const v = validateLabels({ form: { purpose: '', intent: 'Car Insurance' }, elements: [], advance_action_id: null }, elements.slice(0, 1));
  assert.deepEqual(codes(v), ['invalid_purpose', 'invalid_intent', 'missing_label']);
});

test('hidden elements without shown_if are excluded, never labelled fillable', () => {
  // e4 (a hidden "Leave this empty" box) is unlabelled: excluded, not an error.
  const v = validateLabels(labels(), elements);
  assert.ok(v.ok);
  assert.deepEqual(v.excluded, [{ id: 'e4', label: 'Leave this empty', reason: 'hidden_without_condition' }]);
  assert.ok(!v.labels.elements.some((l) => l.id === 'e4'));

  // Labelled without a condition: still excluded.
  const labelled = validateLabels(labels({ e4: { id: 'e4', key: 'custom.website', risk: 'safe', shown_if: null } }), elements);
  assert.ok(labelled.ok);
  assert.deepEqual(labelled.excluded.map((x) => x.id), ['e4']);
  assert.ok(!labelled.labels.elements.some((l) => l.id === 'e4'));

  // Hidden but conditional (e3): kept.
  assert.ok(v.labels.elements.some((l) => l.id === 'e3'));
  // A hidden field labelled without its condition is dropped too, so the condition-less claim date never becomes fillable.
  const noCond = validateLabels(labels({ e3: { shown_if: null } }), elements);
  assert.ok(noCond.ok);
  assert.deepEqual(noCond.excluded.map((x) => x.id), ['e3', 'e4']);
});

test('advance_action_id must be a labelled action or null', () => {
  only(validateLabels(labels({}, { advance_action_id: 'e1' }), elements), 'advance_not_action');
  only(validateLabels(labels({}, { advance_action_id: 'e77' }), elements), 'advance_not_action');
  assert.ok(validateLabels(labels({}, { advance_action_id: null }), elements).ok);
});

test('all errors are reported together, each with a path, code and message', () => {
  const v = validateLabels(labels({ e1: { key: 'nope' }, e2: { risk: 'risky' }, e9: null }), elements);
  assert.equal(v.ok, false);
  assert.deepEqual(codes(v).sort(), ['invalid_risk', 'missing_label', 'unknown_key']);
  for (const e of v.errors) assert.deepEqual(Object.keys(e), ['path', 'code', 'message']);
});
