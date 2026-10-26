// Agreement between Muse Spark's risk labels and the open-weights classifier (Muse Spark Open):
// on the mock site (Spark's recorded labels, live classifier, recorded for tests) and on five
// public forms (both live). Pages are loaded and read; nothing is ever submitted.
// Run with: node scripts/with-mock-sites.mjs node --import tsx packages/core/scripts/classifier-report.ts

import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { compilePage, compileUrl, compilerModel, modelApi, openModel, type CompileResult } from '../src/index.ts';
import { loadDotEnv } from '../src/compile/env.ts';
import { LAYOUTS, STEPS, openStep } from '../test/helpers.ts';
import { readFixture, recordingChat, replayChat, type RecordedAttempt } from '../test/replay.ts';

loadDotEnv();
const PUBLIC = [
  ['contact', 'https://www.gov.uk/contact/govuk'],
  ['booking', 'https://www.travelodge.co.uk/'],
  ['newsletter sign-up', 'https://www.mozilla.org/en-US/newsletter/'],
  ['search', 'https://en.wikipedia.org/wiki/Special:Search'],
  ['insurer first step', 'https://www.aviva.co.uk/insurance/motor/car-insurance/'],
] as const;

const open = modelApi({ provider: 'baseten' });
const classifierModel = openModel();
const rows: { form: string; url: string; elements: number; agreement: number; flags: string[]; error?: string }[] = [];

function row(form: string, url: string, r: CompileResult) {
  const c = r.classifier;
  if (!c || 'error' in c) return rows.push({ form, url, elements: 0, agreement: 0, flags: [], error: c && 'error' in c ? c.error : 'no classifier' });
  rows.push({ form, url, elements: r.map.fields.length + r.map.actions.length, agreement: c.agreement, flags: c.flags.map((f) => `${f.label} (${f.key}): Spark ${f.labeller}, Open ${f.classifier} → ${f.kept}`) });
}

const browser = await chromium.launch();
for (const layout of LAYOUTS) {
  for (const step of STEPS) {
    const attempts: RecordedAttempt[] = [];
    const fixture = await readFixture(layout, step);
    const { context, page } = await openStep(browser, layout, step);
    const r = await compilePage(page, { chat: replayChat(fixture), model: fixture.model, logDir: null, classifier: { chat: recordingChat(open, attempts), model: classifierModel } });
    await context.close();
    await writeFile(new URL(`../test/fixtures/classify-open/${layout}-${step}.json`, import.meta.url), `${JSON.stringify({ model: classifierModel, recorded_at: new Date().toISOString(), layout, step, attempts }, null, 2)}\n`);
    row(`mock site ${layout.toUpperCase()} ${step}`, `/quote/${step}`, r);
  }
}
for (const [form, url] of PUBLIC) {
  try {
    const r = await compileUrl(url, { browser, chat: modelApi(), model: compilerModel(), classifier: { chat: open, model: classifierModel } });
    row(form, url, r);
  } catch (err) {
    rows.push({ form, url, elements: 0, agreement: 0, flags: [], error: err instanceof Error ? err.message.split('\n')[0]! : String(err) });
  }
}
await browser.close();

const ok = rows.filter((r) => !r.error);
const mock = ok.filter((r) => r.form.startsWith('mock'));
const pub = ok.filter((r) => !r.form.startsWith('mock'));
const overall = (list: typeof rows) => {
  const n = list.reduce((s, r) => s + r.elements, 0);
  return n ? list.reduce((s, r) => s + r.agreement * r.elements, 0) / n : 0;
};
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const lines = [
  '# Risk classifier agreement',
  '',
  `Muse Spark (${compilerModel()}) labels each element's risk; Muse Spark Open (${classifierModel}) classifies it independently. Where they differ, the stricter risk is kept and the element is flagged. Generated ${new Date().toISOString().slice(0, 10)} by \`packages/core/scripts/classifier-report.ts\`. Pages were loaded and read; nothing was submitted.`,
  '',
  `- Mock site, 6 pages: ${pct(overall(mock))} of ${mock.reduce((s, r) => s + r.elements, 0)} elements agree.`,
  `- Public forms: ${pct(overall(pub))} of ${pub.reduce((s, r) => s + r.elements, 0)} elements agree.`,
  '',
  '| Form | Page | Elements | Agreement | Disagreements (kept the stricter) |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.form} | ${r.url} | ${r.error ? '–' : r.elements} | ${r.error ? `failed: ${r.error}` : pct(r.agreement)} | ${r.flags.join('; ') || '–'} |`),
  '',
];
await writeFile(new URL('../../../reports/classifier-agreement.md', import.meta.url), lines.join('\n'));
console.log(lines.join('\n'));
