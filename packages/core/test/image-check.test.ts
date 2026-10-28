// The labelling model reads images on our endpoint (recorded by scripts/check-image.ts): the
// walkthrough and the compiler send a masked screenshot with every page, for meaning only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Muse Spark read the word drawn in a picture', async () => {
  const check = JSON.parse(await readFile(new URL('./fixtures/image-check.json', import.meta.url), 'utf8')) as { model: string; word: string; reply: string; accepted: boolean };
  assert.equal(check.model, 'muse-spark-1.3');
  assert.ok(check.accepted, `replied "${check.reply}"`);
  assert.match(check.reply.toUpperCase(), new RegExp(check.word));
});
