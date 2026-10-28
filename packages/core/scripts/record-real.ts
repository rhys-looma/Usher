// Records Muse Spark compiling a real page from its captured structure (fixtures/real/*), rebuilt as
// markup and served at the page's own address: the labels it gives, for the test to replay. Needs
// MODEL_API_KEY. Nothing is loaded from the real site; the capture holds structure only.
//   node --import tsx packages/core/scripts/record-real.ts aviva-life/01-personal-details.json

import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { compilePage, compilerModel, modelApi, summary } from '../src/index.ts';
import { loadDotEnv } from '../src/compile/env.ts';
import { openRebuilt, readReal } from '../test/real.ts';
import { recordingChat, type RecordedAttempt } from '../test/replay.ts';

loadDotEnv();
const file = process.argv[2];
if (!file) throw new Error('Which capture? For example aviva-life/01-personal-details.json');
const captured = await readReal(file);
const browser = await chromium.launch();
const { page } = await openRebuilt(browser, captured);
const attempts: RecordedAttempt[] = [];
const model = compilerModel();
const result = await compilePage(page, { chat: recordingChat(modelApi(), attempts), model, logDir: null });
await browser.close();
const out = new URL(`../test/fixtures/real/${file.replace(/\.json$/, '.labels.json')}`, import.meta.url);
await writeFile(out, `${JSON.stringify({ model, recorded_at: new Date().toISOString(), attempts }, null, 2)}\n`);
console.log(summary(result));
for (const e of [...result.map.fields, ...result.map.actions]) console.log(`${e.id.padEnd(4)} ${e.key.padEnd(28)} ${e.risk.padEnd(14)} ${e.label.slice(0, 70)}`);
