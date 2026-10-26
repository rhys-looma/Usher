import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fingerprint, type Scan } from '../src/index.ts';
import { LAYOUTS, STEPS, launch, openStep, scan } from './helpers.ts';
import { mapSchemaErrors } from './map-schema.ts';

const specDir = new URL('../../../spec/', import.meta.url);

test('every map in spec/examples validates against map.schema.json', async () => {
  const files = (await readdir(new URL('examples/', specDir))).filter((f) => f.endsWith('.map.json'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const map = JSON.parse(await readFile(new URL(`examples/${file}`, specDir), 'utf8'));
    assert.equal(mapSchemaErrors(map), null, file);
  }
});

// A placeholder map built straight from an extraction, with custom keys and no risk
// judgement, to check the extractor's locators, options and constraints fit the schema.
async function draftMap(result: Scan, path: string): Promise<object> {
  const form = result.forms[0]!;
  return {
    usher: '0.1',
    origin: new URL(result.url).origin,
    path,
    fingerprint: await fingerprint(form.elements),
    form: { purpose: 'Schema check draft' },
    groups: form.groups,
    fields: form.elements
      .filter((e) => e.kind === 'field')
      .map((e) => ({
        id: e.id,
        key: `custom.${e.id}`,
        label: e.label,
        control: e.control,
        required: e.required,
        risk: 'safe',
        ...(e.constraints && { constraints: e.constraints }),
        ...(e.options && { options: e.options }),
        ...(e.group && { group: e.group }),
        locators: e.locators,
      })),
    actions: form.elements
      .filter((e) => e.kind === 'action')
      .map((e) => ({ id: e.id, key: `custom.${e.id}`, label: e.label, kind: e.control, risk: 'safe', locators: e.locators })),
    provenance: { source: 'compiled', compiler: 'usher-extractor', created_at: new Date().toISOString(), verified: false },
  };
}

test('draft maps built from every extracted step validate against the schema', async () => {
  const browser = await launch();
  for (const layout of LAYOUTS) {
    for (const step of STEPS) {
      const { context, page } = await openStep(browser, layout, step);
      const map = await draftMap(await scan(page), `/quote/${step}`);
      await context.close();
      assert.equal(mapSchemaErrors(map), null, `${layout} ${step}`);
    }
  }
  await browser.close();
});
