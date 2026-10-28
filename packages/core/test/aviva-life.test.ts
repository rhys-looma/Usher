// A real life insurance quote form: Aviva Direct's first page, captured in Chrome on 28 October
// 2026, structure only (fixtures/real/aviva-life), as it loads and in the two states its answers
// open: family protection and mortgage protection, each for two people with critical illness cover
// and a past smoker. Rebuilt as markup at its own address, each extracts exactly as the real page
// did; Muse Spark's map of each (replayed from a recording) is schema-valid and gives every field its
// meaning: the split date of birth as one key, smoking as the person's to answer, "See your quote"
// as the consequential submit, life cover's questions by cover.*, the second person by partner.*.
// Each question that has a heading inside its own fieldset is named by that heading, not the one
// before it. Smoking here has three answers, not yes or no.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import { compilePage, matchOption, scanScript, type Scan } from '../src/index.ts';
import { mapSchemaErrors } from '../src/schemas.ts';
import { replayChat, type LabelFixture } from './replay.ts';
import { openRebuilt, readReal } from './real.ts';

const FILE = 'aviva-life/01-personal-details.json';
const captured = await readReal(FILE);
const recorded = { ...(JSON.parse(await readFile(new URL(`./fixtures/real/${FILE.replace('.json', '.labels.json')}`, import.meta.url), 'utf8')) as LabelFixture), layout: 'a', step: 'aviva-life' } as unknown as LabelFixture;

let browser: Browser;
before(async () => (browser = await chromium.launch()));
after(() => browser.close());

test('the capture holds structure only: no values, no personal details', async () => {
  const text = JSON.stringify(captured);
  assert.doesNotMatch(text, /"value":"[^"]*@|"value":"\d{5,}/, 'option values are the site\'s own codes');
  for (const e of captured.forms[0]!.elements) assert.ok(!('value' in e), `${e.id} carries no value`);
});

test('rebuilt at its own address, it extracts exactly as the real page did', async () => {
  const { context, page } = await openRebuilt(browser, captured);
  const scan = (await page.evaluate(scanScript())) as Scan;
  await context.close();
  const shape = (e: { kind: string; control?: string | null; label: string; labelSource: string; visible: boolean; group?: string; part?: string }) => `${e.kind}/${e.control}|${e.label}|${e.labelSource}|${e.visible}|${e.group ?? ''}|${e.part ?? ''}`;
  assert.deepEqual(scan.forms[0]!.elements.map(shape), captured.forms[0]!.elements.map(shape));
});

test('Muse Spark\'s map of it: every field by meaning, smoking the person\'s to answer, "See your quote" the submit', async () => {
  const { context, page } = await openRebuilt(browser, captured);
  const { map } = await compilePage(page, { chat: replayChat(recorded), model: recorded.model, logDir: null, now: () => new Date(recorded.recorded_at) });
  await context.close();
  assert.equal(mapSchemaErrors(map), null);
  assert.deepEqual([map.origin, map.path], ['https://www.direct.aviva.co.uk', '/protection/direct/pagesSq/quoteInputPage.xhtml']);
  const field = (key: string) => map.fields.filter((f) => f.key === key);
  for (const key of ['person.first_name', 'person.last_name', 'contact.email', 'contact.phone', 'address.postcode', 'cover.who']) assert.equal(field(key).length, 1, key);
  assert.deepEqual(field('person.dob').map((f) => f.part), ['day', 'month', 'year'], 'the split date of birth, one key');
  assert.equal(field('person.smoker')[0]?.risk, 'needs_user');
  const submit = map.actions.find((a) => a.key === 'form.submit');
  assert.deepEqual([submit?.label, submit?.risk], ['See your quote', 'consequential']);
  assert.ok(map.actions.some((a) => a.key === 'lookup.address' && a.label === 'Find my address'));
  // Life cover's own questions, each by its own heading.
  assert.deepEqual(['Which cover type would you like?', 'Who would you like to cover?', 'Do you want to add critical illness cover?'].map((label) => map.fields.find((f) => f.label === label)?.key), ['cover.purpose', 'cover.who', 'cover.critical_illness']);
  // The hidden marketing preferences behind "Show" are not in the map.
  assert.ok(!map.fields.some((f) => f.control === 'checkbox'));
});

test('smoking has three answers here: "no" alone matches none of them, so the person is asked', () => {
  const smoker = captured.forms[0]!.elements.find((e) => e.name === 'id_smokerStatusRadio_')!;
  assert.equal(matchOption(smoker.options!.items, 'no'), null, 'a non-smoker may have smoked in the past');
  assert.equal(matchOption(smoker.options!.items, "I've never smoked"), '1');
  assert.equal(matchOption(captured.forms[0]!.elements.find((e) => e.name === 'id_quoteLivesRadio')!.options!.items, 'Me'), '1');
});

const STATES = {
  family: { file: 'aviva-life/02-family-joint-ci-ex-smoker.json', only: ['id_sum_assured_family', 'id_quoteCoverAmountRadios', 'id_inflationCoverRadio', 'id_termList'] },
  mortgage: { file: 'aviva-life/03-mortgage-joint-ci-ex-smoker.json', only: ['id_sum_assured_mortgage', 'id_mortgage_termList'] },
} as const;
const BOTH = ['id_quoteCoverPolicyRadios', 'id_ci_sum_assured', 'id_CI_quoteCoverAmountRadios', 'id_exsmokerStatusRadio_', 'id_forename_0', 'id_smokerStatusRadio_0', 'id_consent_life2_address', 'id_postcode_screen_10_currentAddress'];

test('the answers open more of the form: each product its own amount and term, a second person, critical illness, a past smoker\'s when', async () => {
  const names = (c: Awaited<ReturnType<typeof readReal>>) => new Set(c.forms[0]!.elements.map((e) => e.name));
  const start = names(captured);
  for (const [state, { file, only }] of Object.entries(STATES)) {
    const opened = names(await readReal(file));
    for (const n of [...only, ...BOTH]) assert.ok(opened.has(n) && !start.has(n), `${state}: ${n} appears with the answers`);
    const other = Object.values(STATES).find((s) => s.file !== file)!;
    for (const n of other.only) assert.ok(!opened.has(n), `${state}: no ${n}`);
  }
});

for (const [state, { file }] of Object.entries(STATES)) {
  test(`${state} protection, two people: rebuilt, it extracts as the real page did; Muse Spark's map of it`, async () => {
    const page0 = await readReal(file);
    const labels = { ...(JSON.parse(await readFile(new URL(`./fixtures/real/${file.replace('.json', '.labels.json')}`, import.meta.url), 'utf8')) as LabelFixture), layout: 'a', step: state } as unknown as LabelFixture;
    const { context, page } = await openRebuilt(browser, page0);
    const scan = (await page.evaluate(scanScript())) as Scan;
    const shape = (e: { kind: string; control?: string | null; label: string; labelSource: string; visible: boolean; group?: string; part?: string }) => `${e.kind}/${e.control}|${e.label}|${e.labelSource}|${e.visible}|${e.group ?? ''}|${e.part ?? ''}`;
    assert.deepEqual(scan.forms[0]!.elements.map(shape), page0.forms[0]!.elements.map(shape));
    const { map } = await compilePage(page, { chat: replayChat(labels), model: labels.model, logDir: null, now: () => new Date(labels.recorded_at) });
    await context.close();
    assert.equal(mapSchemaErrors(map), null);
    const byName = (n: string) => map.fields.find((f) => f.locators.some((l) => l.by === 'name' && l.value === n));
    // The applicant by vocabulary key; their date of birth one key in three parts.
    for (const [name, key] of [['id_forename_', 'person.first_name'], ['id_surname_', 'person.last_name'], ['id_emailAddress_', 'contact.email'], ['id_FF_phoneNumber_', 'contact.phone'], ['id_postcode_screen__currentAddress', 'address.postcode']] as const) assert.equal(byName(name)?.key, key, name);
    assert.deepEqual(map.fields.filter((f) => f.key === 'person.dob').map((f) => f.part), ['day', 'month', 'year']);
    // Smoking and when a past smoker stopped: the person's to answer, for both people.
    for (const n of ['id_smokerStatusRadio_', 'id_exsmokerStatusRadio_', 'id_smokerStatusRadio_0']) assert.equal(byName(n)?.risk, 'needs_user', n);
    // The second person by partner.*, their date of birth one key in three parts.
    for (const [name, key] of [['id_forename_0', 'partner.first_name'], ['id_surname_0', 'partner.last_name'], ['id_emailAddress_0', 'partner.email'], ['id_FF_phoneNumber_0', 'partner.phone'], ['id_smokerStatusRadio_0', 'partner.smoker'], ['id_consent_life2_address', 'partner.address.same'], ['id_postcode_screen_10_currentAddress', 'partner.address.postcode']] as const) assert.equal(byName(name)?.key, key, name);
    assert.deepEqual(map.fields.filter((f) => f.key === 'partner.dob').map((f) => f.part), ['day', 'month', 'year']);
    assert.equal(byName('id_exsmokerStatusRadio_')?.key, 'person.smoker_stopped');
    // Life cover by cover.*, in both products.
    for (const [name, key] of [['id_quoteCoverRadios', 'cover.purpose'], ['id_quoteLivesRadio', 'cover.who'], ['id_quoteCoverPolicyRadios', 'cover.joint'], ['id_ctiticalIllnesRadio', 'cover.critical_illness'], ['id_CI_quoteCoverAmountRadios', 'cover.critical_illness_amount'], [state === 'family' ? 'id_termList' : 'id_mortgage_termList', 'cover.term']] as const) assert.equal(byName(name)?.key, key, name);
    assert.equal(byName('id_quoteLivesRadio')?.label, 'Who would you like to cover?', 'named by the heading inside its fieldset');
    // Both address lookups, and the one way forward.
    assert.deepEqual(map.actions.filter((a) => a.key === 'lookup.address').map((a) => a.label), ['Find my address', 'Find their address']);
    assert.deepEqual(map.actions.filter((a) => a.key === 'form.submit').map((a) => [a.label, a.risk]), [['See your quote', 'consequential']]);
  });
}
