// Finding a map element on a live page and putting a value in it, shared by the reference agent,
// usher_fill and the walkthrough. The map says what each element means; this code finds it by the
// map's locators (never a selector a model wrote) and fills it the way the control takes values:
// the option a value means, a date in the field's own form or split into its parts, a radio styled
// as a card through its label.

import type { Locator, Page } from 'playwright';
import type { MapAction, MapField } from './map.ts';
import { dateFormatOf, datePart, formatDate, isDateKey, matchOption } from './values.ts';

/** The Playwright locator for a map element: the first of its locators that finds exactly one. */
export async function locate(page: Page, el: MapField | MapAction): Promise<Locator | null> {
  for (const loc of el.locators) {
    const attr = (name: string) => page.locator(`[${name}=${JSON.stringify(loc.value)}]`);
    const candidate =
      loc.by === 'id' ? attr('id') :
      loc.by === 'name' ? attr('name') :
      loc.by === 'label' ? page.getByLabel(loc.value, { exact: true }) :
      loc.by === 'role' ? page.getByRole(loc.value as Parameters<Page['getByRole']>[0], { name: loc.name ?? '', exact: true }) :
      loc.by === 'placeholder' ? page.getByPlaceholder(loc.value, { exact: true }) :
      page.locator(loc.value);
    const count = await candidate.count();
    // A radio group's name matches each of its radios.
    if (count === 1 || (loc.by === 'name' && 'control' in el && el.control === 'radio' && count > 1)) return candidate;
  }
  return null;
}


/** Puts a value in a field by its map entry; true once done. Throws when the page has no such field. */
export async function fillField(page: Page, field: MapField, value: string | boolean): Promise<boolean> {
  const target = await locate(page, field);
  if (!target) throw new Error(`Could not find ${field.key} ("${field.label}") on the page.`);
  const items = field.options?.items;
  // The option a value means (by value, label, yes/no, or its number), else the value as given.
  const option = (v: string | boolean) => (items ? (matchOption(items, v) ?? String(v)) : String(v));
  // Dates are YYYY-MM-DD by key; a split date fills each part, a text date in the field's own form.
  const iso = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  switch (field.control) {
    case 'select':
      await target.selectOption(field.part && iso ? (datePart(iso, field.part, items) ?? option(value)) : option(value));
      return true;
    case 'radio': {
      // The group is found as its container (id, role) or as its radios (name).
      const chosen = `[value=${JSON.stringify(option(value))}]`;
      const isRadio = (await target.first().evaluate((n) => n.tagName)) === 'INPUT';
      const radio = (isRadio ? page.locator(`input[type=radio][name=${JSON.stringify(await target.first().getAttribute('name'))}]${chosen}`) : target.locator(`input[type=radio]${chosen}`)).first();
      // A radio a person can see is checked; one hidden behind its label (a card: transparent,
      // tiny or invisible) is chosen through the label straight away, rather than after check()
      // has waited out its timeout on a click the label intercepts.
      const behindLabel = await radio.evaluate((el) => {
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return style.opacity === '0' || style.visibility === 'hidden' || box.width < 2 || box.height < 2;
      }).catch(() => true);
      if (!behindLabel) await radio.check({ timeout: 3000 }).catch(() => undefined);
      if (!(await radio.isChecked().catch(() => false))) {
        // Radios styled as cards: the input is hidden and the site listens on its label.
        const id = await radio.getAttribute('id');
        const label = id ? page.locator(`label[for=${JSON.stringify(id)}]`) : radio.locator('xpath=ancestor::label');
        if (await label.count()) await label.first().click();
        else await radio.evaluate((el) => (el as HTMLElement).click());
      }
      return true;
    }
    case 'buttons': {
      // A question answered by pressing one of its buttons: only a type="button" button inside the
      // question's own container, whose caption is the option, so the answer can never submit.
      const label = items?.find((o) => o.value === option(value))?.label ?? option(value);
      const button = target.getByRole('button', { name: label, exact: true }).first();
      if ((await button.getAttribute('type'))?.toLowerCase() !== 'button') throw new Error(`"${label}" for ${field.key} is not an answer button.`);
      await button.click();
      return true;
    }
    case 'checkbox':
      if (value === true || (typeof value === 'string' && /^(yes|y|true)$/i.test(value))) await target.check();
      else await target.uncheck();
      return true;
    default:
      if (field.part && iso) await target.fill(datePart(iso, field.part) ?? String(value));
      else if (iso && field.control !== 'date' && (isDateKey(field.key) || field.constraints?.format === 'date')) await target.fill(formatDate(iso, dateFormatOf(field) ?? 'DD/MM/YYYY'));
      else await target.fill(String(value));
      return true;
  }
}
