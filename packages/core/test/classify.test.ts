import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright';
import { classifyRisks, compilePage, reconcile, type ChatFn, type ExtractedElement } from '../src/index.ts';
import { launch, openStep, type Layout, type Step } from './helpers.ts';
import { readFixture, replayChat, type LabelFixture } from './replay.ts';
import { readFile } from 'node:fs/promises';

const classified = async (layout: Layout, step: Step) =>
  JSON.parse(await readFile(new URL(`./fixtures/classify-open/${layout}-${step}.json`, import.meta.url), 'utf8')) as LabelFixture;

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser.close();
});

test('reconcile: the stricter risk is kept and every disagreement is flagged', () => {
  const labelled = [
    { id: 'e1', key: 'person.dob', label: 'Date of birth', risk: 'safe' as const },
    { id: 'e2', key: 'form.submit', label: 'Get my quote', risk: 'consequential' as const },
    { id: 'e3', key: 'contact.email', label: 'Email', risk: 'safe' as const },
  ];
  const { risks, flags, agreement } = reconcile(labelled, [
    { id: 'e1', risk: 'needs_user', reason: 'personal data' },
    { id: 'e2', risk: 'safe', reason: 'just a button' },
    { id: 'e3', risk: 'safe', reason: 'typing' },
  ]);
  assert.deepEqual(Object.fromEntries(risks), { e1: 'needs_user', e2: 'consequential', e3: 'safe' });
  assert.deepEqual(flags.map((f) => [f.id, f.labeller, f.classifier, f.kept]), [['e1', 'safe', 'needs_user', 'needs_user'], ['e2', 'consequential', 'safe', 'consequential']]);
  assert.equal(agreement, 1 / 3);
});

test('ui.dismiss is authoritative: flagged, never raised above safe', () => {
  const { risks, flags } = reconcile([{ id: 'e1', key: 'ui.dismiss', label: 'Essential cookies only', risk: 'safe' }], [{ id: 'e1', risk: 'needs_user', reason: 'cookie consent' }]);
  assert.equal(risks.get('e1'), 'safe');
  assert.deepEqual(flags.map((f) => [f.classifier, f.kept]), [['needs_user', 'safe']]);
});

const box = { x: 0, y: 0, width: 1, height: 1 };
const els: ExtractedElement[] = [
  { id: 'e1', kind: 'field', tag: 'input', control: 'text', required: true, label: 'Name', labelSource: 'label-for', box, visible: true },
  { id: 'e2', kind: 'action', tag: 'button', control: 'submit', required: false, label: 'Send', labelSource: 'content', box, visible: true },
];
const reply = (content: unknown): ChatFn => async () => ({ content: JSON.stringify(content), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_tokens: 0 }, latency_ms: 1, response: {} });

test('classifier replies must cover every element with a valid risk', async () => {
  const ok = await classifyRisks(reply({ elements: [{ id: 'e1', risk: 'safe', reason: 'r' }, { id: 'e2', risk: 'consequential', reason: 'r' }, { id: 'e2', risk: 'safe', reason: 'dup' }] }), 'm', 'Contact us', els);
  assert.deepEqual(ok.opinions.map((o) => o.risk), ['safe', 'consequential'], 'the first opinion per element counts');
  await assert.rejects(() => classifyRisks(reply({ elements: [{ id: 'e1', risk: 'safe', reason: 'r' }] }), 'm', 'Contact us', els), /no valid risk for e2/);
  await assert.rejects(() => classifyRisks(reply({ elements: [{ id: 'e1', risk: 'low', reason: 'r' }, { id: 'e2', risk: 'safe', reason: 'r' }] }), 'm', 'Contact us', els), /e1/);
});

for (const [layout, step] of [['a', 'driver'], ['b', 'driver'], ['a', 'cover']] as const) {
  test(`compile with the open-weights second opinion: layout ${layout.toUpperCase()} ${step} (recorded)`, async () => {
    const labels = await readFixture(layout, step);
    const opinions = await classified(layout, step);
    const { context, page } = await openStep(browser, layout, step);
    const result = await compilePage(page, { chat: replayChat(labels), model: labels.model, logDir: null, classifier: { chat: replayChat(opinions), model: opinions.model } });
    await context.close();
    const c = result.classifier!;
    assert.ok(!('error' in c));
    for (const flag of c.flags) {
      const el = [...result.map.fields, ...result.map.actions].find((e) => e.id === flag.id)!;
      assert.equal(el.risk, flag.kept, `${flag.key} keeps the stricter risk`);
    }
    if (layout === 'b' && step === 'driver') {
      assert.deepEqual(c.flags.map((f) => [f.key, f.classifier]), [['person.claims.has_any', 'needs_user'], ['person.claims.date', 'needs_user'], ['person.claims.type', 'needs_user']]);
      assert.equal(result.map.fields.find((f) => f.key === 'person.claims.has_any')!.risk, 'needs_user');
    } else {
      assert.deepEqual(c.flags, []);
      assert.equal(c.agreement, 1);
    }
  });
}

test('a failing classifier never fails the compile', async () => {
  const labels = await readFixture('a', 'vehicle');
  const { context, page } = await openStep(browser, 'a', 'vehicle');
  const result = await compilePage(page, {
    chat: replayChat(labels),
    model: labels.model,
    logDir: null,
    classifier: { chat: async () => { throw new Error('Baseten is down'); }, model: 'open' },
  });
  await context.close();
  assert.deepEqual(result.classifier, { model: 'open', error: 'Baseten is down' });
  assert.equal(result.map.actions.find((a) => a.key === 'nav.next')!.risk, 'safe');
});
