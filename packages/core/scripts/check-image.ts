// Checks that the labelling model reads images on our endpoint: a picture with one word drawn in
// it, the model asked for the word. Records the exchange (the image's hash, not the image) to
// test/fixtures/image-check.json for the test to read. Needs MODEL_API_KEY.
//   node --import tsx packages/core/scripts/check-image.ts

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { compilerModel, modelApi } from '../src/index.ts';
import { loadDotEnv } from '../src/compile/env.ts';

loadDotEnv();
const WORD = 'LANTERN';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 160 } });
await page.setContent(`<body style="margin:0;display:grid;place-items:center;height:160px;font:bold 56px sans-serif">${WORD}</body>`);
const png = (await page.screenshot({ type: 'png' })).toString('base64');
await browser.close();
const model = compilerModel();
const result = await modelApi()({
  model,
  temperature: 0,
  response_format: { type: 'json_schema', json_schema: { name: 'word', strict: true, schema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false } } },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'What single word is written in this image? Reply with the word only.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] }],
});
const read = ((JSON.parse(result.content) as { word?: string }).word ?? '').trim();
const fixture = { model, recorded_at: new Date().toISOString(), word: WORD, image_sha256: createHash('sha256').update(png).digest('hex'), reply: read, accepted: read.toUpperCase().includes(WORD), latency_ms: result.latency_ms, usage: result.usage };
await writeFile(new URL('../test/fixtures/image-check.json', import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`${model}: ${fixture.accepted ? 'reads images' : 'did not read the image'} (replied "${read}", ${result.latency_ms} ms)`);
