// Fine-tuning dataset from the compiler log: one example per labelled element. The input is what a
// small model would see about one element (label, control, options summary, form purpose,
// neighbours); the output is the semantic key and risk Muse Spark gave it, after the compiler's
// validation and risk floors. De-duplicated, and split into train and eval by form, so no eval form
// is ever seen in training. Structure only: the compiler log never holds anything anyone typed.
//
//   npm run finetune:export -- [--log data/compiler-log] [--out data/finetune] [--models muse-spark-1.3] [--eval-share 0.2] [--since 2026-10-27T10:00Z]
//
// --since keeps only labels logged from then on, so a set can be rebuilt from one prompt's labels
// without older runs outvoting them.
//
// Owners' corrections from a walkthrough (task: correction, owner_verified) are examples too, and
// they win: an element an owner corrected takes the owner's answer over any number of model runs.
// In production they are kept in the registry's corrections table; --corrections reads an export
// of it (one JSON record per line).

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chatRow, correctionExample, dedupeExamples, exampleId, exampleSource, isOwnerVerified, splitByForm, type CorrectionRecord } from '../src/index.ts';
import { systemPrompt, withCandidates, type ElementInput, type Example } from './finetune-shared.ts';

const { values } = parseArgs({
  options: {
    log: { type: 'string', default: 'data/compiler-log' },
    out: { type: 'string', default: 'data/finetune' },
    // The teacher: Muse Spark's labels by default (Spark Open's are a different student).
    models: { type: 'string', default: 'muse-spark-1.3' },
    'eval-share': { type: 'string', default: '0.2' },
    since: { type: 'string' },
    corrections: { type: 'string' },
    // Also write the counts the /learning page shows to reports/learning.json (committed).
    publish: { type: 'boolean', default: false },
  },
});
const models = new Set(values.models.split(','));
const evalShare = Number(values['eval-share']);
const since = values.since ? Date.parse(values.since) : null;
if (since !== null && Number.isNaN(since)) {
  console.error(`--since ${values.since} is not a date.`);
  process.exit(2);
}

interface Extracted {
  id: string;
  kind: string;
  control?: string;
  label: string;
  required?: boolean;
  visible?: boolean;
  options?: { items: { value: string; label: string }[]; total: number };
  constraints?: Record<string, unknown>;
}

const describe = (e: Extracted) => `${e.control ?? e.kind}: ${e.label}`;

function optionsSummary(e: Extracted): string | null {
  if (!e.options) return null;
  const names = e.options.items.slice(0, 8).map((o) => o.label);
  return `${e.options.total} options: ${names.join(', ')}${e.options.total > names.length ? ', …' : ''}`;
}

const files = (await readdir(values.log).catch(() => [] as string[])).filter((f) => f.endsWith('.jsonl')).sort();
if (!files.length) {
  // The log is local and gitignored: it fills as the compiler runs (npm run compile, npm run accuracy, the viewer).
  console.error(`No compiler log in ${values.log}. Compile some forms first, e.g. npm run accuracy (needs MODEL_API_KEY).`);
  process.exit(1);
}
const examples: Example[] = [];
let records = 0;
let skipped = 0;
let corrections = 0;

function addCorrection(c: CorrectionRecord) {
  const ex = correctionExample(c);
  if (!ex) return;
  corrections++;
  examples.push(ex);
}
if (values.corrections) for (const line of (await readFile(values.corrections, 'utf8')).split('\n').filter(Boolean)) addCorrection(JSON.parse(line) as CorrectionRecord);

for (const file of files) {
  for (const line of (await readFile(join(values.log, file), 'utf8')).split('\n').filter(Boolean)) {
    const raw = JSON.parse(line) as { task?: string; owner_verified?: boolean };
    if (raw.task === 'correction' && raw.owner_verified) {
      addCorrection(raw as CorrectionRecord);
      continue;
    }
    const r = raw as {
      ts: string;
      task?: string;
      model: string;
      url: string;
      request: { messages: { role: string; content: string | { type: string; text?: string }[] }[] };
      response?: { choices?: { message?: { content?: string } }[] };
      validation?: { ok: boolean; clamps: { id: string; final: string }[]; excluded: { id: string }[] };
    };
    // Labelling calls only, by the teacher, that passed validation.
    if (r.task || !models.has(r.model) || (since !== null && Date.parse(r.ts) < since)) continue;
    records++;
    if (!r.validation?.ok) {
      skipped++;
      continue;
    }
    const user = r.request.messages.find((m) => m.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : (user?.content.find((p) => p.type === 'text')?.text ?? '');
    const extraction = JSON.parse(text.slice(text.indexOf('{'))) as { page: { path: string; title?: string }; elements: Extracted[] };
    const response = JSON.parse(r.response?.choices?.[0]?.message?.content ?? 'null') as { form?: { purpose?: string }; elements?: { id: string; key: string; risk: string }[] } | null;
    if (!response?.elements) continue;
    const clamps = new Map(r.validation.clamps.map((c) => [c.id, c.final]));
    const excluded = new Set(r.validation.excluded.map((e) => e.id));
    const url = new URL(r.url);
    const form = `${exampleSource(url)}${extraction.page.path}`;
    const elements = extraction.elements;
    for (const label of response.elements) {
      const i = elements.findIndex((e) => e.id === label.id);
      if (i < 0 || excluded.has(label.id)) continue;
      const e = elements[i]!;
      const input: ElementInput = withCandidates({
        label: e.label,
        kind: e.kind,
        control: e.control ?? null,
        required: e.required ?? false,
        options: optionsSummary(e),
        constraints: e.constraints ?? null,
        form_purpose: response.form?.purpose ?? '',
        page_title: extraction.page.title ?? '',
        neighbours: { before: elements.slice(Math.max(0, i - 2), i).map(describe), after: elements.slice(i + 1, i + 3).map(describe) },
      });
      examples.push({ id: exampleId(input), input, output: { key: label.key, risk: clamps.get(label.id) ?? label.risk }, meta: { source: exampleSource(url), path: extraction.page.path, form, model: r.model } });
    }
  }
}

// De-duplicate by the element's structure and neighbours: an owner's answer wins, else the most
// common answer. Then split by form, so no eval form is seen in training (training-set.ts).
const { unique, conflicts } = dedupeExamples(examples);
const { train, eval: evals } = splitByForm(unique, evalShare);

// Chat format for SFT (Baseten, Fireworks or Modal): system, user, assistant.
const SYSTEM = await systemPrompt({ shortlist: true });
const chat = (ex: Example) => chatRow(ex, SYSTEM);

await mkdir(values.out, { recursive: true });
const write = (name: string, rows: string[]) => writeFile(join(values.out, name), rows.map((r) => `${r}\n`).join(''));
await write('train.jsonl', train.map((ex) => JSON.stringify(ex)));
await write('eval.jsonl', evals.map((ex) => JSON.stringify(ex)));
await write('train.chat.jsonl', train.map(chat));
await write('eval.chat.jsonl', evals.map(chat));
const count = (rows: Example[], f: (ex: Example) => string) => Object.fromEntries([...rows.reduce((m, ex) => m.set(f(ex), (m.get(f(ex)) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]));
const stats = {
  generated: new Date().toISOString(),
  log_records: records,
  failed_validation: skipped,
  examples_before_dedup: examples.length,
  unique: unique.length,
  conflicting_inputs: conflicts,
  owner_corrections: corrections,
  owner_verified: { total: unique.filter(isOwnerVerified).length, train: train.filter(isOwnerVerified).length, eval: evals.filter(isOwnerVerified).length },
  train: train.length,
  eval: evals.length,
  forms: { train: [...new Set(train.map((ex) => ex.meta.form))].length, eval: [...new Set(evals.map((ex) => ex.meta.form))].length },
  eval_forms: [...new Set(evals.map((ex) => ex.meta.form))].sort(),
  by_source: count(unique, (ex) => ex.meta.source),
  by_risk: count(unique, (ex) => ex.output.risk),
};
await writeFile(join(values.out, 'stats.json'), `${JSON.stringify(stats, null, 2)}\n`);
if (values.publish) {
  const report = new URL('../../../reports/learning.json', import.meta.url);
  const current = JSON.parse(await readFile(report, 'utf8').catch(() => '{}')) as Record<string, unknown>;
  const dataset = { generated: stats.generated, unique: stats.unique, train: stats.train, eval: stats.eval, forms: stats.forms.train + stats.forms.eval, owner_verified: stats.owner_verified.total };
  await writeFile(report, `${JSON.stringify({ ...current, dataset }, null, 2)}\n`);
}
console.log(JSON.stringify(stats, null, 2));
