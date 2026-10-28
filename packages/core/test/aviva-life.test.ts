// A real life insurance quote form: Aviva Direct's first page, captured in Chrome on 28 October
// 2026, structure only (fixtures/real/aviva-life). Rebuilt as markup at its own address, it extracts
// exactly as the real page did; Muse Spark's map of it (replayed from a recording) is schema-valid
// and gives every field its meaning: the split date of birth as one key, smoking as the person's to
// answer, "See your quote" as the consequential submit. Life cover's own questions have no
// vocabulary key yet (custom.*), and smoking here has three answers, not yes or no.

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
  // Life cover's own questions: no vocabulary key for them yet.
  for (const label of ['Your cover', 'Do you want to add critical illness cover?']) assert.match(map.fields.find((f) => f.label === label)?.key ?? '', /^custom\./, label);
  // The hidden marketing preferences behind "Show" are not in the map.
  assert.ok(!map.fields.some((f) => f.control === 'checkbox'));
});

test('smoking has three answers here: "no" alone matches none of them, so the person is asked', () => {
  const smoker = captured.forms[0]!.elements.find((e) => e.name === 'id_smokerStatusRadio_')!;
  assert.equal(matchOption(smoker.options!.items, 'no'), null, 'a non-smoker may have smoked in the past');
  assert.equal(matchOption(smoker.options!.items, "I've never smoked"), '1');
  assert.equal(matchOption(captured.forms[0]!.elements.find((e) => e.name === 'id_quoteLivesRadio')!.options!.items, 'Me'), '1');
});
