// Verbatim blocks read from the page: a consent's exact wording and the section of the terms its
// label links to (once, trimmed, with its address); a link inside a label is part of the label,
// not an action in the map; result lines that repeat what the user typed are never echoed back.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { scanScript, type MapField, type Scan } from '@usher/core';
import { TERMS_MAX, consentBlocks, resultFacts } from '../src/blocks.ts';

const FORM = `<!doctype html><html><head><meta charset="utf-8"></head><body><main><form>
<label><input type="checkbox" id="decl" required> I agree to the <a href="/terms#cancellation">terms of cover</a></label>
<button type="submit">Buy</button></form></main></body></html>`;
const long = 'You may cancel within 14 days of the start date and get a full refund, less any claims paid. '.repeat(30);
const TERMS = `<!doctype html><html><head><meta charset="utf-8"></head><body><main><h1>Terms</h1>
<h2 id="cover">What is covered</h2><p>Accidental damage.</p>
<h2 id="cancellation">Cancelling your policy</h2><p>${long}</p>
<h2 id="claims">Making a claim</h2><p>Call us.</p></main></body></html>`;
const RESULT = `<!doctype html><html><head><meta charset="utf-8"></head><body><main><h1>Your policy</h1>
<p>Policy for Sam Taylor at 1 High Street</p><p>£412.50 a year</p><p>Policy number PX-1234</p><p>Cover starts today and is valid until 1 May 2027.</p><p>Thanks for choosing us.</p></main></body></html>`;

let browser: Browser;
let page: Page;
let termsLoads = 0;
before(async () => {
  browser = await chromium.launch();
  const context = await browser.newContext();
  await context.route('http://forms.test/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/terms') termsLoads++;
    return route.fulfill({ contentType: 'text/html', body: path === '/terms' ? TERMS : path === '/result' ? RESULT : FORM });
  });
  page = await context.newPage();
});
after(() => browser.close());

const declaration: MapField = { id: 'e1', key: 'consent.declaration', label: 'I agree to the terms of cover', control: 'checkbox', required: true, risk: 'needs_user', locators: [{ by: 'id', value: 'decl' }] };

test('a consent: its exact wording, and the linked section of the terms, trimmed, with the address, fetched once', async () => {
  await page.goto('http://forms.test/buy');
  const cache = new Map<string, string | null>();
  const blocks = await consentBlocks(page, declaration, cache);
  assert.deepEqual(blocks[0], { kind: 'consent', text: 'I agree to the terms of cover', verbatim: true, source: { key: 'consent.declaration', url: 'http://forms.test/buy' } });
  const terms = blocks[1]!;
  assert.equal(terms.source.url, 'http://forms.test/terms#cancellation');
  assert.ok(terms.verbatim);
  assert.match(terms.text, /^Cancelling your policy\nYou may cancel within 14 days/);
  assert.ok(terms.text.length <= TERMS_MAX + 1, String(terms.text.length));
  assert.ok(!terms.text.includes('Making a claim') && !terms.text.includes('Accidental damage'), 'only that section');
  await consentBlocks(page, declaration, cache);
  assert.equal(termsLoads, 1, 'fetched once');
});

test('a link inside a label is part of the label, not an action in the map', async () => {
  await page.goto('http://forms.test/buy');
  const scan = (await page.evaluate(scanScript())) as Scan;
  const elements = scan.forms[0]!.elements;
  assert.deepEqual(elements.map((e) => `${e.kind}:${e.control}`), ['field:checkbox', 'action:submit']);
});

test('result facts: amounts, references and validity lines, verbatim; lines repeating what the user typed are left out', async () => {
  await page.goto('http://forms.test/result');
  const { title, facts } = await resultFacts(page, ['Sam Taylor', '1 High Street']);
  assert.equal(title, 'Your policy');
  assert.deepEqual(facts.map((f) => f.text), ['£412.50 a year', 'Policy number PX-1234', 'Cover starts today and is valid until 1 May 2027.']);
});
