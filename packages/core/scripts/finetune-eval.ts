// Scores per-element predictions (key and risk) against the held-out eval set from
// finetune:export. Predictions come from a file, from a model called live on each element with the
// same prompt a fine-tuned model would get, or from a no-model baseline.
//
//   npm run finetune:eval -- --predictions preds.jsonl      lines of { "id", "key", "risk" }
//   npm run finetune:eval -- --model muse-spark-1.3         live, Meta Model API (about $0.002 an element)
//   npm run finetune:eval -- --model meta-models/muse-spark-open --provider baseten
//   npm run finetune:eval -- --baseline                     the commonest key and risk per control in train
//
// Options: --data data/finetune, --save preds.jsonl (write the predictions), --report file.md.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { costUsd, modelApi, parseJsonContent, type ChatRequest } from '../src/index.ts';
import { loadDotEnv } from '../src/compile/env.ts';
import { systemPrompt, type Example } from './finetune-shared.ts';
import { compareKeys, singleNameField, type KeyComparison } from './key-equivalence.ts';

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: 'data/finetune' },
    predictions: { type: 'string' },
    model: { type: 'string' },
    provider: { type: 'string', default: 'meta' },
    baseline: { type: 'boolean', default: false },
    save: { type: 'string' },
    report: { type: 'string' },
  },
});
loadDotEnv();

const readJsonl = async <T>(path: string): Promise<T[]> => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
const evalSet = await readJsonl<Example>(join(values.data, 'eval.jsonl')).catch(() => {
  console.error(`No eval set at ${join(values.data, 'eval.jsonl')}. Run npm run finetune:export first.`);
  process.exit(1);
});
if (!evalSet.length) {
  console.error(`The eval set at ${join(values.data, 'eval.jsonl')} is empty. Compile more forms, then run npm run finetune:export again.`);
  process.exit(1);
}
const train = await readJsonl<Example>(join(values.data, 'train.jsonl')).catch(() => [] as Example[]);
const vocabulary = JSON.parse(await readFile(new URL('../../../spec/vocabulary.json', import.meta.url), 'utf8')) as { entries: { key: string }[] };
const keys = new Set(vocabulary.entries.map((e) => e.key));

interface Prediction {
  id: string;
  key: string | null;
  risk: string | null;
}

let predictions: Prediction[];
let source: string;
let spend = 0;
if (values.predictions) {
  predictions = await readJsonl<Prediction>(values.predictions);
  source = values.predictions;
} else if (values.baseline) {
  // The floor any model should beat: the commonest answer for the element's control in training.
  const commonest = (control: string, field: 'key' | 'risk') => {
    const counts = new Map<string, number>();
    for (const ex of train.filter((t) => (t.input.control ?? t.input.kind) === control)) counts.set(ex.output[field], (counts.get(ex.output[field]) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (field === 'risk' ? 'safe' : null);
  };
  predictions = evalSet.map((ex) => ({ id: ex.id, key: commonest(ex.input.control ?? ex.input.kind, 'key'), risk: commonest(ex.input.control ?? ex.input.kind, 'risk') }));
  source = 'baseline: commonest key and risk per control in train';
} else if (values.model) {
  const chat = modelApi({ provider: values.provider as 'meta' | 'baseten' });
  const system = await systemPrompt();
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['key', 'risk'],
    properties: { key: { type: 'string' }, risk: { type: 'string', enum: ['safe', 'consequential', 'needs_user'] } },
  };
  predictions = [];
  // A few at a time; the system prompt is the same for every element, so it caches.
  const queue = [...evalSet];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let ex = queue.shift(); ex; ex = queue.shift()) {
        const request: ChatRequest = {
          model: values.model!,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify(ex.input) },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'element_label', strict: true, schema } },
        };
        try {
          const result = await chat(request);
          spend += costUsd(values.model!, result.usage) ?? 0;
          const out = parseJsonContent(result.content) as { key?: unknown; risk?: unknown };
          predictions.push({ id: ex.id, key: typeof out.key === 'string' ? out.key : null, risk: typeof out.risk === 'string' ? out.risk : null });
        } catch (err) {
          console.error(`${ex.id}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
          predictions.push({ id: ex.id, key: null, risk: null });
        }
      }
    }),
  );
  source = `${values.model} (${values.provider}), live`;
} else {
  console.error('Give --predictions <file>, --model <id> [--provider baseten], or --baseline.');
  process.exit(1);
}
if (values.save) await writeFile(values.save, predictions.map((p) => `${JSON.stringify(p)}\n`).join(''));

// Whether each form has a single name field, from every example of it (train and eval), so a
// full name against a first name counts as equivalent there.
const formKeys = new Map<string, string[]>();
for (const ex of [...train, ...evalSet]) formKeys.set(ex.meta.form, [...(formKeys.get(ex.meta.form) ?? []), ex.output.key]);

// Scoring. Under-calling risk is the error that matters: an agent would act where the site wanted
// the user asked, or the user alone to act.
const RANK: Record<string, number> = { safe: 0, consequential: 1, needs_user: 2 };
const byId = new Map(predictions.map((p) => [p.id, p]));
let key = 0;
let keyEquivalent = 0;
let risk = 0;
let both = 0;
let bothEquivalent = 0;
const misses = new Map<KeyComparison, number>();
let under = 0;
let over = 0;
let missing = 0;
let unknownKeys = 0;
const confusion = new Map<string, number>();
for (const ex of evalSet) {
  const p = byId.get(ex.id);
  if (!p || p.key === null || p.risk === null) {
    missing++;
    continue;
  }
  if (!keys.has(p.key)) unknownKeys++;
  const comparison = compareKeys(p.key, ex.output.key, { singleNameField: singleNameField(formKeys.get(ex.meta.form) ?? []) });
  const k = comparison === 'exact';
  const ke = k || comparison === 'synonym' || comparison === 'custom_same';
  const r = p.risk === ex.output.risk;
  key += Number(k);
  keyEquivalent += Number(ke);
  risk += Number(r);
  both += Number(k && r);
  bothEquivalent += Number(ke && r);
  if (!k) misses.set(comparison, (misses.get(comparison) ?? 0) + 1);
  if ((RANK[p.risk] ?? -1) < RANK[ex.output.risk]!) under++;
  if ((RANK[p.risk] ?? -1) > RANK[ex.output.risk]!) over++;
  confusion.set(`${ex.output.risk} → ${p.risk}`, (confusion.get(`${ex.output.risk} → ${p.risk}`) ?? 0) + 1);
}
const MISS_NAMES: Record<KeyComparison, string> = {
  exact: 'exact',
  synonym: 'synonym (counted as equivalent)',
  custom_same: 'custom keys, same slug once normalised (counted as equivalent)',
  custom_wording: 'custom keys, worded differently',
  custom_vs_vocabulary: 'custom key against a vocabulary key',
  different: 'different vocabulary keys',
};
const n = evalSet.length;
const pct = (x: number) => `${((100 * x) / n).toFixed(1)}%`;
const lines = [
  `# Per-element eval: ${source}`,
  '',
  `${n} held-out elements from ${new Set(evalSet.map((e) => e.meta.form)).size} forms never seen in training.`,
  '',
  '| Measure | Result |',
  '| --- | --- |',
  `| Key correct, exact | ${key}/${n} (${pct(key)}) |`,
  `| Key correct, equivalent | ${keyEquivalent}/${n} (${pct(keyEquivalent)}) |`,
  `| Risk correct | ${risk}/${n} (${pct(risk)}) |`,
  `| Both correct, exact | ${both}/${n} (${pct(both)}) |`,
  `| Both correct, equivalent | ${bothEquivalent}/${n} (${pct(bothEquivalent)}) |`,
  `| Risk under-called (unsafe) | ${under} |`,
  `| Risk over-called | ${over} |`,
  `| custom.* keys (not in the vocabulary) | ${unknownKeys} |`,
  `| No usable answer | ${missing} |`,
  ...(spend ? [`| Model spend | $${spend.toFixed(4)} |`] : []),
  '',
  'Key misses (not exact), by kind:',
  '',
  ...(['synonym', 'custom_same', 'custom_wording', 'custom_vs_vocabulary', 'different'] as const).filter((c) => misses.has(c)).map((c) => `- ${MISS_NAMES[c]}: ${misses.get(c)}`),
  '',
  'Risk, expected → predicted:',
  '',
  ...[...confusion].sort().map(([k, v]) => `- ${k}: ${v}`),
  '',
];
console.log(lines.join('\n'));
if (values.report) await writeFile(values.report, lines.join('\n'));
