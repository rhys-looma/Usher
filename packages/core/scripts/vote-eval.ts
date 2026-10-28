// Vote mode against the human marks: the public forms someone marked by hand (the latest complete
// run in reports/accuracy-review-*.csv), compiled again live with one run and with vote mode, each
// element matched to its marked row by label and control. A label that matches the marked key
// inherits the mark; a changed key where the mark said right is a regression; a changed key where
// the mark said wrong is listed for a person to mark. Nothing is marked by script.
//   node --import tsx packages/core/scripts/vote-eval.ts [--budget 3]

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { BudgetExceeded, budgeted, compilePage, compilerModel, modelApi, VIEWPORT, type SpendLedger, type UsherMap } from '../src/index.ts';
import { loadDotEnv } from '../src/compile/env.ts';

const { values } = parseArgs({ options: { budget: { type: 'string', default: '3' }, review: { type: 'string', default: 'reports/accuracy-review-2026-10-27.csv' } } });
loadDotEnv();
const root = new URL('../../../', import.meta.url);

function csvRow(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted && c === '"' && line[i + 1] === '"') (cell += '"'), i++;
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) out.push(cell), (cell = '');
    else cell += c;
  }
  return [...out, cell];
}

interface Marked { form: string; label: string; control: string; key: string; risk: string; key_correct: string; risk_correct: string }
const [header, ...lines] = (await readFile(new URL(values.review!, root), 'utf8')).trim().split('\n');
const cols = csvRow(header!);
const marked = lines.map((l) => Object.fromEntries(csvRow(l).map((v, i) => [cols[i], v])) as unknown as Marked & { category: string }).filter((r) => r.category !== 'mock site' && ['y', 'n'].includes(r.key_correct));
const forms = (JSON.parse(await readFile(new URL('evals/forms.json', root), 'utf8')) as { forms: { id: string; url: string }[] }).forms.filter((f) => marked.some((m) => m.form === f.id));

let spent = 0;
const ledger: SpendLedger = { spent: async () => spent, add: async (_d, usd) => void (spent += usd) };
const chat = budgeted(modelApi(), Number(values.budget), ledger);
const browser = await chromium.launch();
type Outcome = { form: string; single?: UsherMap; voted?: UsherMap; error?: string; runs?: number };
const outcomes: Outcome[] = [];
for (const form of forms) {
  const out: Outcome = { form: form.id };
  for (const mode of ['single', 'voted'] as const) {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    try {
      await page.goto(form.url, { waitUntil: 'load', timeout: 30_000 });
      const result = await compilePage(page, { chat, model: compilerModel(), ...(mode === 'voted' && { vote: true }) });
      out[mode] = result.map;
      if (mode === 'voted') out.runs = result.votes?.runs ?? 1;
    } catch (err) {
      out.error = err instanceof BudgetExceeded ? `budget of $${values.budget} reached` : err instanceof Error ? err.message.split('\n')[0]! : String(err);
    } finally {
      await context.close();
    }
  }
  outcomes.push(out);
  console.log(`${form.id}: ${out.error ?? `single ${out.single ? 'ok' : '-'}, voted ${out.voted ? `ok (${out.runs} runs)` : '-'}`}`);
}
await browser.close();

// Score each mode against the marks.
type Tally = { matched: number; keyRight: number; riskRight: number; keyRegressed: number; keyToMark: number; riskRegressed: number; riskToMark: number };
const tally = (): Tally => ({ matched: 0, keyRight: 0, riskRight: 0, keyRegressed: 0, keyToMark: 0, riskRegressed: 0, riskToMark: 0 });
const scores = { single: tally(), voted: tally() };
const toMark: string[] = [];
for (const m of marked) {
  const o = outcomes.find((x) => x.form === m.form);
  for (const mode of ['single', 'voted'] as const) {
    const map = o?.[mode];
    const el = map && [...map.fields, ...map.actions].find((e) => e.label === m.label && ('control' in e ? e.control : 'action') === (m.control === 'link' || m.control === 'submit' || m.control === 'button' ? 'action' : m.control));
    if (!el) continue;
    const t = scores[mode];
    t.matched++;
    if (el.key === m.key) t.keyRight += m.key_correct === 'y' ? 1 : 0;
    else if (m.key_correct === 'y') t.keyRegressed++;
    else {
      t.keyToMark++;
      if (mode === 'voted') toMark.push(`${m.form} "${m.label}": was ${m.key} (marked wrong), now ${el.key}`);
    }
    if (el.risk === m.risk) t.riskRight += m.risk_correct === 'y' ? 1 : 0;
    else if (m.risk_correct === 'y') t.riskRegressed++;
    else t.riskToMark++;
  }
}
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '–');
const row = (name: string, t: Tally) => `| ${name} | ${t.matched} | ${t.keyRight} (${pct(t.keyRight, t.matched)}) | ${t.keyRegressed} | ${t.keyToMark} | ${t.riskRight} (${pct(t.riskRight, t.matched)}) | ${t.riskRegressed} | ${t.riskToMark} |`;
const markedRun = { key: marked.filter((m) => m.key_correct === 'y').length, risk: marked.filter((m) => m.risk_correct === 'y').length };
const report = [
  '# Vote mode against the human marks',
  '',
  `Generated ${new Date().toISOString().slice(0, 10)} by \`packages/core/scripts/vote-eval.ts\`. Marks: \`${values.review}\` (${marked.length} public elements on ${forms.length} forms, every one marked by hand). Live model spend: $${spent.toFixed(4)}.`,
  '',
  `The marked run itself: ${markedRun.key} of ${marked.length} keys right (${pct(markedRun.key, marked.length)}), ${markedRun.risk} risks right (${pct(markedRun.risk, marked.length)}).`,
  '',
  'Each form compiled again today, once with one run and once in vote mode, and each element matched to its marked row by label and control (pages change; unmatched elements are left out). A key or risk equal to the marked one inherits its mark; a changed one where the mark said right counts as a regression; a changed one where the mark said wrong may be a fix, and waits for a person to mark it.',
  '',
  '| Mode | Matched | Keys right | Keys regressed | Keys changed, to mark | Risks right | Risks regressed | Risks changed, to mark |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  row('One run', scores.single),
  row('Vote mode', scores.voted),
  '',
  '## Forms',
  '',
  ...outcomes.map((o) => `- ${o.form}: ${o.error ?? `vote mode ${o.runs} run${o.runs === 1 ? '' : 's'}`}`),
  '',
  '## Changed by vote mode, waiting for a mark',
  '',
  ...(toMark.length ? toMark.map((t) => `- ${t}`) : ['None.']),
  '',
];
await writeFile(new URL('reports/vote-eval.md', root), report.join('\n'));
console.log(report.slice(8, 12).join('\n'));
