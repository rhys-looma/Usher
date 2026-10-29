// Values to controls: the option a person's answer means, a date in a field's own form, and the
// parts of a split date. Then the real Aviva quote's controls (packages/core/test/fixtures/real/
// aviva-car, structure only), rebuilt from their captured names, ids, labels, autocomplete and
// placeholders: the extractor recognises the split date of birth, and the fill's rules match
// Aviva's options and dates.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import { dateFormatOf, datePart, formatDate, isDateKey, matchOption, preflight, scanScript, type OptionItem, type Scan } from '../src/index.ts';

const real = async (file: string) => JSON.parse(await readFile(new URL(`./fixtures/real/aviva-car/${file}`, import.meta.url), 'utf8'));
type Captured = { name?: string; label: string; control: string; options?: { items: OptionItem[] }; constraints?: { pattern?: string; max_length?: number }; autocomplete?: string; placeholder?: string; domId?: string; group?: string; required: boolean };

test('options: value, label, yes/no, and the one number an option carries', () => {
  const yesNo = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];
  assert.equal(matchOption(yesNo, 'no'), 'false');
  assert.equal(matchOption(yesNo, false), 'false');
  assert.equal(matchOption(yesNo, 'Y'), 'true');
  const excess = [150, 250, 350, 1050].map((n) => ({ value: String(n), label: `£${n}` }));
  assert.equal(matchOption(excess, '£250'), '250');
  assert.equal(matchOption(excess, '1,050'), '1050');
  const years = [{ value: '0', label: 'Less than 1 year' }, { value: '8', label: '8 years' }, { value: '9', label: '9 years or more' }];
  assert.equal(matchOption(years, '8 years'), '8');
  assert.equal(matchOption(years, '8'), '8');
  const made = ['2015', '2016', '2017'].map((y) => ({ value: `y${y}`, label: y }));
  assert.equal(matchOption(made, '2017'), 'y2017', 'a year');
  assert.equal(matchOption(made, '2020'), null);
  assert.equal(matchOption(yesNo, 'maybe'), null);
});

test('dates: YYYY-MM-DD by key, shown in each field\'s own form, or split into parts', () => {
  assert.ok(isDateKey('person.dob') && isDateKey('policy.start_date') && !isDateKey('vehicle.year'));
  assert.equal(dateFormatOf({ label: 'When would you like your cover to start for this vehicle? (DD/MM/YYYY)' }), 'DD/MM/YYYY');
  assert.equal(dateFormatOf({ constraints: { pattern: '\\d{2}\\/\\d{2}\\/\\d{4}' } }), 'DD/MM/YYYY');
  assert.equal(dateFormatOf({ placeholder: 'MM/YYYY' }), 'MM/YYYY');
  assert.equal(formatDate('2026-11-01', 'DD/MM/YYYY'), '01/11/2026');
  assert.equal(formatDate('1996-10-24', 'D.M.YY'), '24.10.96');
  assert.deepEqual(['day', 'month', 'year'].map((p) => datePart('1996-10-04', p as 'day')), ['04', '10', '1996']);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => ({ value: m.slice(0, 3).toUpperCase(), label: m }));
  assert.equal(datePart('1996-10-24', 'month', months), 'OCT');
  assert.equal(datePart('1996-10-04', 'day', [{ value: '4', label: '4' }]), '4');
});

test('preflight: a date by key is YYYY-MM-DD whatever the box\'s own pattern; options by meaning', () => {
  const start = { key: 'policy.start_date', label: 'Cover start (DD/MM/YYYY)', control: 'text', required: true, risk: 'safe', constraints: { pattern: '\\d{2}\\/\\d{2}\\/\\d{4}' } };
  const mileage = { key: 'vehicle.annual_mileage', label: 'Annual mileage', control: 'select', required: true, risk: 'safe', options: { items: [{ value: 'UpTo8000', label: 'Up to 8,000 a year' }, { value: 'UpTo12000', label: 'Up to 12,000 a year' }], total: 2, truncated: false } };
  const ok = preflight([start, mileage], { 'policy.start_date': '2026-11-01', 'vehicle.annual_mileage': '12,000' });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.equal(ok.normalised['vehicle.annual_mileage'], 'UpTo12000');
  const bad = preflight([start], { 'policy.start_date': '31/11/2026' });
  assert.deepEqual(bad.problems.map((p) => p.problem), ['format']);
  // As people write it, read to YYYY-MM-DD.
  assert.equal(preflight([start], { 'policy.start_date': '01/11/2026' }).normalised['policy.start_date'], '2026-11-01');
});

let browser: Browser;
before(async () => (browser = await chromium.launch()));
after(() => browser.close());

/** The captured controls, rebuilt as markup of the same shape (names, ids, labels, autocomplete, placeholders, groups). */
function rebuild(elements: Captured[], groups: { id: string; label: string }[]): string {
  const field = (e: Captured) => {
    const id = e.domId ?? e.name ?? e.label.replace(/\W+/g, '');
    const attrs = `id="${id}" name="${e.name ?? id}"${e.required ? ' required' : ''}${e.autocomplete ? ` autocomplete="${e.autocomplete}"` : ''}${e.placeholder ? ` placeholder="${e.placeholder}"` : ''}${e.constraints?.pattern ? ` pattern="${e.constraints.pattern}"` : ''}${e.constraints?.max_length ? ` maxlength="${e.constraints.max_length}"` : ''}`;
    if (e.control === 'select') return `<label for="${id}">${e.label}</label><select ${attrs}><option value="">Please select</option>${e.options!.items.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}</select>`;
    if (e.control === 'radio') return `<p id="${id}-q">${e.label}</p><ul role="radiogroup" aria-labelledby="${id}-q">${e.options!.items.map((o, i) => `<li><input type="radio" id="${id}-${i}" name="${e.name}" value="${o.value}"><label for="${id}-${i}">${o.label}</label></li>`).join('')}</ul>`;
    // Day, month and year boxes are labelled by aria-label, as on Aviva.
    return /^(Day|Month|Year) of/.test(e.label) ? `<input type="text" aria-label="${e.label}" ${attrs}>` : `<label for="${id}">${e.label}</label><input type="text" ${attrs}>`;
  };
  const grouped = new Map<string, Captured[]>();
  for (const e of elements) grouped.set(e.group ?? `-${e.label}`, [...(grouped.get(e.group ?? `-${e.label}`) ?? []), e]);
  return `<!doctype html><meta charset="utf-8"><form>${[...grouped].map(([g, es]) => (g.startsWith('-') ? es.map(field).join('') : `<fieldset><legend>${groups.find((x) => x.id === g)?.label}</legend>${es.map(field).join('')}</fieldset>`)).join('')}<button type="submit">Continue</button></form>`;
}

test('the real Aviva driver page: the split date of birth is recognised, three parts under one group', async () => {
  const captured = await real('02-driver-details.json');
  const fields = (captured.forms[0].elements as (Captured & { kind: string })[]).filter((e) => e.kind === 'field');
  const page = await browser.newPage();
  await page.setContent(rebuild(fields, captured.forms[0].groups));
  const scan = (await page.evaluate(scanScript())) as Scan;
  const parts = scan.forms[0]!.elements.filter((e) => e.part).map((e) => [e.name, e.part]);
  assert.deepEqual(parts, [['DayOfBirth', 'day'], ['MonthOfBirth', 'month'], ['YearOfBirth', 'year']]);
  const grouped = new Set(scan.forms[0]!.elements.filter((e) => e.part).map((e) => e.group));
  assert.equal(grouped.size, 1, 'one group');
  // Nothing else is taken for a date part: names, the postcode, the licence.
  assert.equal(scan.forms[0]!.elements.filter((e) => e.part).length, 3);
  await page.close();
});

test('a lone year (Brightwater\'s "Year of manufacture") is not a date part', async () => {
  const page = await browser.newPage();
  await page.setContent('<form><fieldset><legend>Your car</legend><label for="y">Year of manufacture</label><input id="y" name="year" type="number"></fieldset></form>');
  const scan = (await page.evaluate(scanScript())) as Scan;
  assert.equal(scan.forms[0]!.elements[0]!.part, undefined);
  await page.close();
});

test('the real Aviva options and dates, by the fill\'s rules', async () => {
  const vehicle = (await real('01-vehicle.json')).forms[0].elements as Captured[];
  const mileage = vehicle.find((e) => e.name === 'AnnualMileage')!;
  assert.equal(matchOption(mileage.options!.items, '12,000'), 'UpTo12000');
  assert.equal(matchOption(mileage.options!.items, '8000'), 'UpTo8000');
  const start = vehicle.find((e) => e.name === 'CoverStartDate')!;
  assert.equal(dateFormatOf(start), 'DD/MM/YYYY');
  assert.equal(formatDate('2026-11-01', dateFormatOf(start)!), '01/11/2026');
  const licence = (await real('02c-driver-details-no-licence.json')).appeared as Captured[];
  assert.equal(matchOption(licence.find((e) => e.name === 'LengthLicenceHeld')!.options!.items, '8 years'), '8');
  assert.equal(matchOption(licence.find((e) => e.name === 'HasConvictions')!.options!.items, 'no'), 'false');
  const excess = (await real('04-quote-details.json')).fields[0].options.map((o: string) => ({ value: o.split('=')[0]!, label: o.split('=')[1]! }));
  assert.equal(matchOption(excess, '250'), '250');
  assert.equal(matchOption(excess, '£550'), '550');
});
