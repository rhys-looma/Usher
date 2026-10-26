// Records the model's labels for every mock-site step and layout. Run through
// `npm run fixtures:record` (Muse Spark, MODEL_API_KEY, into test/fixtures/labels) or
// `npm run fixtures:record:open` (Muse Spark Open on Baseten, BASETEN_API_KEY, into
// test/fixtures/labels-open), which start the mock sites.

import { mkdir, writeFile } from 'node:fs/promises';
import { CompileError, compilePage, compilerModel, modelApi, openModel } from '../src/index.ts';
import { loadDotEnv } from '../src/compile/env.ts';
import { LAYOUTS, STEPS, launch, openStep } from '../test/helpers.ts';
import { fixtureUrl, recordingChat, type LabelFixture, type RecordedAttempt } from '../test/replay.ts';

loadDotEnv();
const open = process.argv.includes('--open');
const chat = modelApi({ provider: open ? 'baseten' : 'meta' });
const model = open ? openModel() : compilerModel();
const set = open ? 'labels-open' : 'labels';
const browser = await launch();
const rows: string[] = [];
let failed = false;

for (const layout of LAYOUTS) {
  for (const step of STEPS) {
    const attempts: RecordedAttempt[] = [];
    const { context, page } = await openStep(browser, layout, step);
    let note = '';
    try {
      const result = await compilePage(page, { chat: recordingChat(chat, attempts), model });
      note = [
        ...result.attempts.slice(0, -1).flatMap((a) => a.errors.map((e) => `${e.path} ${e.code}`)),
        ...result.clamps.map((c) => `clamped ${c.id} ${c.key} ${c.labelled}→${c.final}`),
        ...result.excluded.map((x) => `excluded ${x.id}`),
      ].join('; ');
      const cost = result.cost_usd === null ? '?' : `$${result.cost_usd.toFixed(4)}`;
      rows.push(`| ${layout.toUpperCase()} | ${step} | ${result.attempts.length} | ${result.usage.prompt_tokens} | ${result.usage.completion_tokens} | ${cost} | ${(result.model_ms / 1000).toFixed(1)} s | ${note || '–'} |`);
    } catch (err) {
      failed = true;
      rows.push(`| ${layout.toUpperCase()} | ${step} | failed | | | | | ${err instanceof CompileError ? err.errors.map((e) => e.code).join(', ') : String(err)} |`);
    }
    await context.close();
    const fixture: LabelFixture = { model, recorded_at: new Date().toISOString(), layout, step, attempts };
    await mkdir(new URL(`../test/fixtures/${set}/`, import.meta.url), { recursive: true });
    await writeFile(fixtureUrl(layout, step, set), `${JSON.stringify(fixture, null, 2)}\n`);
  }
}
await browser.close();

console.log(['', '| Layout | Step | Attempts | Input tokens | Output tokens | Cost | Model latency | Validator notes |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows].join('\n'));
if (failed) process.exit(1);
