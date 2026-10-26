// Scripts for page.evaluate. Each one inlines the self-contained in-page functions by
// source, so callers need no bundler.

import { extractForms, type ExtractOptions, type Extraction, type ExtractedElement, type ExtractedForm } from './extract.ts';
import { locatorKit, type Locator } from './locators.ts';

export interface ScannedElement extends ExtractedElement {
  locators: Locator[];
}

export interface ScannedForm extends Omit<ExtractedForm, 'elements' | 'nodes'> {
  elements: ScannedElement[];
}

export interface Scan extends Omit<Extraction, 'forms'> {
  forms: ScannedForm[];
}

export interface LocatorCheck {
  /** How many elements each locator resolves to. */
  counts: number[];
  /** Whether every locator resolves to the same element. */
  agree: boolean;
}

// Some TypeScript loaders (tsx with keepNames) wrap named functions in __name(); a no-op
// definition keeps the serialised source runnable in the page.
const PRELUDE = 'const __name = (fn) => fn;';

/** Script that extracts every form on the page and attaches locators to each element. Evaluates to a Scan. */
export function scanScript(options: Omit<ExtractOptions, 'keepNodes'> = {}): string {
  return `(() => {
  ${PRELUDE}
  const extractForms = ${extractForms.toString()};
  const locatorKit = ${locatorKit.toString()};
  const kit = locatorKit();
  const result = extractForms({ ...${JSON.stringify(options)}, keepNodes: true });
  for (const form of result.forms) {
    form.elements.forEach((el, i) => { el.locators = kit.locatorsFor(form.nodes[i], el); });
    delete form.nodes;
  }
  return result;
})()`;
}

/** Script that resolves each element's locators. Evaluates to one LocatorCheck per list. */
export function checkLocatorsScript(lists: Locator[][]): string {
  return `(() => {
  ${PRELUDE}
  const locatorKit = ${locatorKit.toString()};
  const kit = locatorKit();
  return ${JSON.stringify(lists)}.map((locators) => {
    const found = locators.map((loc) => kit.resolve(loc));
    const first = found[0]?.[0];
    return { counts: found.map((f) => f.length), agree: found.every((f) => f.length === 1 && f[0] === first) };
  });
})()`;
}
