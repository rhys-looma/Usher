// Records the model's labels for every mock-site step and layout. Run through
// `npm run fixtures:record` (Muse Spark, MODEL_API_KEY, into test/fixtures/labels) or
// `npm run fixtures:record:open` (Muse Spark Open on Baseten, BASETEN_API_KEY, into
// test/fixtures/labels-open), which start the mock sites.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { CompileError, compilePage, compilerModel, modelApi, openModel } from '../src/index.ts';
import { loadDotEnv } from '../src/compile/env.ts';
import { HEALTH_STEPS, LAYOUTS, STEPS, launch, openStep, type AnyStep, type Layout } from '../test/helpers.ts';
import { fixtureUrl, recordingChat, type LabelFixture, type RecordedAttempt } from '../test/replay.ts';

loadDotEnv();
const open = process.argv.includes('--open');
const chat = modelApi({ provider: open ? 'baseten' : 'meta' });
const model = open ? openModel() : compilerModel();
const set = open ? 'labels-open' : 'labels';
const browser = await launch();
const rows: string[] = [];
let failed = false;

// --layout c records one layout only; --journey health or car one journey. Brightwater Health's
// layout C is layout A, so it has no recording of its own.
const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const only = arg('--layout') as Layout | null;
const journey = arg('--journey');
// --only-missing re-records only steps whose fixture has no response (a provider error last time).
const onlyMissing = process.argv.includes('--only-missing');
const hasResponse = async (layout: Layout, step: AnyStep) => {
  const recorded = await readFile(fixtureUrl(layout, step, set), 'utf8').then((t) => JSON.parse(t) as LabelFixture, () => null);
  return Boolean(recorded?.attempts.length);
};
for (const layout of only ? [only] : [...LAYOUTS, 'c' as Layout]) {
  // Muse Spark Open's set has no layout C (the open-weights tests read layouts A and B).
  if (open && layout === 'c') continue;
  const steps: AnyStep[] = [...(journey === 'health' ? [] : STEPS), ...(journey === 'car' || layout === 'c' ? [] : HEALTH_STEPS)];
  for (const step of steps) {
    if (onlyMissing && (await hasResponse(layout, step))) continue;
    const attempts: RecordedAttempt[] = [];
    const { context, page } = await openStep(browser, layout, step);
    let note = '';
    try {
      // A provider that drops the connection gets two more tries; a refusal or a bad answer doesn't.
      const compile = async (tries: number): ReturnType<typeof compilePage> => {
        try {
          return await compilePage(page, { chat: recordingChat(chat, attempts), model });
        } catch (err) {
          if (tries <= 1 || !/fetch failed/.test(String(err))) throw err;
          attempts.length = 0;
          return compile(tries - 1);
        }
      };
      const result = await compile(3);
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
