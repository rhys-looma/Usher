// Result views (spec/view.md): built from the walkthrough's own result page, holding where things
// are and never what they say; then read, by code, from another person's result page.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright';
import { compileResultView, readResultView, viewSchemaErrors, type ChatFn } from '../src/index.ts';
import { launch } from './helpers.ts';

let browser: Browser;
before(async () => (browser = await launch()));
after(() => browser.close());

// LV's quick quote results, in its shape: labels ending in a colon, values after them, a link.
const RESULT = (name: string, price: string, ref: string) => `<!doctype html><html><head><title>Quick quote results</title></head><body>
  <nav><a href="/">Home</a><a href="/help">Help</a></nav>
  <aside><p>Your quick quote</p><p>${name}</p></aside>
  <main><h1>Quick quote results</h1>
    <p>Your quick quote below shows you the cost of your life insurance cover.</p>
    <div><p>Life Insurance cover only:</p><p>£250,000</p><a href="/change">Change cover amount</a></div>
    <div><p>You pay each month:</p><p>${price}</p></div>
    <p>Quote reference: ${ref}</p>
    <a href="/docs/policy-summary.pdf">Policy summary</a>
  </main>
  <div id="onetrust-consent-sdk"><a href="/cookies">Cookie policy</a></div>
</body></html>`;

async function open(html: string, path = '/your-quick-quote') {
  const page = await browser.newPage();
  await page.route('https://life.example/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(`https://life.example${path}`);
  return page;
}

test('the walkthrough\'s result page becomes a view: where the price, cover and documents are, never their values', async () => {
  const page = await open(RESULT('Test Person', '£15.67', 'Q-12345'));
  let asked: { candidates: { id: string; kind: string; label: string; text?: string }[] } | undefined;
  const chat: ChatFn = async (request) => {
    asked = JSON.parse(request.messages.find((m) => m.role === 'user')!.content as string);
    const id = (label: string) => asked!.candidates.find((c) => c.label.startsWith(label))!.id;
    const content = JSON.stringify({ title: 'Quick quote results', items: [
      { id: id('You pay each month'), key: 'result.price', label: 'You pay each month' },
      { id: id('Life Insurance cover only'), key: 'result.amount', label: 'Life insurance cover' },
      { id: id('Quote reference'), key: 'result.reference', label: 'Quote reference' },
      { id: id('Policy summary'), key: 'result.document', label: 'Policy summary' },
    ] });
    return { content, usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cached_tokens: 0 }, latency_ms: 1, response: {} };
  };
  const { view } = await compileResultView(page, { chat, model: 'muse-spark-1.3' });
  await page.close();
  assert.equal(viewSchemaErrors(view), null);
  assert.deepEqual(view.items.map((i) => [i.key, i.kind]), [['result.price', 'fact'], ['result.amount', 'fact'], ['result.reference', 'fact'], ['result.document', 'link']]);
  const labels = asked!.candidates.map((c) => c.label);
  assert.ok(!labels.some((l) => /Home|Help|Cookie policy/.test(l)), 'no navigation or cookie links offered to the model');
  const stored = JSON.stringify(view);
  for (const value of ['£15.67', 'Q-12345', 'Test Person', '/docs/policy-summary.pdf']) assert.ok(!stored.includes(value), `the view never holds ${value}`);
  assert.equal(view.items[0]!.anchor, 'You pay each month');

  // Another person's result, read with the view by code: their own figures, and the document link.
  const theirs = await open(RESULT('Sam Example', '£22.10', 'Q-99881'));
  const read = await readResultView(theirs, view);
  await theirs.close();
  assert.deepEqual(read, [
    { key: 'result.price', label: 'You pay each month', kind: 'fact', text: '£22.10' },
    { key: 'result.amount', label: 'Life insurance cover', kind: 'fact', text: '£250,000' },
    { key: 'result.reference', label: 'Quote reference', kind: 'fact', text: 'Quote reference: Q-99881' },
    { key: 'result.document', label: 'Policy summary', kind: 'link', href: 'https://life.example/docs/policy-summary.pdf' },
  ]);
});

test('an item the page no longer shows is left out, never guessed', async () => {
  const view = {
    usher_view: '0.1' as const, origin: 'https://life.example', path: '/your-quick-quote', title: 'Quick quote results',
    items: [{ id: 'r1', key: 'result.price' as const, label: 'You pay each month', kind: 'fact' as const, anchor: 'You pay each year', locators: [{ by: 'css' as const, value: '#gone' }] }],
    provenance: { source: 'walkthrough' as const, created_at: '2026-10-29T12:00:00Z' },
  };
  const page = await open(RESULT('Sam Example', '£22.10', 'Q-1'));
  assert.deepEqual(await readResultView(page, view), []);
  await page.close();
});
