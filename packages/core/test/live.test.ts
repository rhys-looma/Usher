// Live compile against Muse Spark. Runs only with USHER_LIVE=1 and MODEL_API_KEY (or .env).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compilePage, compilerModel, modelApi, summary } from '../src/index.ts';
import { loadDotEnv } from '../src/compile/env.ts';
import { launch, openStep } from './helpers.ts';
import { mapSchemaErrors } from './map-schema.ts';

const live = process.env.USHER_LIVE === '1';

test('live: Muse Spark compiles step 1 (layout A) to the expected keys', { skip: !live && 'set USHER_LIVE=1 to call the model API' }, async () => {
  loadDotEnv();
  const expected: [string, string][] = JSON.parse(await readFile(new URL('./fixtures/expected-keys.json', import.meta.url), 'utf8')).a.driver;
  const browser = await launch();
  const { context, page } = await openStep(browser, 'a', 'driver');
  try {
    const result = await compilePage(page, { chat: modelApi(), model: compilerModel() });
    console.log(summary(result));
    assert.equal(mapSchemaErrors(result.map), null);
    assert.deepEqual([...result.map.fields, ...result.map.actions].map((e) => [e.label, e.key]), expected);
  } finally {
    await context.close();
    await browser.close();
  }
});
