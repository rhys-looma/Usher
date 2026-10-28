import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Browser, Page } from 'playwright';
import { fingerprint, type Scan, type ScannedElement } from '../src/index.ts';
import { LAYOUTS, STEPS, launch, openStep, scan } from './helpers.ts';
import { expected, hiddenLabels } from './expected.ts';

const exampleMap = JSON.parse(await readFile(new URL('../../../spec/examples/quote-driver.map.json', import.meta.url), 'utf8'));

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser.close();
});

test('step 1 in layout A reproduces the example map fingerprint exactly', async () => {
  const { context, page } = await openStep(browser, 'a', 'driver');
  const result = await scan(page);
  await context.close();
  const fp = await fingerprint(result.forms[0]!.elements);
  assert.deepEqual(fp.signature, exampleMap.fingerprint.signature);
  assert.equal(fp.digest, exampleMap.fingerprint.digest);
});

for (const layout of LAYOUTS) {
  for (const step of STEPS) {
    test(`layout ${layout.toUpperCase()} ${step}: one form, expected elements in order`, async () => {
      const { context, page } = await openStep(browser, layout, step);
      const result = await scan(page);
      await context.close();

      assert.equal(result.forms.length, 1);
      const form = result.forms[0]!;
      assert.equal(form.pseudo, false);
      assert.equal(form.method, 'post');
      assert.equal(form.actionPath, `/quote/${step}`);
      assert.deepEqual(
        form.elements.map((e) => [e.control, e.label]),
        expected[layout as Exclude<typeof layout, 'c'>][step],
      );
      assert.deepEqual(
        form.elements.map((e) => e.id),
        form.elements.map((_, i) => `e${i + 1}`),
      );
      for (const el of form.elements) {
        assert.equal(el.visible, !hiddenLabels.has(el.label), `${el.label} visible`);
        assert.ok(el.box.width > 0 || !el.visible, `${el.label} has a box`);
        if (el.control === 'select' || el.control === 'radio') assert.ok(el.options && el.options.total > 0, `${el.label} options`);
        if (el.kind === 'action') assert.equal(el.required, false);
      }
    });
  }
}

test('options: first 20 plus total and truncated flag, placeholder option left out', async () => {
  const { context, page } = await openStep(browser, 'a', 'driver');
  const els = (await scan(page)).forms[0]!.elements;
  await context.close();
  const occupation = els.find((e) => e.label === 'Occupation')!;
  assert.equal(occupation.options!.items.length, 20);
  assert.equal(occupation.options!.total, 173);
  assert.equal(occupation.options!.truncated, true);
  assert.deepEqual(occupation.options!.items[0], { value: 'accountant', label: 'Accountant' });
  const title = els.find((e) => e.label === 'Title')!;
  assert.deepEqual(title.options, exampleMap.fields[0].options);
  const status = els.find((e) => e.label === 'Employment status')!;
  assert.deepEqual(status.options, exampleMap.fields[9].options);
  assert.equal(status.tag, 'fieldset');
  assert.equal(status.required, true);
});

test('validation attributes and autocomplete are captured', async () => {
  const { context, page } = await openStep(browser, 'a', 'vehicle');
  const els = (await scan(page)).forms[0]!.elements;
  await context.close();
  const byLabel = (label: string) => els.find((e) => e.label === label)!;
  assert.deepEqual(byLabel('Registration number').constraints, { pattern: '[A-Za-z0-9 ]{2,8}' });
  assert.deepEqual(byLabel('Year of manufacture').constraints, { min: 1960, max: 2027 });

  const driver = await openStep(browser, 'a', 'driver');
  const d = (await scan(driver.page)).forms[0]!.elements;
  await driver.context.close();
  assert.equal(d.find((e) => e.label === 'First name')!.autocomplete, 'given-name');
});

test('conditional claim fields become visible once "yes" is chosen', async () => {
  for (const layout of LAYOUTS) {
    const { context, page } = await openStep(browser, layout, 'driver');
    await page.getByRole('group', { name: 'Have you made any claims in the last 5 years?' }).getByLabel('Yes').check();
    const els = (await scan(page)).forms[0]!.elements;
    await context.close();
    for (const label of hiddenLabels) assert.equal(els.find((e) => e.label === label)!.visible, true, `${layout} ${label}`);
  }
});

// Fills every visible field with distinctive values, choosing the last option of each select
// and radio group (which never reveals the conditional fields).
async function fillEverything(page: Page, elements: ScannedElement[], token: string): Promise<string[]> {
  const typed: string[] = [];
  for (const el of elements) {
    if (el.kind !== 'field' || !el.visible || !el.name) continue;
    const target = page.locator(`[name="${el.name}"]`);
    switch (el.control) {
      case 'select':
        await target.selectOption(el.options!.items.at(-1)!.value);
        break;
      case 'radio':
        await page.locator(`[name="${el.name}"][value="${el.options!.items.at(-1)!.value}"]`).check();
        break;
      case 'checkbox':
        await target.check();
        break;
      case 'date':
        await target.fill('1901-02-03');
        typed.push('1901-02-03');
        break;
      case 'number':
        await target.fill('987654');
        typed.push('987654');
        break;
      case 'email': {
        const v = `${token}${el.id}@example.org`;
        await target.fill(v);
        typed.push(v);
        break;
      }
      default: {
        const v = `${token}${el.id}`;
        await target.fill(v);
        typed.push(v);
      }
    }
  }
  return typed;
}

function assertNoneOf(result: Scan, typed: string[], where: string): void {
  const json = JSON.stringify(result);
  for (const v of typed) assert.ok(!json.includes(v), `${where}: output contains typed value ${v}`);
}

for (const layout of LAYOUTS) {
  for (const step of STEPS) {
    test(`layout ${layout.toUpperCase()} ${step}: filling the form changes nothing in the output`, async () => {
      const { context, page } = await openStep(browser, layout, step);
      const blank = await scan(page);
      const typed = await fillEverything(page, blank.forms[0]!.elements, 'zqtyped');
      assert.ok(typed.length > 0);
      const filled = await scan(page);
      await context.close();
      assert.deepEqual(filled, blank);
      assertNoneOf(filled, typed, `${layout} ${step}`);
    });
  }
}

test('values echoed back by the server in value attributes are not read', async () => {
  for (const layout of LAYOUTS) {
    const { context, page } = await openStep(browser, layout, 'driver');
    const els = (await scan(page)).forms[0]!.elements;
    const typed = await fillEverything(
      page,
      els.filter((e) => e.control !== 'select'),
      'zqechoed',
    );
    // Title is left unselected, so the server re-renders the step with the other answers filled in.
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST'),
      page.getByRole('button', { name: layout === 'a' ? 'Continue' : 'Next' }).click(),
    ]);
    assert.equal(response.status(), 422);
    await page.waitForLoadState();
    const html = await page.content();
    assert.ok(html.includes(`value="${typed[0]}"`), 'server echoed the typed values');
    const result = await scan(page);
    await context.close();
    assertNoneOf(result, typed, `${layout} re-rendered driver`);
  }
});
