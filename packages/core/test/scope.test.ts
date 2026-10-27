// What a map leaves out: controls that browse or filter what a page shows rather than fill or
// submit its form. Listed results, tabs and carousel controls; pagination and the form's own
// buttons stay.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright';
import type { Scan } from '../src/index.ts';
import { scanScript } from '../src/index.ts';
import { launch } from './helpers.ts';

let browser: Browser;
before(async () => (browser = await launch()));
after(() => browser.close());

async function labelsOf(body: string): Promise<string[][]> {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
  const scan = (await page.evaluate(scanScript())) as Scan;
  await page.close();
  return scan.forms.map((f) => f.elements.map((e) => e.label));
}

test('search results listed in the form are not part of it; pagination and its own buttons are', async () => {
  // Five results; the first has two sub-links of its own, as GOV.UK's do.
  const results = Array.from({ length: 5 }, (_, i) => `<li><a href="/result-${i}">Result ${i}</a><p>About result ${i}</p>${i === 0 ? '<ul><li><a href="/sub-1">Sign in</a></li><li><a href="/sub-2">Get help</a></li></ul>' : ''}</li>`).join('');
  const forms = await labelsOf(`<form action="/search">
    <label>Search <input name="q"></label><button type="submit">Search</button>
    <button type="button">Filter and sort</button>
    <ul>${results}</ul>
    <nav><a href="/search?page=2">Next page</a></nav>
  </form>`);
  assert.deepEqual(forms, [['Search', 'Search', 'Filter and sort', 'Next page']]);
});

test('a short list of links (two) is still part of the form', async () => {
  const forms = await labelsOf(`<form><label>Email <input type="email" name="e"></label><ul><li><a href="/terms">Terms</a></li><li><a href="/privacy">Privacy</a></li></ul><button>Sign up</button></form>`);
  assert.deepEqual(forms, [['Email', 'Terms', 'Privacy', 'Sign up']]);
});

test('tabs and carousel controls are not form controls', async () => {
  const forms = await labelsOf(`<main>
    <label>Search events <input name="q"></label><button type="submit" aria-label="Search">Go</button>
    <div role="tablist"><button role="tab" aria-selected="true">All</button><button role="tab">Today</button><button role="tab">This weekend</button></div>
    <button aria-label="Scroll carousel left">‹</button><button aria-label="Scroll carousel right">›</button>
  </main>`);
  assert.deepEqual(forms, [['Search events', 'Search']]);
});
