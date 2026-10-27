// Every element where Muse Spark's key isn't settled, grouped by kind of disagreement:
//   - between runs: the same form (same fingerprint) labelled more than once in the compiler log;
//   - per element against whole form: the fine-tuning eval's per-element predictions against the
//     whole-form labels they are scored on (the "61%" number);
//   - against review: public-form rows of reports/accuracy-review.csv marked key_correct = n (human-checked).
// Writes reports/key-disagreements.md. Run: npm run keys:disagreements [-- --log dir --data dir]

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Example } from './finetune-shared.ts';
import { compareKeys, singleNameField, type KeyComparison } from './key-equivalence.ts';

const root = new URL('../../../', import.meta.url);
const { values } = parseArgs({
  options: {
    log: { type: 'string', default: new URL('data/compiler-log', root).pathname },
    data: { type: 'string', default: new URL('data/finetune', root).pathname },
    predictions: { type: 'string', default: 'preds-spark.jsonl' },
    out: { type: 'string', default: new URL('reports/key-disagreements.md', root).pathname },
    model: { type: 'string', default: 'muse-spark-1.3' },
  },
});

interface Row {
  source: 'between runs' | 'per element vs whole form' | 'review';
  page: string;
  label: string;
  keys: string[];
  kind: KeyComparison;
}
const rows: Row[] = [];

// The worst kind among all pairs of keys, so three keys with one genuine difference count as genuine.
const ORDER: KeyComparison[] = ['exact', 'synonym', 'custom_same', 'custom_wording', 'custom_vs_vocabulary', 'different'];
function kindOf(keys: string[], formKeys: string[]): KeyComparison {
  let worst: KeyComparison = 'exact';
  for (const a of keys) for (const b of keys) {
    const k = compareKeys(a, b, { singleNameField: singleNameField(formKeys) });
    if (ORDER.indexOf(k) > ORDER.indexOf(worst)) worst = k;
  }
  return worst;
}
const where = (url: string) => {
  const u = new URL(url);
  return u.hostname === 'localhost' ? `mock site ${u.pathname}` : `${u.hostname}${u.pathname}`;
};

// 1. Between runs, from the compiler log.
interface LogRecord {
  ts: string;
  task?: string;
  model: string;
  url: string;
  fingerprint: string;
  request: { messages: { role: string; content: unknown }[] };
  response: { choices?: { message?: { content?: string } }[] };
  validation?: { ok: boolean };
}
const files = (await readdir(values.log).catch(() => [] as string[])).filter((f) => f.endsWith('.jsonl')).sort();
const byForm = new Map<string, { url: string; runs: Map<string, string>[]; labels: Map<string, string> }>();
for (const file of files) {
  for (const line of (await readFile(join(values.log, file), 'utf8')).split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as LogRecord;
    if (r.task || r.model !== values.model || !r.validation?.ok) continue;
    const user = r.request.messages.find((m) => m.role === 'user')?.content;
    const text = Array.isArray(user) ? (user.find((p: { type: string }) => p.type === 'text') as { text: string } | undefined)?.text : user;
    const extraction = JSON.parse(String(text).split('Extraction:\n')[1] ?? '{}') as { elements?: { id: string; label: string }[] };
    const content = r.response.choices?.[0]?.message?.content;
    if (!content || !extraction.elements) continue;
    const labels = JSON.parse(content) as { elements: { id: string; key: string }[] };
    const form = byForm.get(r.fingerprint) ?? { url: r.url, runs: [], labels: new Map(extraction.elements.map((e) => [e.id, e.label])) };
    form.runs.push(new Map(labels.elements.map((e) => [e.id, e.key])));
    byForm.set(r.fingerprint, form);
  }
}
let formsRunTwice = 0;
let elementsRunTwice = 0;
for (const form of byForm.values()) {
  if (form.runs.length < 2) continue;
  formsRunTwice++;
  const ids = new Set(form.runs.flatMap((run) => [...run.keys()]));
  const formKeys = [...form.runs[0]!.values()];
  for (const id of ids) {
    const keys = form.runs.map((run) => run.get(id)).filter((k): k is string => Boolean(k));
    if (keys.length < 2) continue;
    elementsRunTwice++;
    const distinct = [...new Set(keys)];
    if (distinct.length > 1) rows.push({ source: 'between runs', page: `${where(form.url)} (${form.runs.length} runs)`, label: form.labels.get(id) ?? id, keys: distinct, kind: kindOf(distinct, formKeys) });
  }
}

// 2. The eval: per-element predictions against the whole-form labels.
const readJsonl = async <T>(path: string): Promise<T[]> => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
const evalSet = await readJsonl<Example>(join(values.data, 'eval.jsonl'));
const train = await readJsonl<Example>(join(values.data, 'train.jsonl'));
const preds = new Map((await readJsonl<{ id: string; key: string | null }>(join(values.data, values.predictions))).map((p) => [p.id, p.key]));
const formKeys = new Map<string, string[]>();
for (const ex of [...train, ...evalSet]) formKeys.set(ex.meta.form, [...(formKeys.get(ex.meta.form) ?? []), ex.output.key]);
let scored = 0;
for (const ex of evalSet) {
  const predicted = preds.get(ex.id);
  if (!predicted) continue;
  scored++;
  if (predicted !== ex.output.key) rows.push({ source: 'per element vs whole form', page: ex.meta.form, label: ex.input.label, keys: [ex.output.key, predicted], kind: kindOf([ex.output.key, predicted], formKeys.get(ex.meta.form) ?? []) });
}

// 3. The review CSV: public-form keys a person marked wrong (mock-site marks are automatic).
const csv = await readFile(new URL('reports/accuracy-review.csv', root), 'utf8').catch(() => '');
const parse = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"|([^,]+)|(?<=,)(?=,|$)/g)].map((m) => (m[1] ?? m[2] ?? '').replace(/""/g, '"'));
const [header, ...lines] = csv.trim().split('\n');
const cols = header ? parse(header) : [];
let reviewed = 0;
for (const line of lines) {
  const r = Object.fromEntries(parse(line).map((v, i) => [cols[i], v])) as Record<string, string>;
  if (r.category === 'mock site') continue;
  if (r.key_correct === 'y' || r.key_correct === 'n') reviewed++;
  if (r.key_correct !== 'n') continue;
  const better = /`?([a-z]+\.[a-z0-9_.]+)`?/.exec(r.notes ?? '')?.[1];
  rows.push({ source: 'review', page: r.form!, label: r.label!, keys: better ? [r.key!, better] : [r.key!], kind: better ? kindOf([r.key!, better], []) : 'different' });
}

// Write it up.
const KINDS: { kind: KeyComparison; title: string; about: string }[] = [
  { kind: 'custom_same', title: 'Custom keys, same slug once normalised', about: 'Both sides used a custom key and the words match after removing filler and plurals (custom.room_count and custom.rooms). Equivalence scoring counts these as correct.' },
  { kind: 'synonym', title: 'Synonym pairs', about: 'Listed synonyms (contact.phone and contact.mobile), or a full name against a first or last name where the form has a single name field. Equivalence scoring counts these as correct.' },
  { kind: 'custom_wording', title: 'Custom slug wording', about: 'Both sides agree nothing in the vocabulary fits and name the element differently. Usually the same meaning; sometimes one side is vaguer (custom.search_result_link).' },
  { kind: 'custom_vs_vocabulary', title: 'Custom key against a vocabulary key', about: 'One side found a vocabulary key and the other invented a custom one. These are genuine disagreements about whether the vocabulary fits.' },
  { kind: 'different', title: 'Genuine disagreement', about: 'Two different vocabulary keys, or a key a reviewer marked wrong.' },
];
const perPage = new Map<string, number>();
for (const r of rows.filter((x) => x.source === 'per element vs whole form')) perPage.set(r.page, (perPage.get(r.page) ?? 0) + 1);
const count = (source: Row['source'], kind?: KeyComparison) => rows.filter((r) => r.source === source && (!kind || r.kind === kind)).length;
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 80);
const out = [
  '# Key disagreements',
  '',
  `Every element where Muse Spark's (\`${values.model}\`) key is not settled, grouped by kind. Generated ${new Date().toISOString().slice(0, 10)} by \`packages/core/scripts/key-disagreements.ts\` from the compiler log, the fine-tuning eval and \`reports/accuracy-review.csv\`. Labels are the page's own text; no values.`,
  '',
  '| Kind | Between runs | Per element vs whole form | Review |',
  '| --- | --- | --- | --- |',
  ...KINDS.map((k) => `| ${k.title} | ${count('between runs', k.kind)} | ${count('per element vs whole form', k.kind)} | ${count('review', k.kind)} |`),
  `| **Total** | **${count('between runs')}** of ${elementsRunTwice} elements on ${formsRunTwice} forms labelled more than once | **${count('per element vs whole form')}** of ${scored} eval elements | **${count('review')}** of ${reviewed} human-checked |`,
  '',
  '- **Between runs**: the same form, by fingerprint, labelled more than once by the compiler. Runs span prompt changes (custom keys encouraged on 26 October, `search.submit` added on 27 October), so some differences are the prompt, not chance.',
  '- **Per element vs whole form**: the fine-tuning eval. Muse Spark sees one element with its neighbours and is scored against its own labels from seeing the whole form with a screenshot. This is the exact-match key accuracy in docs/finetune.md.',
  '- **Review**: public-form keys marked wrong when human-checked in `reports/accuracy-review.csv`.',
  '',
  `Per element vs whole form, by page: ${[...perPage].sort((x, y) => y[1] - x[1]).map(([page, n]) => `${page} ${n}`).join(', ') || 'none'}.`,
  '',
  ...KINDS.flatMap((k) => {
    const these = rows.filter((r) => r.kind === k.kind);
    if (!these.length) return [];
    return [`## ${k.title} (${these.length})`, '', k.about, '', '| Source | Page | Element | Keys |', '| --- | --- | --- | --- |', ...these.map((r) => `| ${r.source} | ${cell(r.page)} | ${cell(r.label)} | ${r.keys.map((x) => `\`${x}\``).join(' / ')} |`), ''];
  }),
];
await writeFile(values.out, out.join('\n'));
console.log(out.slice(0, 13).join('\n'));
