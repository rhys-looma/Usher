// npm run compile -- <url> [--out file] [--form n] [--path pattern]
//
// Compiles the form on a page into an Usher map with Muse Spark, prints the map (or writes it
// to --out) and a one-line cost and latency summary.

import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { CompileError, compileUrl, summary } from './compile.ts';
import { loadDotEnv } from './env.ts';
import { compilerModel, modelApi } from './model.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string' }, form: { type: 'string' }, path: { type: 'string' } },
});
const url = positionals[0];
if (!url) {
  console.error('Usage: npm run compile -- <url> [--out file] [--form n] [--path pattern]');
  process.exit(2);
}

loadDotEnv();
try {
  const result = await compileUrl(url, {
    chat: modelApi(),
    model: compilerModel(),
    ...(values.form !== undefined && { formIndex: Number(values.form) }),
    ...(values.path !== undefined && { path: values.path }),
  });
  const json = `${JSON.stringify(result.map, null, 2)}\n`;
  if (values.out) await writeFile(values.out, json);
  else process.stdout.write(json);
  for (const c of result.clamps) console.error(`clamped ${c.id} ${c.key}: ${c.labelled} → ${c.final} (${c.reason})`);
  for (const x of result.excluded) console.error(`excluded ${x.id} "${x.label}": hidden with no condition`);
  console.error(summary(result));
} catch (err) {
  if (err instanceof CompileError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
