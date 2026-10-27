import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Browser } from 'playwright';
import { NoFormError, candidateForms, chooseForm, mainForm, scanScript, type Scan } from '../src/index.ts';
import { launch, mockUrl } from './helpers.ts';
import { replayChat, type LabelFixture, type RecordedAttempt } from './replay.ts';

const fixture = async <T>(name: string): Promise<T> => JSON.parse(await readFile(new URL(`./fixtures/forms/${name}.json`, import.meta.url), 'utf8')) as T;

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser.close();
});

interface PublicPage {
  url: string;
  intent: string;
  forms: Scan['forms'];
  candidates: number[];
  chosen: number | null;
}

// Recorded scans (structure only) of the pages that used to get the wrong form: a cookie widget or
// a site search was mapped instead of the form, or instead of nothing.
for (const [id, expected] of [
  ['ico-contact', []],
  ['admiral-car', []],
  ['churchill-car', []],
  ['aviva-car', ['car-reg-form']],
] as const) {
  test(`form choice, recorded page ${id}: never a cookie widget, site search or newsletter box`, async () => {
    const page = await fixture<PublicPage>(id);
    const candidates = candidateForms(page.forms, page.intent);
    assert.deepEqual(candidates.map((f) => f.domId ?? `F${f.index}`), expected);
    assert.deepEqual(candidates.map((f) => f.index), page.candidates, 'the recording agrees');
    assert.ok(candidates.every((f) => !f.banner && !f.search && !f.newsletter));
    if (!expected.length) await assert.rejects(chooseForm({ url: page.url, forms: page.forms }, { intent: page.intent }), NoFormError);
  });
}

test('form choice: an intent that asks for a search, or none at all, still finds the search box', async () => {
  const aviva = await fixture<PublicPage>('aviva-car');
  assert.equal(mainForm(aviva.forms, 'search.query')?.search, false, 'two candidates: the registration form has more to it');
  assert.ok(candidateForms(aviva.forms, 'search.query').some((f) => f.search));
  const ico = await fixture<PublicPage>('ico-contact');
  assert.equal(mainForm(ico.forms)?.domId, 'search-form', 'no intent: a site search is better than nothing');
  assert.equal(mainForm(ico.forms, 'contact.message'), undefined, 'but never for a contact intent');
});

test('form choice on the help page: Muse Spark chooses by intent (recorded)', async () => {
  const recorded = await fixture<{ model: string; choices: { intent: string | null; chosen: string; attempts: RecordedAttempt[] }[] }>('help');
  const page = await browser.newPage();
  await page.goto(`${mockUrl('a')}/help`);
  const scan: Scan = await page.evaluate(scanScript());
  const title = await page.title();
  await page.close();
  assert.deepEqual(
    scan.forms.filter((f) => !f.pseudo).map((f) => [f.domId ?? `F${f.index}`, f.search, f.newsletter]),
    [['F0', true, false], ['callback', false, false], ['message', false, false], ['newsletter', false, true]],
  );
  const expected: Record<string, string> = { 'contact.message': 'message', 'contact.callback': 'callback', 'search.query': 'F0', 'newsletter.signup': 'newsletter', none: 'message' };
  for (const c of recorded.choices) {
    const replay = replayChat({ model: recorded.model, recorded_at: '', layout: 'a', step: 'driver', attempts: c.attempts } as LabelFixture);
    const { form, choice } = await chooseForm(scan, { intent: c.intent, chat: replay, model: recorded.model, title });
    assert.equal(form.domId ?? `F${form.index}`, expected[c.intent ?? 'none'], `intent ${c.intent}`);
    assert.ok(choice && choice.candidates >= 2, 'the model was asked');
  }
  assert.equal(mainForm(scan.forms)?.domId, 'message', 'without a model: the form with the most fields');
});
