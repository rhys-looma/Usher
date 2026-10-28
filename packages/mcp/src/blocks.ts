// Verbatim blocks: what usher_fill hands back for the user to read word for word. Consent blocks
// carry a consent box's exact wording and the terms its label links to; disclosure blocks the text
// beside a consequential action; fact blocks the amounts, references and validity lines on the
// result page. Read from the page as it is shown, never from what was typed: inputs' values are
// never read, and result lines that repeat a value the user supplied are left out.

import { createHash } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';
import type { MapAction, MapField } from '@usher/core';
import { locate } from '../../agent/src/index.ts';

export interface Block {
  kind: 'consent' | 'disclosure' | 'fact' | 'question';
  text: string;
  verbatim: boolean;
  source: { key?: string; url?: string };
}

/** How much of a linked terms page a consent block carries. */
export const TERMS_MAX = 1500;

export const blockHash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

const clip = (text: string, max: number) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return `${end > max * 0.6 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(' '))}…`;
};

/**
 * The section of a page that a link points at: the element its fragment names (and, for a heading,
 * what follows it up to the next heading of the same level or higher), else the main content.
 * Opened once per address in the run's own browser context, so the same request checks apply.
 */
export async function termsSection(context: BrowserContext, url: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(url)) return cache.get(url)!;
  const tab = await context.newPage();
  let text: string | null = null;
  try {
    await tab.goto(url, { waitUntil: 'load', timeout: 10_000 });
    // No named helpers inside: the function is serialised into the page as it is.
    const raw = await tab.evaluate(() => {
      const id = decodeURIComponent(location.hash.slice(1));
      const target = id ? document.getElementById(id) : null;
      if (target && /^H[1-6]$/.test(target.tagName)) {
        const level = Number(target.tagName[1]);
        const parts = [(target as HTMLElement).innerText];
        for (let n = target.nextElementSibling; n; n = n.nextElementSibling) {
          if (/^H[1-6]$/.test(n.tagName) && Number(n.tagName[1]) <= level) break;
          parts.push((n as HTMLElement).innerText);
        }
        return parts.join('\n');
      }
      return ((target ?? document.querySelector('main') ?? document.body) as HTMLElement).innerText;
    });
    text = raw.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  } catch {
    text = null;
  } finally {
    await tab.close().catch(() => undefined);
  }
  const clipped = text ? clip(text, TERMS_MAX) : null;
  cache.set(url, clipped);
  return clipped;
}

/** A consent's exact wording, and the terms its label links to (each with its address). */
export async function consentBlocks(page: Page, field: MapField, cache: Map<string, string | null>): Promise<Block[]> {
  const target = await locate(page, field);
  const found = target
    ? await target
        .evaluate((el) => {
          const label = (el as HTMLInputElement).labels?.[0] ?? el.closest('label');
          if (!label) return null;
          return { text: (label as HTMLElement).innerText.replace(/\s+/g, ' ').trim(), links: Array.from(label.querySelectorAll('a[href]'), (a) => (a as HTMLAnchorElement).href).slice(0, 2) };
        })
        .catch(() => null)
    : null;
  if (!found?.text) return [{ kind: 'consent', text: field.label, verbatim: false, source: { key: field.key } }];
  const blocks: Block[] = [{ kind: 'consent', text: found.text, verbatim: true, source: { key: field.key, url: page.url() } }];
  for (const href of found.links) {
    const terms = await termsSection(page.context(), href, cache);
    if (terms) blocks.push({ kind: 'consent', text: terms, verbatim: true, source: { key: field.key, url: href } });
  }
  return blocks;
}

/** Text beside a consequential action: what the page says right before (or around) the button. */
export async function disclosureBlock(page: Page, action: MapAction): Promise<Block | null> {
  const target = await locate(page, action);
  if (!target) return null;
  // No named helpers inside: the function is serialised into the page as it is. Plain text blocks
  // only (no controls, headings or labels) that a person can see (not Usher's own note for agents,
  // nor anything visually hidden): up to two levels up from the button, its container's own text
  // and the text blocks just before and after it.
  const parts = await target
    .evaluate((el) => {
      const skip = 'input, select, textarea, button, a[href], [role="button"], [role="link"], h1, h2, h3, h4, h5, h6, fieldset, legend, label, [data-usher-note], [hidden]';
      const found: string[] = [];
      let box: Element = el;
      for (let i = 0; i < 2 && box.parentElement && !box.parentElement.matches('form, body'); i++) box = box.parentElement;
      for (let n = box.previousElementSibling, k = 0; n && k < 2 && !n.matches(skip) && !n.querySelector(skip); n = n.previousElementSibling, k++) {
        if ((n as HTMLElement).offsetWidth > 1 && (n as HTMLElement).offsetHeight > 1) found.unshift((n as HTMLElement).innerText);
      }
      for (const child of Array.from(box.children)) if (!child.matches(skip) && !child.querySelector(skip) && (child as HTMLElement).offsetWidth > 1 && (child as HTMLElement).offsetHeight > 1) found.push((child as HTMLElement).innerText);
      const after = box.nextElementSibling;
      if (after && !after.matches(skip) && !after.querySelector(skip) && (after as HTMLElement).offsetWidth > 1 && (after as HTMLElement).offsetHeight > 1) found.push((after as HTMLElement).innerText);
      return found.filter((t, i, all) => all.indexOf(t) === i);
    })
    .catch(() => [] as string[]);
  const text = parts.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  return text ? { kind: 'disclosure', text: clip(text, 600), verbatim: true, source: { key: action.key, url: page.url() } } : null;
}

/** The result page: its title, and amounts, references and validity lines as verbatim facts. */
export async function resultFacts(page: Page, supplied: string[]): Promise<{ title: string; facts: Block[] }> {
  const { title, lines } = await page.evaluate(() => {
    const scope = (document.querySelector('main') ?? document.body) as HTMLElement;
    const blocks = Array.from(scope.querySelectorAll('h2, h3, p, li, dt, dd, td, th'))
      .filter((el) => !el.closest('form, nav, header, footer'))
      .filter((el) => !el.querySelector('p, li, dd, td, h2, h3'));
    return {
      title: ((document.querySelector('h1') as HTMLElement | null)?.innerText ?? document.title).trim(),
      lines: blocks.map((el) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length <= 300),
    };
  });
  const amount = /[£$€]\s?\d[\d,]*(?:\.\d{1,2})?/;
  const reference = /\b(?:ref(?:erence)?|quote (?:number|no\.?)|policy (?:number|no\.?)|confirmation (?:number|code))\b/i;
  const validity = /\b(?:valid|expires?|until)\b/i;
  // Lines that repeat what the user supplied are theirs, not the site's: never echoed back.
  const echoes = supplied.map((v) => v.trim().toLowerCase()).filter((v) => v.length >= 3);
  const facts = [...new Set(lines)]
    .filter((l) => amount.test(l) || reference.test(l) || validity.test(l))
    .filter((l) => !echoes.some((v) => l.toLowerCase().includes(v)))
    .map((text): Block => ({ kind: 'fact', text, verbatim: true, source: { url: page.url() } }));
  return { title, facts };
}
