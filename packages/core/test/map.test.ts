import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fingerprint, mergeMap, validateLabels, type Provenance, type ScannedForm } from '../src/index.ts';
import { launch, openStep, scan } from './helpers.ts';
import { mapSchemaErrors } from '../src/schemas.ts';

const read = async (path: string) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const example = await read('../../../spec/examples/quote-driver.map.json');
const handLabels = await read('./fixtures/hand-labels-driver-a.json');
const provenance: Provenance = { source: 'compiled', compiler: 'test', created_at: '2026-10-27T09:00:00Z', verified: false };

test('hand-written labels for step 1 (layout A) merge into the example map, apart from provenance', async () => {
  const browser = await launch();
  const { context, page } = await openStep(browser, 'a', 'driver');
  const result = await scan(page);
  await context.close();
  await browser.close();

  const form = result.forms[0]!;
  const validation = validateLabels(handLabels, form.elements);
  assert.ok(validation.ok, JSON.stringify(validation.errors));
  assert.deepEqual(validation.clamps, []);
  assert.deepEqual(validation.excluded, []);

  const map = mergeMap({
    form,
    fingerprint: await fingerprint(form.elements),
    validation,
    origin: 'https://quote.example',
    path: '/quote/driver',
    step: 1,
    leadsTo: '/quote/vehicle',
    provenance,
  });
  assert.equal(mapSchemaErrors(map), null);
  const expected = { ...example, provenance };
  assert.deepEqual(map, expected);
  // Same property order too, so the JSON is byte-for-byte the same.
  assert.equal(JSON.stringify(map, null, 2), JSON.stringify(expected, null, 2));
});

// A synthetic scanned form with a group, a sensitive field and a honeypot.
const form: ScannedForm = {
  index: 0,
  pseudo: false,
  banner: false,
  search: false,
  newsletter: false,
  groups: [
    { id: 'g1', label: 'Account' },
    { id: 'g2', label: 'Unused' },
  ],
  elements: [
    { id: 'e1', kind: 'field', tag: 'input', control: 'email', required: true, label: 'Email', labelSource: 'label-for', group: 'g1', box: { x: 0, y: 0, width: 200, height: 30 }, visible: true, locators: [{ by: 'label', value: 'Email' }] },
    { id: 'e2', kind: 'field', tag: 'input', control: 'password', required: true, label: 'Password', labelSource: 'label-for', group: 'g1', constraints: { min_length: 8 }, box: { x: 0, y: 40, width: 200, height: 30 }, visible: true, locators: [{ by: 'label', value: 'Password' }] },
    { id: 'e3', kind: 'field', tag: 'input', control: 'text', required: false, label: 'Website', labelSource: 'label-for', group: 'g2', box: { x: 0, y: 0, width: 0, height: 0 }, visible: false, locators: [{ by: 'name', value: 'website' }] },
    { id: 'e4', kind: 'action', tag: 'button', control: 'submit', required: false, label: 'Create account', labelSource: 'content', role: 'button', box: { x: 0, y: 80, width: 120, height: 30 }, visible: true, locators: [{ by: 'role', value: 'button', name: 'Create account' }] },
  ],
};

test('merge: sensitive fields, groups in use only, honeypots left out, schema-valid', async () => {
  const validation = validateLabels(
    {
      form: { purpose: 'Create an account', intent: 'account.create' },
      elements: [
        { id: 'e1', key: 'contact.email', risk: 'safe', shown_if: null },
        { id: 'e2', key: 'account.password', risk: 'safe', shown_if: null },
        { id: 'e4', key: 'account.create', risk: 'safe', shown_if: null },
      ],
      advance_action_id: 'e4',
    },
    form.elements,
  );
  assert.ok(validation.ok, JSON.stringify(validation.errors));
  const map = mergeMap({ form, fingerprint: await fingerprint(form.elements), validation, origin: 'https://shop.example', path: '/signup', provenance });
  assert.equal(mapSchemaErrors(map), null);
  assert.deepEqual(map.groups, [{ id: 'g1', label: 'Account' }]);
  assert.deepEqual(map.fields.map((f) => f.id), ['e1', 'e2']);
  assert.deepEqual(map.fields[1], {
    id: 'e2',
    key: 'account.password',
    label: 'Password',
    control: 'password',
    required: true,
    risk: 'needs_user',
    sensitive: true,
    constraints: { min_length: 8 },
    group: 'g1',
    locators: [{ by: 'label', value: 'Password' }],
  });
  assert.deepEqual(map.fields[0]!.constraints, { format: 'email' });
  assert.equal(map.actions[0]!.risk, 'needs_user');
  assert.equal(map.actions[0]!.leads_to, undefined);
  assert.deepEqual(map.form, { purpose: 'Create an account', intent: 'account.create' });
});

test('merge refuses labels that failed validation', async () => {
  const validation = validateLabels({ form: { purpose: 'x', intent: 'x' }, elements: [], advance_action_id: null }, form.elements);
  assert.equal(validation.ok, false);
  await assert.rejects(async () => mergeMap({ form, fingerprint: await fingerprint(form.elements), validation, origin: 'https://shop.example', path: '/signup', provenance }), /validation error/);
});
