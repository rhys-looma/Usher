// npm run compile -- <url> [--out file] [--form n] [--path pattern] [--intent i] [--classify] [--open] [--examples train.jsonl] [--vote]
//
// Compiles the form on a page into an Usher map with Muse Spark, prints the map (or writes it
// to --out) and a one-line cost and latency summary. --open labels with Muse Spark Open instead;
// --examples adds retrieval few-shot to Spark Open's prompts (the labeller with --open, and the
// classifier), from a file in the fine-tuning export's format. --vote labels in vote mode (up to three
// runs, contested elements only, majority per element); one run is the default.

import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { CompileError, compileUrl, summary } from './compile.ts';
import { loadDotEnv } from './env.ts';
import { compilerModel, modelApi, openModel } from './model.ts';
import { ExampleIndex } from './retrieval.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string' }, form: { type: 'string' }, path: { type: 'string' }, intent: { type: 'string' }, classify: { type: 'boolean', default: false }, vote: { type: 'boolean', default: false }, open: { type: 'boolean', default: false }, examples: { type: 'string' } },
});
const url = positionals[0];
if (!url) {
  console.error('Usage: npm run compile -- <url> [--out file] [--form n] [--path pattern]');
  process.exit(2);
}

loadDotEnv();
const examples = values.examples ? await ExampleIndex.fromFile(values.examples) : undefined;
try {
  const result = await compileUrl(url, {
    chat: modelApi(values.open ? { provider: 'baseten' } : {}),
    model: values.open ? openModel() : compilerModel(),
    ...(values.open && examples && { examples }),
    ...(values.intent !== undefined && { intent: values.intent }),
    ...(values.form !== undefined && { formIndex: Number(values.form) }),
    ...(values.path !== undefined && { path: values.path }),
    ...(values.vote && { vote: true }),
    // A second opinion on risk from Muse Spark Open on Baseten.
    ...(values.classify && { classifier: { chat: modelApi({ provider: 'baseten' }), model: openModel(), ...(examples && { examples }) } }),
  });
  const json = `${JSON.stringify(result.map, null, 2)}\n`;
  if (values.out) await writeFile(values.out, json);
  else process.stdout.write(json);
  for (const c of result.clamps) console.error(`clamped ${c.id} ${c.key}: ${c.labelled} → ${c.final} (${c.reason})`);
  for (const x of result.excluded) console.error(`excluded ${x.id} "${x.label}": hidden with no condition`);
  const c = result.classifier;
  if (c && 'error' in c) console.error(`classifier failed: ${c.error}`);
  else if (c) {
    for (const f of c.flags) console.error(`flagged ${f.id} ${f.key}: labeller ${f.labeller}, classifier ${f.classifier}, kept ${f.kept} (${f.reason})`);
    console.error(`classifier ${c.model}: ${Math.round(c.agreement * 100)}% agreement`);
  }
  console.error(summary(result));
} catch (err) {
  if (err instanceof CompileError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
