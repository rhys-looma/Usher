// Records which form is chosen, by intent, on pages with more than one (needs MODEL_API_KEY when a
// page has several candidates). Run through `npm run fixtures:record:forms`, which starts the mock
// sites. Writes test/fixtures/forms/:
//   - <page>.json for the public pages the compiler used to get wrong: the forms found, by
//     structure only (labels, controls, flags), and what was chosen for the intent;
//   - help.json: Muse Spark's choices on the mock site's help page, for several intents.

import { mkdir, writeFile } from 'node:fs/promises';
import { NoFormError, VIEWPORT, candidateForms, chooseForm, compilerModel, modelApi, scanScript, type Scan } from '../src/index.ts';
import { loadDotEnv } from '../src/compile/env.ts';
import { launch, mockUrl } from '../test/helpers.ts';
import { recordingChat, type RecordedAttempt } from '../test/replay.ts';

loadDotEnv();
const chat = modelApi();
const model = compilerModel();
const dir = new URL('../test/fixtures/forms/', import.meta.url);
await mkdir(dir, { recursive: true });
const browser = await launch();

const PUBLIC = [
  ['ico-contact', 'https://ico.org.uk/global/contact-us/', 'contact.message'],
  ['admiral-car', 'https://www.admiral.com/car-insurance', 'quote.car_insurance'],
  ['churchill-car', 'https://www.churchill.com/car-insurance', 'quote.car_insurance'],
  ['aviva-car', 'https://www.aviva.co.uk/insurance/motor/car-insurance/', 'quote.car_insurance'],
] as const;

const trim = (scan: Scan) =>
  scan.forms.map((f) => ({
    index: f.index,
    pseudo: f.pseudo,
    banner: f.banner,
    search: f.search,
    newsletter: f.newsletter,
    ...(f.domId && { domId: f.domId }),
    ...(f.actionPath && { actionPath: f.actionPath }),
    elements: f.elements.map((e) => ({ kind: e.kind, control: e.control, label: e.label, visible: e.visible })),
  }));

async function scanOf(url: string) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  // Consent widgets often arrive after load.
  await page.waitForTimeout(2500);
  const scan: Scan = await page.evaluate(scanScript());
  return { context, page, scan };
}

for (const [id, url, intent] of PUBLIC) {
  const { context, page, scan } = await scanOf(url);
  const attempts: RecordedAttempt[] = [];
  let chosen: number | null = null;
  let note = '';
  try {
    const result = await chooseForm(scan, { intent, chat: recordingChat(chat, attempts), model, title: await page.title() });
    chosen = result.form.index;
    note = result.choice ? `model: ${result.choice.reason}` : result.error ?? 'one candidate';
  } catch (err) {
    if (!(err instanceof NoFormError)) throw err;
    note = err.message;
  }
  await context.close();
  await writeFile(new URL(`${id}.json`, dir), `${JSON.stringify({ url, intent, recorded_at: new Date().toISOString(), forms: trim(scan), candidates: candidateForms(scan.forms, intent).map((f) => f.index), chosen, note, attempts }, null, 2)}\n`);
  console.log(`${id}: ${scan.forms.length} forms, chosen ${chosen ?? 'none'} (${note})`);
}

const INTENTS = ['contact.message', 'contact.callback', 'search.query', 'newsletter.signup', null] as const;
const choices = [];
const { context, page, scan } = await scanOf(`${mockUrl('a')}/help`);
for (const intent of INTENTS) {
  const attempts: RecordedAttempt[] = [];
  const result = await chooseForm(scan, { intent, chat: recordingChat(chat, attempts), model, title: await page.title() });
  const form = scan.forms[result.form.index]!;
  choices.push({ intent, chosen: form.domId ?? `F${form.index}`, reason: result.choice?.reason ?? result.error ?? 'one candidate', attempts });
  console.log(`help, ${intent ?? 'no intent'}: ${form.domId ?? form.index} (${result.choice?.reason ?? result.error ?? 'one candidate'}) $${(result.choice?.cost_usd ?? 0).toFixed(4)}`);
}
await context.close();
await writeFile(new URL('help.json', dir), `${JSON.stringify({ model, recorded_at: new Date().toISOString(), choices }, null, 2)}\n`);
await browser.close();
