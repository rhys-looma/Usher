import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';
import { checkLocatorsScript, type Locator, type LocatorCheck, type ScannedElement } from '../src/index.ts';
import { LAYOUTS, STEPS, launch, openStep, scan } from './helpers.ts';

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser.close();
});

// An independent count using Playwright's own locator engine, so the check doesn't only
// trust the resolver that produced the locators. A radio group's name matches each radio.
async function playwrightCount(page: Page, el: ScannedElement, loc: Locator): Promise<number> {
  const attr = (a: string, v: string) => page.locator(`[${a}=${JSON.stringify(v)}]`);
  switch (loc.by) {
    case 'id':
      return attr('id', loc.value).count();
    case 'name': {
      const n = await attr('name', loc.value).count();
      return el.control === 'radio' && n === el.options!.total ? 1 : n;
    }
    case 'label':
      return page.getByLabel(loc.value, { exact: true }).count();
    case 'role':
      return page.getByRole(loc.value as Parameters<Page['getByRole']>[0], { name: loc.name!, exact: true, includeHidden: true }).count();
    case 'placeholder':
      return page.getByPlaceholder(loc.value, { exact: true }).count();
    case 'css':
      return page.locator(loc.value).count();
  }
}

for (const layout of LAYOUTS) {
  for (const step of STEPS) {
    test(`layout ${layout.toUpperCase()} ${step}: every locator resolves to exactly one element`, async () => {
      const { context, page } = await openStep(browser, layout, step);
      const elements = (await scan(page)).forms[0]!.elements;
      const checks: LocatorCheck[] = await page.evaluate(checkLocatorsScript(elements.map((e) => e.locators)));

      for (const [i, el] of elements.entries()) {
        assert.ok(el.locators.length > 0, `${el.label} has locators`);
        assert.deepEqual(checks[i]!.counts, el.locators.map(() => 1), `${el.label}: ${JSON.stringify(el.locators)}`);
        assert.ok(checks[i]!.agree, `${el.label}: locators point at different elements`);
        for (const loc of el.locators) {
          assert.equal(await playwrightCount(page, el, loc), 1, `${el.label}: Playwright count for ${JSON.stringify(loc)}`);
        }
      }
      await context.close();
    });
  }
}

for (const step of STEPS) {
  test(`layout B ${step}: every element has a locator that doesn't rely on ids`, async () => {
    const { context, page } = await openStep(browser, 'b', step);
    const elements = (await scan(page)).forms[0]!.elements;
    await context.close();
    for (const el of elements) {
      const semantic = el.locators.filter((l) => l.by !== 'id' && l.by !== 'css');
      assert.ok(semantic.length > 0, `${el.label}: ${JSON.stringify(el.locators)}`);
      for (const l of el.locators) if (l.by === 'css') assert.ok(!l.value.includes('#'), `${el.label}: css uses an id`);
    }
  });
}

test('labels and roles survive the redesign even though ids and names change', async () => {
  const locs = async (layout: 'a' | 'b') => {
    const { context, page } = await openStep(browser, layout, 'cover');
    const elements = (await scan(page)).forms[0]!.elements;
    await context.close();
    return new Map(elements.map((e) => [e.label, e.locators]));
  };
  const [a, b] = await Promise.all([locs('a'), locs('b')]);
  const keep = (list: Locator[] | undefined) => JSON.stringify(list?.filter((l) => l.by === 'label' || l.by === 'role'));
  for (const label of ['Level of cover', 'Voluntary excess', 'Get my quote']) assert.equal(keep(b.get(label)), keep(a.get(label)), label);
  assert.notEqual(JSON.stringify(a.get('Voluntary excess')![0]), JSON.stringify(b.get('Voluntary excess')![0]));
});
