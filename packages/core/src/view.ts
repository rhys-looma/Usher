// Result views (spec/view.md): what the page at the end of a journey shows that a person wants to
// keep. The walkthrough builds one from its own test run (resultCandidates in the page, a model
// choosing and naming, code locating); a person's own result is only ever read with one, by code.
// A view holds where things are, never what they say.

import type { Page } from 'playwright';
import { costUsd, parseJsonContent, type ChatFn, type Usage } from './compile/model.ts';
import { viewSchemaErrors } from './schemas.ts';

export const RESULT_KEYS = ['result.reference', 'result.price', 'result.amount', 'result.term', 'result.date', 'result.document', 'result.next_step'] as const;
export type ResultKey = (typeof RESULT_KEYS)[number];

export interface ViewLocator {
  by: 'css' | 'role';
  value: string;
  name?: string;
}

export interface ViewItem {
  id: string;
  key: ResultKey;
  label: string;
  kind: 'fact' | 'link';
  anchor?: string;
  locators: ViewLocator[];
}

export interface ResultView {
  usher_view: '0.1';
  origin: string;
  path: string;
  title: string;
  items: ViewItem[];
  provenance: { source: 'walkthrough' | 'compiler'; model?: string; created_at: string };
}

/** A candidate on a result page, as code finds it: a label and the text after it, or a link. */
export interface ResultCandidate {
  id: string;
  kind: 'fact' | 'link';
  /** The words before the value ("You pay each month:"), or a link's caption. */
  label: string;
  /** The value's text, for the model only (the walkthrough's own test result); never kept. */
  text?: string;
  css: string;
}

/**
 * Runs in the page (self-contained): the label-and-value pairs, amounts and links in the page's
 * main content, outside forms, navigation, headers, footers and cookie banners. At most 60.
 */
export function resultCandidates(): { title: string; candidates: ResultCandidate[] } {
  const SKIP = 'nav, header, footer, form, script, style, noscript, template, [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [id*="onetrust" i]';
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const cssPath = (el: Element): string => {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
      const tag = n.tagName.toLowerCase();
      const same = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.tagName === n!.tagName) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(n) + 1})` : tag);
    }
    return `body > ${parts.join(' > ')}`;
  };
  const scope = document.querySelector('main') ?? document.body;
  // Text blocks in document order: elements with text of their own and no block inside.
  const blocks = Array.from(scope.querySelectorAll('h1, h2, h3, h4, p, li, dt, dd, th, td, span, strong, b, div, label'))
    .filter((el) => !el.closest(SKIP) && visible(el))
    .filter((el) => !el.querySelector('h1, h2, h3, h4, p, li, dt, dd, th, td, div, table, ul, ol'))
    .map((el) => ({ el, text: norm(el.textContent) }))
    .filter((b) => b.text && b.text.length <= 160)
    .filter((b, i, all) => !all.some((o, j) => j !== i && o.el !== b.el && o.el.contains(b.el) && o.text === b.text));
  const out: ResultCandidate[] = [];
  const seen = new Set<Element>();
  for (let i = 0; i < blocks.length && out.length < 50; i++) {
    const b = blocks[i]!;
    const next = blocks[i + 1];
    // A label then its value: "You pay each month:" then "£15.67"; a dt then its dd; a th then its td.
    const labelLike = /:$/.test(b.text) || ['DT', 'TH', 'LABEL'].includes(b.el.tagName);
    if (labelLike && next && !seen.has(next.el) && next.text.length <= 80) {
      out.push({ id: '', kind: 'fact', label: b.text.replace(/:$/, '').slice(0, 120), text: next.text, css: cssPath(next.el) });
      seen.add(next.el);
      i++;
      continue;
    }
    // A line that carries an amount, a reference or a date on its own.
    if (b.text.length <= 120 && /([£$€]\s?\d)|\b(ref(erence)?|quote (number|no)|policy (number|no))\b|\b\d{1,2} [A-Z][a-z]+ \d{4}\b/i.test(b.text) && !seen.has(b.el)) {
      out.push({ id: '', kind: 'fact', label: b.text.slice(0, 120), text: b.text, css: cssPath(b.el) });
      seen.add(b.el);
    }
  }
  for (const a of Array.from(scope.querySelectorAll('a[href]'))) {
    if (out.length >= 60 || a.closest(SKIP) || !visible(a)) continue;
    const caption = norm(a.textContent) || norm(a.getAttribute('aria-label'));
    if (!caption || caption.length > 80) continue;
    out.push({ id: '', kind: 'link', label: caption, css: cssPath(a) });
  }
  out.forEach((c, i) => (c.id = `r${i + 1}`));
  return { title: norm(document.querySelector('h1')?.textContent) || norm(document.title), candidates: out };
}

const VIEW_SYSTEM = `You label the page at the end of a web form journey for Usher, the page a person sees once they have their quote or have sent their form. Code has listed candidates from it: facts (a label and the text after it) and links. Choose the ones the person would want to keep and see again: a quote or policy reference; a price, with what period it is for in the label; the amount covered or paid out; the term; a date (valid until, starts on); documents (policy summary, terms and conditions, key facts, a PDF); the next step (continue to buy, save the quote). Leave out navigation, marketing, help lines and anything else.
Keys: result.reference, result.price, result.amount, result.term, result.date, result.document, result.next_step.
Give each chosen candidate its key and a short label as the page names it ("You pay each month", "Policy summary"). At most 12, most important first. Give the page a short title as it names itself.`;

const VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'items'],
  properties: {
    title: { type: 'string' },
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'key', 'label'], properties: { id: { type: 'string' }, key: { type: 'string', enum: [...RESULT_KEYS] }, label: { type: 'string' } } } },
  },
};

export interface ViewCompile {
  view: ResultView;
  usage: Usage;
  cost_usd: number | null;
}

/**
 * A result view of the page the walkthrough finished on, after its own test run: the model chooses
 * and names candidates; code keeps each one's locator, and for a fact the page's words before it.
 */
export async function compileResultView(page: Page, options: { chat: ChatFn; model: string; source?: 'walkthrough' | 'compiler'; now?: () => Date }): Promise<ViewCompile> {
  const found = await page.evaluate(`(() => { const __name = (fn) => fn; return (${resultCandidates.toString()})(); })()`) as { title: string; candidates: ResultCandidate[] };
  const url = new URL(page.url());
  const result = await options.chat({
    model: options.model,
    temperature: 0,
    messages: [
      { role: 'system', content: VIEW_SYSTEM },
      { role: 'user', content: JSON.stringify({ page: { path: url.pathname, title: found.title }, candidates: found.candidates.map(({ css: _c, ...c }) => c) }) },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'usher_result_view', strict: true, schema: VIEW_SCHEMA } },
  });
  const answer = (parseJsonContent(result.content) ?? {}) as { title?: string; items?: { id: string; key: string; label: string }[] };
  const byId = new Map(found.candidates.map((c) => [c.id, c]));
  const items: ViewItem[] = [];
  for (const chosen of answer.items ?? []) {
    const c = byId.get(chosen.id);
    if (!c || !(RESULT_KEYS as readonly string[]).includes(chosen.key) || items.some((i) => i.id === c.id)) continue;
    const label = (chosen.label || c.label).trim().slice(0, 120);
    if (!label) continue;
    // Code locates: a fact by the words before it, then its path; a link by its caption, then its path.
    items.push(
      c.kind === 'link'
        ? { id: c.id, key: chosen.key as ResultKey, label, kind: 'link', locators: [{ by: 'role', value: 'link', name: c.label }, { by: 'css', value: c.css }] }
        : { id: c.id, key: chosen.key as ResultKey, label, kind: 'fact', ...(c.label !== c.text && { anchor: c.label }), locators: [{ by: 'css', value: c.css }] },
    );
    if (items.length >= 12) break;
  }
  const view: ResultView = {
    usher_view: '0.1',
    origin: url.origin,
    path: url.pathname,
    title: (answer.title || found.title || 'Result').slice(0, 200),
    items,
    provenance: { source: options.source ?? 'walkthrough', model: options.model, created_at: (options.now?.() ?? new Date()).toISOString() },
  };
  const invalid = viewSchemaErrors(view);
  if (invalid) throw new Error(`The result view is not valid: ${invalid}`);
  return { view, usage: result.usage, cost_usd: costUsd(options.model, result.usage) };
}

/** One item read from a person's own result page: shown to them, never kept. */
export interface ReadItem {
  key: ResultKey;
  label: string;
  kind: 'fact' | 'link';
  text?: string;
  href?: string;
}

/** Reads a person's result page with its view, by code. Items it can't find are left out. */
export async function readResultView(page: Page, view: ResultView): Promise<ReadItem[]> {
  const out: ReadItem[] = [];
  for (const item of view.items) {
    // A fact by its anchor first: the page's words for it, then the text that follows them.
    if (item.kind === 'fact' && item.anchor) {
      const text = await page
        // No named helpers inside: the function is serialised into the page as it is.
        .evaluate((anchor) => {
          const want = anchor.replace(/\s+/g, ' ').trim().replace(/:$/, '').toLowerCase();
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let found = false;
          for (let t = walker.nextNode(); t; t = walker.nextNode()) {
            if (t.parentElement?.closest('script, style, noscript, template, form')) continue;
            const said = (t.nodeValue ?? '').replace(/\s+/g, ' ').trim();
            if (!said) continue;
            if (found) return said;
            if (said.replace(/:$/, '').toLowerCase() === want) found = true;
          }
          return null;
        }, item.anchor)
        .catch(() => null);
      if (text && text.length <= 200) {
        out.push({ key: item.key, label: item.label, kind: 'fact', text });
        continue;
      }
    }
    for (const loc of item.locators) {
      const target = loc.by === 'role' ? page.getByRole('link', { name: loc.name ?? '', exact: true }) : page.locator(loc.value);
      if ((await target.count().catch(() => 0)) !== 1) continue;
      if (item.kind === 'link') {
        const href = await target.getAttribute('href').catch(() => null);
        if (!href) continue;
        const absolute = new URL(href, page.url());
        if (!/^https?:$/.test(absolute.protocol)) continue;
        out.push({ key: item.key, label: item.label, kind: 'link', href: absolute.href });
      } else {
        const text = ((await target.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 200) continue;
        out.push({ key: item.key, label: item.label, kind: 'fact', text });
      }
      break;
    }
  }
  return out;
}
