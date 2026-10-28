// Real pages, captured structure only (fixtures/real/*), rebuilt as markup a browser can load: the
// same names, ids, labels (and where each label came from), groups, autocomplete, constraints and
// visibility, so the extractor and the compiler see what they saw on the real page. Never a value:
// the captures hold none.

import { readFile } from 'node:fs/promises';
import type { OptionItem } from '../src/index.ts';

export interface CapturedElement {
  id: string;
  kind: 'field' | 'action';
  tag: string;
  control: string;
  required: boolean;
  label: string;
  labelSource: string;
  visible: boolean;
  domId?: string;
  name?: string;
  role?: string;
  group?: string;
  autocomplete?: string;
  placeholder?: string;
  constraints?: { pattern?: string; max_length?: number };
  options?: { items: OptionItem[] };
  /** A radio group named by a heading inside its own fieldset (no legend): noted by hand, from the page. */
  headingInside?: boolean;
}
export interface CapturedPage {
  url: string;
  title: string;
  forms: { groups: { id: string; label: string }[]; elements: CapturedElement[]; domId?: string; method?: string }[];
}

export const readReal = async (path: string): Promise<CapturedPage> => JSON.parse(await readFile(new URL(`./fixtures/real/${path}`, import.meta.url), 'utf8'));

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function element(e: CapturedElement, n: number): string {
  const id = e.domId ?? `${e.name ?? 'el'}-${n}`;
  const hide = e.visible ? '' : ' style="display:none"';
  if (e.kind === 'action') {
    const named = e.labelSource === 'aria-label' ? ` aria-label="${esc(e.label)}"` : '';
    const text = esc(e.label) || '&nbsp;';
    if (e.tag === 'a') return `<a href="#${esc(id)}"${e.domId ? ` id="${esc(e.domId)}"` : ''}${e.role === 'button' ? ' role="button"' : ''}${named}${hide}>${text}</a>`;
    return `<button type="${e.control === 'submit' ? 'submit' : 'button'}"${e.domId ? ` id="${esc(e.domId)}"` : ''}${named}${hide}>${text}</button>`;
  }
  const attrs = `${e.domId ? ` id="${esc(e.domId)}"` : ''}${e.name ? ` name="${esc(e.name)}"` : ''}${e.required ? ' required' : ''}${e.autocomplete ? ` autocomplete="${esc(e.autocomplete)}"` : ''}${e.placeholder ? ` placeholder="${esc(e.placeholder)}"` : ''}${e.constraints?.pattern ? ` pattern="${esc(e.constraints.pattern)}"` : ''}${e.constraints?.max_length ? ` maxlength="${e.constraints.max_length}"` : ''}`;
  if (e.control === 'radio') {
    // A heading or a legend names the group, as on the page.
    const head = e.labelSource === 'legend' ? `<legend>${esc(e.label)}</legend>` : e.headingInside ? `<h3>${esc(e.label)}</h3>` : '';
    const before = e.labelSource === 'heading' && !e.headingInside ? `<h3>${esc(e.label)}</h3>` : '';
    return `${before}<fieldset${e.role === 'group' && e.labelSource !== 'legend' ? ' role="group"' : ''}${hide}>${head}${e.options!.items.map((o, i) => `<input type="radio" id="${esc(e.name!)}-${i}" name="${esc(e.name!)}" value="${esc(o.value)}"><label for="${esc(e.name!)}-${i}">${esc(o.label)}</label>`).join('')}</fieldset>`;
  }
  const tag = e.control === 'select' ? 'select' : 'input';
  const type = e.control === 'select' ? '' : ` type="${e.control === 'text' ? 'text' : e.control}"`;
  const control = tag === 'select' ? `<select${attrs}><option value="">Please select</option>${e.options!.items.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>` : `<input${type}${attrs}${e.labelSource === 'aria-label' ? ` aria-label="${esc(e.label)}"` : ''}>`;
  switch (e.labelSource) {
    case 'label-for':
      return `<span${hide}>${control}<label for="${esc(e.domId!)}">${esc(e.label)}</label></span>`;
    case 'text':
      return `<div${hide}><p>${esc(e.label)}</p>${control}</div>`;
    default:
      return `<span${hide}>${control}</span>`;
  }
}

/** The page's form rebuilt: elements in order, each group a fieldset with its legend. */
export function rebuildPage(page: CapturedPage, formIndex = 0): string {
  const form = page.forms[formIndex]!;
  const parts: string[] = [];
  let open: string | undefined;
  form.elements.forEach((e, n) => {
    if (e.group !== open) {
      if (open) parts.push('</fieldset>');
      if (e.group) parts.push(`<fieldset><legend>${esc(form.groups.find((g) => g.id === e.group)?.label ?? '')}</legend>`);
      open = e.group;
    }
    parts.push(element(e, n));
  });
  if (open) parts.push('</fieldset>');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(page.title)}</title></head><body><form${form.domId ? ` id="${esc(form.domId)}"` : ''} method="${form.method ?? 'post'}" action="#">${parts.join('\n')}</form></body></html>`;
}

/**
 * A page showing the rebuild at the captured page's own address: every request is answered here,
 * so nothing reaches the real site, and a map built from it has the real origin and path.
 */
export async function openRebuilt(browser: import('playwright').Browser, captured: CapturedPage) {
  const context = await browser.newContext();
  await context.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: rebuildPage(captured) }));
  const page = await context.newPage();
  await page.goto(captured.url);
  return { context, page };
}
