// Questions answered with buttons (LV's life quote: "Your gender", then Male and Female buttons),
// and a date of birth in a little form of its own beside a page whose questions sit outside any
// form. The extractor makes each a field; filling presses the chosen button inside its question.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Browser } from 'playwright';
import { fillField, mapSchemaErrors, scanScript, type MapField, type Scan } from '../src/index.ts';
import { launch } from './helpers.ts';

let browser: Browser;
before(async () => (browser = await launch()));
after(() => browser.close());

// LV's shape, with each button recording that it was pressed (structure only: a data attribute).
const QUOTE = `
  <div><p>Cover amount</p><input type="text" placeholder="amount"></div>
  <div><p>Choose your type of cover</p><div><button type="button">Level</button><button type="button">Decreasing</button></div></div>
  <div><p>Your first name</p><input type="text" placeholder="Your first name"></div>
  <p>Your date of birth</p>
  <form><div><input type="text" placeholder="dd" maxlength="2"> / <input type="text" placeholder="mm" maxlength="2"> / <input type="text" placeholder="yyyy" maxlength="4"></div></form>
  <div><p>Your gender</p><div id="gender"><button type="button">Male</button><button type="button">Female</button></div></div>
  <div><p>Have you smoked in the last 12 months?</p><p>This includes vaping.</p><div id="smoker"><button type="button">Yes</button><button type="button">No</button></div></div>
  <div><button type="button">Back</button><button type="button">Next</button></div>
  <div><button type="button">Red</button><button type="button">Blue</button></div>
  <nav><p>Pick a section</p><div><button type="button">Home</button><button type="button">Help</button></div></nav>
  <button type="button">GET MY QUOTE</button>
  <script>document.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) b.parentElement.dataset.pressed = b.textContent; });</script>`;

async function scan(body: string) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
  const result = (await page.evaluate(scanScript())) as Scan;
  return { page, result };
}

test('buttons that answer a question are one field with the buttons as options; others stay actions', async () => {
  const { page, result } = await scan(QUOTE);
  await page.close();
  assert.equal(result.forms.length, 1, 'the date form is folded into the page');
  const els = result.forms[0]!.elements;
  const choices = els.filter((e) => e.control === 'buttons').map((e) => [e.label, e.options!.items.map((o) => o.label)]);
  assert.deepEqual(choices, [
    ['Choose your type of cover', ['Level', 'Decreasing']],
    ['Your gender', ['Male', 'Female']],
    ['Have you smoked in the last 12 months?', ['Yes', 'No']],
  ], 'the question that asks, not the note after it');
  const actions = els.filter((e) => e.kind === 'action').map((e) => e.label);
  assert.deepEqual(actions, ['Back', 'Next', 'Red', 'Blue', 'Home', 'Help', 'GET MY QUOTE'], 'a way forward is never an answer; buttons with no question, or in nav, stay buttons');
  assert.ok(!actions.some((a) => ['Male', 'Female', 'Yes', 'No', 'Level', 'Decreasing'].includes(a)));
});

test('a date of birth in its own little form joins the page as one dated group', async () => {
  const { page, result } = await scan(QUOTE);
  await page.close();
  const form = result.forms[0]!;
  const parts = form.elements.filter((e) => e.part);
  assert.deepEqual(parts.map((e) => e.part), ['day', 'month', 'year']);
  const group = form.groups.find((g) => g.id === parts[0]!.group);
  assert.equal(group?.label, 'Your date of birth');
  assert.deepEqual(form.elements.filter((e) => e.kind === 'field').map((e) => e.label).slice(0, 6), ['amount', 'Choose your type of cover', 'Your first name', 'dd', 'mm', 'yyyy'], 'in document order');
});

test('filling a button question presses the chosen button inside it, by option, yes/no or case', async () => {
  const { page } = await scan(QUOTE);
  const field = (id: string, key: string, items: string[]): MapField => ({
    id: 'e1', key, label: key, control: 'buttons', required: false, risk: 'safe',
    options: { items: items.map((l) => ({ value: l, label: l })), total: items.length, truncated: false },
    locators: [{ by: 'id', value: id }],
  });
  await fillField(page, field('gender', 'person.gender', ['Male', 'Female']), 'female');
  assert.equal(await page.getAttribute('#gender', 'data-pressed'), 'Female');
  await fillField(page, field('smoker', 'person.smoker', ['Yes', 'No']), false);
  assert.equal(await page.getAttribute('#smoker', 'data-pressed'), 'No');
  await page.close();
});

test('a map field may be a button question, with its options', async () => {
  const base = JSON.parse(await readFile(new URL('./fixtures/real/aviva-life/01-personal-details.map.json', import.meta.url), 'utf8')) as { fields: Record<string, unknown>[] };
  const map = (field: Record<string, unknown>) => ({ ...base, fields: [...base.fields, { id: 'e900', key: 'person.gender', label: 'Your gender', control: 'buttons', required: false, risk: 'safe', locators: [{ by: 'id', value: 'gender' }], ...field }] });
  assert.equal(mapSchemaErrors(map({ options: { items: [{ value: 'Male', label: 'Male' }, { value: 'Female', label: 'Female' }], total: 2, truncated: false } })), null);
  assert.ok(mapSchemaErrors(map({})), 'options are required');
});
