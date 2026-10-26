import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright';
import { checkLocatorsScript, scanScript, type LocatorCheck, type Scan } from '../src/index.ts';
import { launch } from './helpers.ts';

// Cases the mock site doesn't cover: every label source, groups, honeypots, hidden inputs,
// typed text area content and controls outside any form.
const html = `<!doctype html><html><body>
<form method="post" action="/contact?session=abc">
  <input type="hidden" name="csrf" value="zqhiddentoken">
  <fieldset><legend>Your details</legend>
    <span id="nm">Full   name</span><input type="text" aria-labelledby="nm" name="n">
    <input type="email" aria-label="Email" name="e" required minlength="5" maxlength="80">
    <input type="tel" placeholder="Mobile number" name="m">
    <p>Company</p><input type="text" name="c">
  </fieldset>
  <label for="msg">Message</label><textarea id="msg" name="msg">zqtextareacontent</textarea>
  <div style="position:absolute;left:-9999px"><label for="hp">Leave this empty</label><input id="hp" name="website"></div>
  <h3>Preferred contact</h3>
  <label><input type="radio" name="pref" value="email"> By email</label>
  <label><input type="radio" name="pref" value="phone" required> By phone</label>
  <label>Colour <select name="colour"><option value="">Choose</option><option value="red">Red</option></select></label>
  <label><input type="checkbox" name="agree" required> I agree</label>
  <input type="submit" value="Send message">
  <a href="/help">Need help?</a>
</form>
<a href="/elsewhere">Elsewhere</a>
<label for="q">Search the site</label><input id="q" type="search" name="q">
<button type="button">Go</button>
</body></html>`;

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser.close();
});

test('label sources, groups, honeypots and controls outside forms', async () => {
  const page = await browser.newPage();
  // Served from a made-up origin so the page has a real URL; nothing leaves the browser.
  await page.route('http://usher.test/**', (route) => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto('http://usher.test/contact');
  await page.locator('textarea').fill('zqtypedmessage');
  const result: Scan = await page.evaluate(scanScript());
  const checks: LocatorCheck[] = await page.evaluate(checkLocatorsScript(result.forms.flatMap((f) => f.elements.map((e) => e.locators))));
  await page.close();

  assert.equal(result.forms.length, 2);
  const [form, loose] = result.forms as [Scan['forms'][0], Scan['forms'][0]];
  assert.equal(form.actionPath, '/contact');
  assert.deepEqual(form.groups, [{ id: 'g1', label: 'Your details' }]);
  assert.deepEqual(
    form.elements.map((e) => [e.id, e.control, e.label, e.labelSource, e.group ?? null, e.visible]),
    [
      ['e1', 'text', 'Full name', 'aria-labelledby', 'g1', true],
      ['e2', 'email', 'Email', 'aria-label', 'g1', true],
      ['e3', 'tel', 'Mobile number', 'placeholder', 'g1', true],
      ['e4', 'text', 'Company', 'text', 'g1', true],
      ['e5', 'textarea', 'Message', 'label-for', null, true],
      ['e6', 'text', 'Leave this empty', 'label-for', null, false],
      ['e7', 'radio', 'Preferred contact', 'heading', null, true],
      ['e8', 'select', 'Colour', 'label-wrap', null, true],
      ['e9', 'checkbox', 'I agree', 'label-wrap', null, true],
      ['e10', 'submit', 'Send message', 'content', null, true],
      ['e11', 'link', 'Need help?', 'content', null, true],
    ],
  );
  const pref = form.elements[6]!;
  assert.equal(pref.required, true);
  assert.equal(pref.tag, 'input');
  assert.deepEqual(pref.options!.items, [
    { value: 'email', label: 'By email' },
    { value: 'phone', label: 'By phone' },
  ]);
  assert.deepEqual(form.elements[7]!.options, { items: [{ value: 'red', label: 'Red' }], total: 1, truncated: false });
  assert.deepEqual(form.elements[1]!.constraints, { min_length: 5, max_length: 80 });

  assert.equal(loose.pseudo, true);
  assert.deepEqual(
    loose.elements.map((e) => [e.control, e.label]),
    [
      ['text', 'Search the site'],
      ['button', 'Go'],
    ],
  );

  const json = JSON.stringify(result);
  for (const secret of ['zqhiddentoken', 'zqtextareacontent', 'zqtypedmessage']) assert.ok(!json.includes(secret), secret);
  for (const c of checks) assert.ok(c.agree && c.counts.every((n) => n === 1), JSON.stringify(c));
});

test('cookie banners are marked, and the main form is the one a person came for', async () => {
  const { pickForm } = await import('../src/index.ts');
  const page = await browser.newPage();
  const banner = `<!doctype html><title>t</title>
<div id="onetrust-banner-sdk"><form><label><input type="checkbox" name="a"> Analytics</label><label><input type="checkbox" name="m"> Marketing</label><label><input type="checkbox" name="p"> Personalisation</label><button>Essential cookies only</button></form></div>
<form id="reg"><label for="r">Car registration</label><input id="r" name="r"><button>Find my car</button></form>`;
  await page.route('http://usher.test/**', (route) => route.fulfill({ body: banner, contentType: 'text/html' }));
  await page.goto('http://usher.test/quote');
  const result: Scan = await page.evaluate(scanScript());
  await page.close();
  assert.deepEqual(result.forms.map((f) => f.banner), [true, false]);
  assert.equal(pickForm(result).elements[0]!.label, 'Car registration', 'not the banner, though it has more fields');

  // Loose controls outside any form (where many banners put their toggles) come after a real form.
  const loose = await browser.newPage();
  await loose.route('http://usher.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>t</title><div><label><input type="checkbox" name="a"> Analytics</label><label><input type="checkbox" name="b"> Ads</label></div><form><label for="r">Car registration</label><input id="r" name="r"><button>Find</button></form>` }),
  );
  await loose.goto('http://usher.test/quote');
  const looseScan: Scan = await loose.evaluate(scanScript());
  await loose.close();
  assert.equal(pickForm(looseScan).pseudo, false);
});
