// Structured validation errors (LU-40): read a page's own error signals after a step is rejected
// and map them back to semantic keys, so an agent can fix the values and retry without re-reading
// the page. Runs inside the page and must stay self-contained, like the extractor. Messages are
// the site's text; callers log keys only, since a message can echo what was typed.

import type { LocatorKit, Locator } from './locators.ts';

export interface PageError {
  key: string;
  message: string;
}

export function readValidationErrors(kit: LocatorKit, elements: { key: string; locators: Locator[] }[]): PageError[] {
  const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const nodes = elements.map((e) => {
    for (const loc of e.locators) {
      const found = kit.resolve(loc);
      if (found.length === 1) return found[0]!;
    }
    return null;
  });
  // The map element a page element belongs to: itself, inside it, or around it (a radio group).
  const keyFor = (target: Element | null): string | undefined => {
    if (!target) return undefined;
    const i = nodes.findIndex((n) => n && (n === target || n.contains(target) || target.contains(n)));
    return i >= 0 ? elements[i]!.key : undefined;
  };
  const out = new Map<string, string>();
  const add = (key: string | undefined, message: string) => {
    if (key && message && !out.has(key)) out.set(key, message);
  };

  // 1. A message next to the field, in its row.
  nodes.forEach((node, i) => {
    if (!node) return;
    const row = node.closest('.row, .form-group, .govuk-form-group, .field, fieldset') ?? node.parentElement;
    const message = row?.querySelector('.error-message, .govuk-error-message, .field-error, .invalid-feedback, [data-error]');
    if (message && (node.closest('.has-error, .govuk-form-group--error, .is-invalid') || message.getBoundingClientRect().height > 0)) add(elements[i]!.key, text(message));
  });
  // 2. Controls marked invalid, with the message they point to.
  for (const el of Array.from(document.querySelectorAll('[aria-invalid="true"]'))) {
    const ids = (el.getAttribute('aria-errormessage') || el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    const message = ids.map((id) => text(document.getElementById(id))).filter(Boolean).join(' ');
    add(keyFor(el), message || 'This answer was not accepted.');
  }
  // 3. An error summary: links to the fields.
  for (const a of Array.from(document.querySelectorAll('[role="alert"] a[href^="#"], .error-summary a[href^="#"], .govuk-error-summary a[href^="#"]'))) {
    const id = decodeURIComponent((a.getAttribute('href') ?? '#').slice(1));
    add(keyFor(id ? document.getElementById(id) : null), text(a));
  }
  return [...out].map(([key, message]) => ({ key, message }));
}
