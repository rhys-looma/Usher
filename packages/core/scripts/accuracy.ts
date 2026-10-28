// Accuracy evaluation (LU-50): compiles maps for the mock site and a list of public forms and writes
// reports/accuracy.md (per form: elements, keys, risk, locator resolution), reports/accuracy.json,
// and reports/accuracy-review.csv, where a person marks each public-form element correct or not
// (human-checked). Marks already in the CSV are kept for elements that come out the same.
// `npm run accuracy:score` recomputes the numbers from the marks.
//
//   node scripts/with-mock-sites.mjs node --import tsx packages/core/scripts/accuracy.ts [--forms recorded|all|id,id] [--live] [--budget 0.5] [--classify]
//
// Model responses come from recorded fixtures and the compiler log first; with --live, misses call
// the models within --budget (USD). Every live compile is logged (data/compiler-log). Pages are
// loaded and read; nothing is submitted. Pages that refuse a headless browser are skipped and noted.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';
import {
  BudgetExceeded,
  CompileError,
  VIEWPORT,
  budgeted,
  checkLocatorsScript,
  compilePage,
  compilerModel,
  modelApi,
  openModel,
  type ChatFn,
  type CompileResult,
  type LocatorCheck,
  type RiskFlag,
  type SpendLedger,
  type UsherMap,
} from '../src/index.ts';
import { loadDotEnv } from '../src/compile/env.ts';
import { LAYOUTS, STEPS, openStep } from '../test/helpers.ts';
import { readFixture, replayChat, replayFromLog } from '../test/replay.ts';

const { values } = parseArgs({
  options: {
    forms: { type: 'string', default: 'recorded' },
    live: { type: 'boolean', default: false },
    budget: { type: 'string', default: '0.5' },
    classify: { type: 'boolean', default: false },
    mock: { type: 'boolean', default: true },
    // The eval labels in vote mode; --single for one run, as the CLI does.
    single: { type: 'boolean', default: false },
  },
});
loadDotEnv();

interface FormEntry {
  id: string;
  category: string;
  url: string;
  recorded?: boolean;
  note?: string;
}
interface Row {
  form: string;
  category: string;
  element: string;
  label: string;
  control: string;
  key: string;
  risk: string;
  flags: string;
  locator_ok: boolean;
  key_correct: string;
  risk_correct: string;
}
interface FormResult {
  id: string;
  category: string;
  url: string;
  status: 'ok' | 'skipped';
  reason?: string;
  source?: string;
  purpose?: string;
  elements?: number;
  vocabulary_keys?: number;
  custom_keys?: number;
  risk?: Record<string, number>;
  locators_resolved?: number;
  flags?: number;
  cost_usd?: number;
}

const root = new URL('../../../', import.meta.url);
const list = JSON.parse(await readFile(new URL('evals/forms.json', root), 'utf8')) as { forms: FormEntry[] };
const wanted = values.forms === 'all' ? list.forms : values.forms === 'recorded' ? list.forms.filter((f) => f.recorded) : list.forms.filter((f) => values.forms.split(',').includes(f.id));

let spent = 0;
const ledger: SpendLedger = { spent: async () => spent, add: async (_, usd) => void (spent += usd) };
const budget = Number(values.budget);
const fromLog = await replayFromLog(new URL('data/compiler-log/', root));
const live = values.live && process.env.MODEL_API_KEY ? budgeted(modelApi(), budget, ledger) : null;
const liveOpen = values.live && values.classify && process.env.BASETEN_API_KEY ? budgeted(modelApi({ provider: 'baseten' }), budget, ledger) : null;

/** Recorded first; live only on a miss, and only with --live. Notes which it was. */
function layered(recorded: ChatFn[], fallback: ChatFn | null, used: { source: string }): ChatFn {
  return async (request) => {
    for (const chat of recorded) {
      try {
        const r = await chat(request);
        used.source = 'recorded';
        return r;
      } catch {
        // not recorded; try the next
      }
    }
    if (!fallback) throw new Error('no recorded response (run with --live to compile it)');
    used.source = 'live';
    return fallback(request);
  };
}

async function locatorsResolve(page: Page, map: UsherMap): Promise<boolean[]> {
  const elements = [...map.fields, ...map.actions];
  const checks: LocatorCheck[] = await page.evaluate(checkLocatorsScript(elements.map((e) => e.locators)));
  return checks.map((c) => c.agree && c.counts.every((n) => n === 1));
}

function summarise(form: { id: string; category: string; url: string }, result: CompileResult, resolved: boolean[], source: string, rows: Row[], marks?: (key: string, label: string, risk: string) => [string, string]): FormResult {
  const { map } = result;
  const elements = [...map.fields, ...map.actions];
  const flags: RiskFlag[] = result.classifier && !('error' in result.classifier) ? result.classifier.flags : [];
  elements.forEach((e, i) => {
    const flag = flags.find((f) => f.id === e.id);
    const [key_correct, risk_correct] = marks?.(e.key, e.label, e.risk) ?? ['', ''];
    rows.push({
      form: form.id,
      category: form.category,
      element: e.id,
      label: e.label,
      control: 'control' in e ? e.control : e.kind,
      key: e.key,
      risk: e.risk,
      flags: flag ? `classifier said ${flag.classifier}; kept ${flag.kept}` : '',
      locator_ok: resolved[i] ?? false,
      key_correct,
      risk_correct,
    });
  });
  const risk: Record<string, number> = {};
  for (const e of elements) risk[e.risk] = (risk[e.risk] ?? 0) + 1;
  return {
    ...form,
    status: 'ok',
    source,
    purpose: map.form.purpose,
    elements: elements.length,
    vocabulary_keys: elements.filter((e) => !e.key.startsWith('custom.')).length,
    custom_keys: elements.filter((e) => e.key.startsWith('custom.')).length,
    risk,
    locators_resolved: resolved.filter(Boolean).length,
    flags: flags.length,
    cost_usd: result.cost_usd ?? 0,
  };
}

const results: FormResult[] = [];
const rows: Row[] = [];
const browser: Browser = await chromium.launch();

// The mock site: recorded labels and classifier opinions, marked automatically by whether they match the mock site's answer key.
if (values.mock && process.env.USHER_MOCK_A) {
  const expected = JSON.parse(await readFile(new URL('packages/core/test/fixtures/expected-keys.json', root), 'utf8')) as Record<string, Record<string, [string, string][]>>;
  const expectedRisk = (key: string) => (['consent.declaration', 'consent.marketing'].includes(key) ? 'needs_user' : key === 'form.submit' ? 'consequential' : 'safe');
  for (const layout of LAYOUTS) {
    for (const step of STEPS) {
      const { context, page } = await openStep(browser, layout, step);
      const labels = await readFixture(layout, step);
      const opinions = JSON.parse(await readFile(new URL(`packages/core/test/fixtures/classify-open/${layout}-${step}.json`, root), 'utf8'));
      const result = await compilePage(page, { chat: replayChat(labels), model: labels.model, logDir: null, classifier: { chat: replayChat(opinions), model: opinions.model } });
      const resolved = await locatorsResolve(page, result.map);
      await context.close();
      const keys = new Map(expected[layout]![step]!.map(([label, key]) => [label, key]));
      results.push(
        summarise({ id: `mock-${layout}-${step}`, category: 'mock site', url: `/quote/${step} (layout ${layout.toUpperCase()})` }, result, resolved, 'recorded', rows, (key, label, risk) => [
          keys.get(label) === key ? 'y' : 'n',
          risk === expectedRisk(key) ? 'y' : 'n',
        ]),
      );
    }
  }
}

for (const form of wanted) {
  const used = { source: 'recorded' };
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    const res = await page.goto(form.url, { waitUntil: 'load', timeout: 30_000 }).catch((e: Error) => {
      throw new Error(`could not load (${e.message.split('\n')[0]})`);
    });
    if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()}${[401, 403, 429, 503].includes(res.status()) ? ' (refuses automated browsers)' : ''}`);
    const result = await compilePage(page, {
      chat: layered([fromLog.chat], live, used),
      model: compilerModel(),
      ...(!values.single && { vote: true }),
      ...(liveOpen && { classifier: { chat: liveOpen, model: openModel() } }),
    });
    results.push(summarise(form, result, await locatorsResolve(page, result.map), used.source, rows));
  } catch (err) {
    const reason = err instanceof BudgetExceeded ? `budget of $${budget} reached` : err instanceof CompileError ? 'labels failed validation twice' : err instanceof Error ? err.message.split('\n')[0]! : String(err);
    results.push({ ...form, status: 'skipped', reason });
  } finally {
    await context.close();
  }
}
await browser.close();

// Reports. Pages the run couldn't load (an HTTP error, a refusal, a timeout) say nothing about
// Usher and are left out of the report; pages that loaded but had no form to map stay in.
await mkdir(new URL('reports/', root), { recursive: true });
const unreachable = (r: (typeof results)[number]) => r.status === 'skipped' && /^(HTTP \d|could not load)/.test(r.reason ?? '');
const reported = results.filter((r) => !unreachable(r));
const ok = results.filter((r) => r.status === 'ok');
const total = (k: 'elements' | 'locators_resolved' | 'vocabulary_keys') => ok.reduce((s, r) => s + (r[k] ?? 0), 0);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '–');
const mockRows = rows.filter((r) => r.category === 'mock site');
const md = [
  '# Accuracy',
  '',
  `Generated ${new Date().toISOString().slice(0, 10)} by \`packages/core/scripts/accuracy.ts\` (forms: ${values.forms}${values.live ? `, live within $${budget}` : ', recorded responses only'}).`,
  '',
  '## Method',
  '',
  '- Each page is loaded in headless Chromium at 1280px and its main form compiled exactly as the registry does: extraction, locators, fingerprint, Muse Spark labels, validation, merge. Nothing is submitted.',
  '- Model responses come from recorded fixtures (mock site) or the compiler log (public forms compiled before); a page that changed since then has no recorded response and is skipped unless the run is `--live`.',
  '- **Locators resolve**: every locator of the element finds exactly one element, and they all agree, on the live page.',
  '- **Keys** and **risk** on the mock site are marked automatically: whether each matches the mock site\'s answer key (`packages/core/test/fixtures/expected-keys.json`). On public forms they are human-checked in `reports/accuracy-review.csv`. `npm run accuracy:score` scores both, separately.',
  '- The open-weights classifier (Muse Spark Open) adds a second opinion on risk where recorded or run live; disagreements keep the stricter risk and are flagged.',
  '- Pages that could not be loaded at all (they refuse automated browsers, or no longer exist) are left out.',
  '',
  '## Summary',
  '',
  `- Forms compiled: ${ok.length} of ${reported.length} (${reported.length - ok.length} skipped: no form to map, or labels that failed validation).`,
  `- Elements: ${total('elements')}; locators resolving: ${pct(total('locators_resolved'), total('elements'))}; vocabulary keys (not custom): ${pct(total('vocabulary_keys'), total('elements'))}.`,
  `- Mock site, matches the mock site's answer key: keys ${pct(mockRows.filter((r) => r.key_correct === 'y').length, mockRows.length)} correct, risk ${pct(mockRows.filter((r) => r.risk_correct === 'y').length, mockRows.length)} correct (after the classifier's stricter-wins).`,
  '',
  '## Per form',
  '',
  '| Form | Category | Source | Elements | Keys (vocabulary / custom) | Risk (safe / consequential / needs user) | Locators resolve | Classifier flags | Notes |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...reported.map((r) =>
    r.status === 'skipped'
      ? `| ${r.id} | ${r.category} | – | – | – | – | – | – | skipped: ${r.reason} |`
      : `| ${r.id} | ${r.category} | ${r.source} | ${r.elements} | ${r.vocabulary_keys} / ${r.custom_keys} | ${r.risk?.safe ?? 0} / ${r.risk?.consequential ?? 0} / ${r.risk?.needs_user ?? 0} | ${pct(r.locators_resolved!, r.elements!)} | ${r.flags} | ${r.purpose} |`,
  ),
  '',
];
await writeFile(new URL('reports/accuracy.md', root), md.join('\n'));
await writeFile(new URL('reports/accuracy.json', root), `${JSON.stringify({ generated: new Date().toISOString(), results }, null, 2)}\n`);
const csv = (v: unknown) => `"${String(v).replaceAll('"', '""')}"`;
// Human marks on public forms survive a re-run when the element comes out the same.
const same = (r: Pick<Row, 'form' | 'label' | 'control' | 'key' | 'risk'>) => [r.form, r.label, r.control, r.key, r.risk].join('\u0000');
const previous = new Map<string, [string, string]>();
for (const line of (await readFile(new URL('reports/accuracy-review.csv', root), 'utf8').catch(() => '')).trim().split('\n').slice(1)) {
  const c = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replaceAll('""', '"'));
  if (c[1] !== 'mock site' && (c[9] || c[10])) previous.set(same({ form: c[0]!, label: c[3]!, control: c[4]!, key: c[5]!, risk: c[6]! }), [c[9]!, c[10]!]);
}
for (const r of rows) if (r.category !== 'mock site') [r.key_correct, r.risk_correct] = previous.get(same(r)) ?? [r.key_correct, r.risk_correct];
await writeFile(
  new URL('reports/accuracy-review.csv', root),
  [
    'form,category,element,label,control,key,risk,flags,locator_ok,key_correct,risk_correct,notes',
    ...rows.map((r) => [r.form, r.category, r.element, r.label, r.control, r.key, r.risk, r.flags, r.locator_ok ? 'y' : 'n', r.key_correct, r.risk_correct, ''].map(csv).join(',')),
  ].join('\n') + '\n',
);
console.log(md.join('\n'));
console.log(`live spend this run: $${spent.toFixed(4)}`);
