// Values to controls: the option a person's answer means, a date in a field's own form, and the
// parts of a split date. Then a driver page and options written the way quote forms write them: the
// extractor recognises the split date of birth, and the fill's rules match the options and dates.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { safeReason, dateFormatOf, datePart, formatDate, isDateKey, matchOption, preflight, scanScript, type OptionItem, type Scan } from '../src/index.ts';


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

test('a driver page: the split date of birth is recognised, three parts under one group', async () => {
  const page = await browser.newPage();
  await page.setContent(`<form>
<label for="first">First name</label><input id="first" name="FirstName" autocomplete="given-name">
<fieldset><legend>Date of birth</legend>
<input type="text" id="d" name="DayOfBirth" aria-label="Day of birth" placeholder="DD">
<input type="text" id="m" name="MonthOfBirth" aria-label="Month of birth" placeholder="MM">
<input type="text" id="y" name="YearOfBirth" aria-label="Year of birth" placeholder="YYYY"></fieldset>
<label for="pc">Postcode</label><input id="pc" name="Postcode" autocomplete="postal-code">
<label for="lic">Licence number</label><input id="lic" name="LicenceNumber"></form>`);
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

test('quote form options and dates, by the fill\'s rules', () => {
  const mileage = [{ value: 'UpTo8000', label: 'Up to 8,000 miles' }, { value: 'UpTo12000', label: 'Up to 12,000 miles' }];
  assert.equal(matchOption(mileage, '12,000'), 'UpTo12000');
  assert.equal(matchOption(mileage, '8000'), 'UpTo8000');
  const start = { name: 'CoverStartDate', label: 'Cover start date', control: 'text', placeholder: 'DD/MM/YYYY' };
  assert.equal(dateFormatOf(start), 'DD/MM/YYYY');
  assert.equal(formatDate('2026-11-01', dateFormatOf(start)!), '01/11/2026');
  assert.equal(matchOption([{ value: '7', label: '7 years' }, { value: '8', label: '8 years' }], '8 years'), '8');
  assert.equal(matchOption([{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }], 'no'), 'false');
  const excess = [{ value: '250', label: '£250' }, { value: '550', label: '£550' }];
  assert.equal(matchOption(excess, '250'), '250');
  assert.equal(matchOption(excess, '£550'), '550');
});

test('smoking with three answers: "no" alone matches none of them, so the person is asked', () => {
  const smoker = [{ value: '1', label: "I've never smoked" }, { value: '2', label: 'I used to smoke' }, { value: '3', label: 'I smoke now' }];
  assert.equal(matchOption(smoker, 'no'), null, 'a non-smoker may have smoked in the past');
  assert.equal(matchOption(smoker, "I've never smoked"), '1');
});

test('a browser error never carries what was typed into a reason', () => {
  const reason = safeReason(new Error('locator.fill: Error: Malformed value\nCall log:\n  - fill("Sam Taylor")'));
  assert.doesNotMatch(reason, /Sam|locator|Call log/);
  assert.match(reason, /didn't accept one of the answers/);
  assert.equal(safeReason(new Error('No way forward on /x.')), 'No way forward on /x.', 'our own words stay');
});
