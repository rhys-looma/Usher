// Form extractor (LU-17).
//
// extractForms() runs inside the page: through Playwright's page.evaluate in tests and the
// compiler, and later inside the site script bundle. It must stay self-contained: every helper
// lives inside the function and nothing is imported at runtime, because the function is
// serialised with toString() and evaluated on its own.
//
// Structure only. It never reads what anyone typed: no `.value` of any control, no
// `value` attribute of fillable inputs, no selected or checked state, no text inside
// selects or text areas. It reads labels, option lists and descriptive attributes.

export type FieldControl =
  | 'text'
  | 'email'
  | 'tel'
  | 'number'
  | 'date'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'textarea'
  | 'file'
  | 'password'
  /** A question answered by pressing one of a few buttons (Male / Female), each type="button". */
  | 'buttons';

export type ActionKind = 'submit' | 'button' | 'link';

/** Where an element's label came from, in resolution order. */
export type LabelSource =
  | 'label-for'
  | 'label-wrap'
  | 'aria-labelledby'
  | 'aria-label'
  | 'legend'
  | 'heading'
  | 'placeholder'
  | 'text'
  | 'content'
  | 'none';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OptionItem {
  value: string;
  label: string;
}

export interface Options {
  items: OptionItem[];
  total: number;
  truncated: boolean;
}

export interface Constraints {
  pattern?: string;
  min?: number | string;
  max?: number | string;
  min_length?: number;
  max_length?: number;
}

export interface ExtractedElement {
  /** e1, e2… in document order within the form. */
  id: string;
  kind: 'field' | 'action';
  /** Tag of the element a runtime acts on (a radio group's fieldset, for example). */
  tag: string;
  control: FieldControl | ActionKind;
  domId?: string;
  name?: string;
  required: boolean;
  constraints?: Constraints;
  autocomplete?: string;
  placeholder?: string;
  label: string;
  labelSource: LabelSource;
  /** Role a runtime can find it by, for actions and radio groups. */
  role?: string;
  group?: string;
  options?: Options;
  /** One part of a date split across fields (day, month, year), when its group holds two or more. */
  part?: 'day' | 'month' | 'year';
  box: Box;
  visible: boolean;
}

export interface ExtractedGroup {
  id: string;
  label: string;
}

export interface ExtractedForm {
  /** Position in the extraction output. */
  index: number;
  /** True for controls outside any <form>, grouped together. */
  pseudo: boolean;
  /** Inside a cookie or consent banner: not the form a person came to fill in. */
  banner: boolean;
  /** A site search box. */
  search: boolean;
  /** A newsletter or mailing-list sign-up box. */
  newsletter: boolean;
  domId?: string;
  method?: string;
  /** Path of the form's action URL, without query or fragment. */
  actionPath?: string;
  groups: ExtractedGroup[];
  elements: ExtractedElement[];
  /** DOM nodes parallel to `elements`; only with `keepNodes`, never serialised. */
  nodes?: Element[];
}

export interface Extraction {
  /** Origin and path of the page, without query or fragment. */
  url: string;
  forms: ExtractedForm[];
}

export interface ExtractOptions {
  /** How many options to list per select or radio group. Default 20. */
  maxOptions?: number;
  /** Keep DOM node references on each form (in-page use only). */
  keepNodes?: boolean;
}

export function extractForms(options: ExtractOptions = {}): Extraction {
  const maxOptions = options.maxOptions ?? 20;
  const keepNodes = options.keepNodes === true;
  const doc = document;
  const win = window;

  const SKIP_TEXT = 'select, option, optgroup, textarea, script, style, template, noscript';
  const CONTROLS = 'input, select, textarea, button, a[href], [role="button"], [role="link"]';
  const GROUPS = 'fieldset, [role="group"], [role="region"], [role="radiogroup"], section';

  function norm(s: string | null | undefined): string {
    return (s ?? '').replace(/\s+/g, ' ').trim();
  }

  // Visible text of a label-like node. Skips selects, options and text areas, whose text
  // would be option lists or typed content.
  function textOf(node: Element): string {
    const parts: string[] = [];
    const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const skip = t.parentElement?.closest(SKIP_TEXT);
      if (skip && (skip === node || node.contains(skip))) continue;
      parts.push(t.nodeValue ?? '');
    }
    return norm(parts.join(' '));
  }

  function idrefText(el: Element, attr: string): string {
    const ids = norm(el.getAttribute(attr)).split(' ').filter(Boolean);
    return norm(
      ids
        .map((id) => doc.getElementById(id))
        .filter((n): n is HTMLElement => n !== null)
        .map(textOf)
        .join(' '),
    );
  }

  // Nearest non-empty text before `el` in document order, within `scope`.
  function precedingText(el: Element, scope: Element): string {
    const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    walker.currentNode = el;
    for (let t = walker.previousNode(); t; t = walker.previousNode()) {
      const parent = t.parentElement;
      if (parent?.closest(SKIP_TEXT)) continue;
      const text = norm(t.nodeValue);
      if (text) return text.slice(0, 200);
    }
    return '';
  }

  // The question before a folded date: of the few texts before it, one about a birth or a date,
  // else the nearest.
  function dateQuestion(form: Element): string {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    walker.currentNode = form;
    let nearest = '';
    let seen = 0;
    for (let t = walker.previousNode(); t && seen < 4; t = walker.previousNode()) {
      if (t.parentElement?.closest(SKIP_TEXT)) continue;
      const text = norm(t.nodeValue);
      if (!text) continue;
      seen++;
      if (/birth|\bdate\b|\bdob\b/i.test(text)) return text.slice(0, 200);
      nearest ||= text;
    }
    return nearest.slice(0, 200) || 'Date';
  }

  function scopeOf(el: Element): Element {
    return el.closest('form') ?? doc.body;
  }

  // Label resolution: label[for], wrapping label, aria-labelledby, aria-label, placeholder,
  // nearest preceding text. Legends and headings are used for groups (radioGroupLabel).
  function fieldLabel(el: Element): { label: string; source: LabelSource } {
    const id = el.getAttribute('id');
    if (id) {
      for (const lab of Array.from(doc.querySelectorAll(`label[for="${CSS.escape(id)}"]`))) {
        const text = textOf(lab);
        if (text) return { label: text, source: 'label-for' };
      }
    }
    const wrap = el.closest('label');
    if (wrap) {
      const text = textOf(wrap);
      if (text) return { label: text, source: 'label-wrap' };
    }
    const labelledBy = idrefText(el, 'aria-labelledby');
    if (labelledBy) return { label: labelledBy, source: 'aria-labelledby' };
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return { label: aria, source: 'aria-label' };
    const placeholder = norm(el.getAttribute('placeholder'));
    if (placeholder) return { label: placeholder, source: 'placeholder' };
    const before = precedingText(el, scopeOf(el));
    if (before) return { label: before, source: 'text' };
    return { label: '', source: 'none' };
  }

  function actionLabel(el: Element): { label: string; source: LabelSource } {
    const labelledBy = idrefText(el, 'aria-labelledby');
    if (labelledBy) return { label: labelledBy, source: 'aria-labelledby' };
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return { label: aria, source: 'aria-label' };
    if (el.tagName === 'INPUT') {
      // The value attribute of a submit or button input is its caption, not user data.
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      const caption = norm(el.getAttribute('value')) || norm(el.getAttribute('alt'));
      if (caption) return { label: caption, source: 'content' };
      return { label: type === 'reset' ? 'Reset' : 'Submit', source: 'content' };
    }
    const text = textOf(el);
    if (text) return { label: text, source: 'content' };
    const alt = norm(el.querySelector('img[alt]')?.getAttribute('alt'));
    if (alt) return { label: alt, source: 'content' };
    const title = norm(el.getAttribute('title'));
    if (title) return { label: title, source: 'content' };
    return { label: '', source: 'none' };
  }

  // The element that stands for a radio group: its fieldset or radiogroup container when that
  // holds every radio of the group, else the first radio.
  function radioTarget(radios: Element[]): Element {
    const first = radios[0]!;
    const container = first.parentElement?.closest('fieldset, [role="radiogroup"], [role="group"]');
    if (container && radios.every((r) => container.contains(r))) return container;
    return first;
  }

  function radioGroupLabel(target: Element, radios: Element[]): { label: string; source: LabelSource } {
    if (target.tagName === 'FIELDSET') {
      const legend = Array.from(target.children).find((c) => c.tagName === 'LEGEND');
      const text = legend ? textOf(legend) : '';
      if (text) return { label: text, source: 'legend' };
    }
    if (target !== radios[0]) {
      const labelledBy = idrefText(target, 'aria-labelledby');
      if (labelledBy) return { label: labelledBy, source: 'aria-labelledby' };
      const aria = norm(target.getAttribute('aria-label'));
      if (aria) return { label: aria, source: 'aria-label' };
    }
    // A heading inside the group, before its first option, names it (a fieldset with no legend, as on
    // Aviva's quote forms); one of the headings before the group would name the question before it.
    if (target !== radios[0]) {
      for (const h of Array.from(target.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
        if (h.compareDocumentPosition(radios[0]!) & Node.DOCUMENT_POSITION_FOLLOWING && textOf(h)) return { label: textOf(h), source: 'heading' };
      }
    }
    // A common heading: the nearest heading before the group.
    const scope = scopeOf(target);
    const start = target.closest('label') ?? target;
    let heading: Element | null = null;
    for (const h of Array.from(scope.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
      if (h.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING) heading = h;
    }
    if (heading && textOf(heading)) return { label: textOf(heading), source: 'heading' };
    const before = precedingText(start, scope);
    if (before) return { label: before, source: 'text' };
    return { label: '', source: 'none' };
  }

  function isVisible(el: Element): boolean {
    if (!el.isConnected) return false;
    const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
    if (typeof check === 'function' && !check.call(el, { opacityProperty: true, visibilityProperty: true })) return false;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const r = el.getBoundingClientRect();
    // Tiny or off-page elements are how honeypots hide.
    if (r.width < 2 || r.height < 2) return false;
    if (r.right + win.scrollX <= 0 || r.bottom + win.scrollY <= 0) return false;
    return true;
  }

  function boxOf(el: Element): Box {
    // Not rendered (display: none): no box, rather than one at the scroll position.
    if (el.getClientRects().length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + win.scrollX),
      y: Math.round(r.top + win.scrollY),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  }

  function isRequired(el: Element): boolean {
    return el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';
  }

  function inputType(el: Element): string {
    return (el.getAttribute('type') ?? 'text').toLowerCase();
  }

  // Classifies a control, or returns null for things that aren't (hidden inputs).
  function classify(el: Element): { kind: 'field'; control: FieldControl } | { kind: 'action'; control: ActionKind } | null {
    const tag = el.tagName;
    if (tag === 'SELECT') return { kind: 'field', control: 'select' };
    if (tag === 'TEXTAREA') return { kind: 'field', control: 'textarea' };
    if (tag === 'INPUT') {
      const type = inputType(el);
      switch (type) {
        case 'hidden':
          return null;
        case 'submit':
        case 'image':
          return { kind: 'action', control: 'submit' };
        case 'button':
        case 'reset':
          return { kind: 'action', control: 'button' };
        case 'email':
        case 'tel':
        case 'number':
        case 'date':
        case 'radio':
        case 'checkbox':
        case 'file':
        case 'password':
          return { kind: 'field', control: type };
        case 'range':
          return { kind: 'field', control: 'number' };
        case 'datetime-local':
        case 'month':
        case 'week':
          return { kind: 'field', control: 'date' };
        default:
          return { kind: 'field', control: 'text' };
      }
    }
    if (tag === 'BUTTON') {
      const type = (el.getAttribute('type') ?? 'submit').toLowerCase();
      const owner = (el as HTMLButtonElement).form;
      return { kind: 'action', control: type === 'submit' && owner ? 'submit' : 'button' };
    }
    if (tag === 'A' || el.getAttribute('role') === 'link') return { kind: 'action', control: 'link' };
    if (el.getAttribute('role') === 'button') return { kind: 'action', control: 'button' };
    return null;
  }

  function roleOf(el: Element, control: string): string | undefined {
    const explicit = norm(el.getAttribute('role'));
    if (explicit) return explicit.split(' ')[0];
    if (control === 'link') return 'link';
    if (control === 'submit' || control === 'button') return 'button';
    if (el.tagName === 'FIELDSET') return 'group';
    return undefined;
  }

  function constraintsOf(el: Element, control: string): Constraints | undefined {
    const c: Constraints = {};
    const pattern = el.getAttribute('pattern');
    if (pattern) c.pattern = pattern;
    for (const key of ['min', 'max'] as const) {
      const raw = el.getAttribute(key);
      if (raw === null || raw === '') continue;
      const n = Number(raw);
      c[key] = control === 'number' && Number.isFinite(n) ? n : raw;
    }
    for (const [attr, key] of [['minlength', 'min_length'], ['maxlength', 'max_length']] as const) {
      const n = parseInt(el.getAttribute(attr) ?? '', 10);
      if (Number.isFinite(n) && n >= 0) c[key] = n;
    }
    return Object.keys(c).length ? c : undefined;
  }

  function cap(items: OptionItem[]): Options {
    return { items: items.slice(0, maxOptions), total: items.length, truncated: items.length > maxOptions };
  }

  function selectOptions(el: HTMLSelectElement): Options {
    const items: OptionItem[] = [];
    for (const opt of Array.from(el.querySelectorAll('option'))) {
      const text = norm(opt.textContent);
      const value = opt.getAttribute('value') ?? text;
      // An empty value is the "Please select" placeholder, not a choice.
      if (value === '') continue;
      items.push({ value, label: norm(opt.getAttribute('label')) || text });
    }
    return cap(items);
  }

  function radioOptions(radios: Element[]): Options {
    return cap(radios.map((r) => ({ value: r.getAttribute('value') ?? 'on', label: fieldLabel(r).label })));
  }

  // Fieldsets and headed sections an element sits in. Radio-group containers are the
  // element itself, so they are not groups.
  function groupLabel(g: Element): string {
    if (g.tagName === 'FIELDSET') {
      const legend = Array.from(g.children).find((c) => c.tagName === 'LEGEND');
      return legend ? textOf(legend) : '';
    }
    const named = idrefText(g, 'aria-labelledby') || norm(g.getAttribute('aria-label'));
    if (named) return named;
    const heading = g.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > header h1, :scope > header h2, :scope > header h3, :scope > header h4');
    return heading ? textOf(heading) : '';
  }

  /**
   * Controls that browse or filter what a page shows, rather than fill or submit the form: they are
   * left out of maps. So are links inside labels, which belong to the label's wording. Links listed as results (inside any list where three or more items hold
   * links: search results, article lists, and the sub-links within one result; pagination sits in
   * nav and is kept), tabs, and carousel controls.
   */
  function outOfScope(el: Element, control: string): boolean {
    // A link inside a label (the terms a consent box refers to) is part of that label.
    if (control === 'link' && el.closest('label')) return true;
    if (control === 'link' && !el.closest('nav')) {
      for (let item = el.closest('li, [role="listitem"]'); item; item = item.parentElement?.closest('li, [role="listitem"]') ?? null) {
        const list = item.parentElement;
        if (list && Array.from(list.children).filter((c) => c.querySelector('a[href]')).length >= 3) return true;
      }
    }
    if (el.getAttribute('role') === 'tab' || el.closest('[role="tablist"]')) return true;
    return /\b(carousel|slides?|slideshow)\b/i.test(el.getAttribute('aria-label') ?? '');
  }

  // A question answered with buttons: two to eight type="button" buttons, the only children of
  // their container, each with a short caption that isn't a way forward, and the question just
  // before them ("Your gender", then Male and Female). It is one field whose options are the buttons'
  // captions; the buttons are not actions. A button that can submit never counts.
  const NOT_AN_ANSWER = /^(next|back|previous|continue|submit|send|save|cancel|close|search|find|get|apply|start|buy|pay|confirm|edit|remove|delete|add|show|hide|more|less|menu)\b/i;
  const choiceGroups = new Map<Element, { question: string; buttons: HTMLButtonElement[] }>();
  const choiceOf = new Map<Element, Element>();
  function questionBefore(container: Element): string {
    const named = idrefText(container, 'aria-labelledby') || norm(container.getAttribute('aria-label'));
    if (named) return named.slice(0, 200);
    // The sibling texts before it: the nearest that asks something ("…?"), else the nearest.
    let nearest = '';
    let hops = 0;
    for (let sib = container.previousElementSibling; sib && hops < 3; sib = sib.previousElementSibling, hops++) {
      if (sib.matches(CONTROLS) || sib.querySelector(CONTROLS)) break;
      const text = textOf(sib);
      if (!text) continue;
      if (/\?$/.test(text)) return text.slice(0, 200);
      nearest ||= text;
    }
    return nearest.slice(0, 200);
  }
  for (const container of new Set(Array.from(doc.querySelectorAll('button[type="button" i]')).map((b) => b.parentElement).filter((c): c is HTMLElement => c !== null))) {
    if (container.closest('nav, header, footer, [role="tablist"], [role="toolbar"], [role="menu"]')) continue;
    const kids = Array.from(container.children);
    if (kids.length < 2 || kids.length > 8) continue;
    if (!kids.every((k) => k.tagName === 'BUTTON' && (k.getAttribute('type') ?? '').toLowerCase() === 'button' && !k.querySelector(CONTROLS))) continue;
    const captions = kids.map((k) => textOf(k));
    if (captions.some((c) => !c || c.length > 40 || NOT_AN_ANSWER.test(c)) || new Set(captions).size !== captions.length) continue;
    const question = questionBefore(container);
    if (!question) continue;
    choiceGroups.set(container, { question, buttons: kids as HTMLButtonElement[] });
    for (const k of kids) choiceOf.set(k, container);
  }

  // Bucket controls by owning form, in document order.
  const buckets = new Map<HTMLFormElement | null, Element[]>();
  for (const el of Array.from(doc.querySelectorAll(CONTROLS))) {
    const kind = classify(el);
    if (!kind) continue;
    if (kind.kind === 'action' && outOfScope(el, kind.control)) continue;
    // Skip controls nested inside another control (a role=button inside a link, say).
    if (el.parentElement?.closest('button, a[href], [role="button"], [role="link"]')) continue;
    const owner =
      el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el instanceof HTMLButtonElement
        ? el.form
        : el.closest('form');
    // Links outside forms are page navigation, not form actions.
    if (!owner && classify(el)!.control === 'link') continue;
    const list = buckets.get(owner) ?? [];
    list.push(el);
    buckets.set(owner, list);
  }

  // A date of birth split into day, month and year boxes, in a <form> of its own beside a page
  // whose questions sit outside any form: one question of that page, not a form of its own. It
  // joins the page's controls in document order, as a group named by the text before it.
  const foldedForms = new Set<Element>();
  const datePartWord = (el: Element) => /^(dd|mm|yy|yyyy|day|month|year)$/i.test(norm(el.getAttribute('placeholder'))) || /(^|[_\-[.])(day|month|year|dd|mm|yyyy)($|[_\-\]])/i.test(`${el.getAttribute('name') ?? ''} ${el.getAttribute('id') ?? ''}`) || /-(day|month|year)$/.test(el.getAttribute('autocomplete') ?? '');
  if (buckets.get(null)?.some((el) => classify(el)!.kind === 'field')) {
    for (const [form, list] of Array.from(buckets)) {
      if (!form || list.length < 2 || list.length > 3) continue;
      if (!list.every((el) => el.tagName !== 'BUTTON' && ['text', 'number', 'tel', 'select'].includes(classify(el)?.control ?? '') && datePartWord(el))) continue;
      buckets.delete(form);
      foldedForms.add(form);
      const merged = [...buckets.get(null)!, ...list].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      buckets.set(null, merged);
    }
  }

  const order: (HTMLFormElement | null)[] = [...Array.from(doc.forms).filter((f) => buckets.has(f))];
  const loose = buckets.get(null);
  if (loose && loose.some((el) => classify(el)!.kind === 'field')) order.push(null);

  const forms: ExtractedForm[] = order.map((form, index) => {
    const controls = buckets.get(form)!;
    const elements: ExtractedElement[] = [];
    const nodes: Element[] = [];
    const groups: ExtractedGroup[] = [];
    const groupIds = new Map<Element, string>();
    const seenRadio = new Set<string>();
    const radioContainers = new Set<Element>();

    function groupOf(target: Element): string | undefined {
      // A folded date form is the group of its parts, named by the text before it.
      const folded = target.closest('form');
      if (folded && foldedForms.has(folded)) {
        let id = groupIds.get(folded);
        if (!id) {
          id = `g${groups.length + 1}`;
          groupIds.set(folded, id);
          groups.push({ id, label: dateQuestion(folded) });
        }
        return id;
      }
      const stop = form ?? doc.body;
      for (let g = target.parentElement?.closest(GROUPS); g && stop.contains(g) && g !== stop; g = g.parentElement?.closest(GROUPS)) {
        if (radioContainers.has(g)) continue;
        let id = groupIds.get(g);
        if (!id) {
          const label = groupLabel(g);
          if (!label) continue;
          id = `g${groups.length + 1}`;
          groupIds.set(g, id);
          groups.push({ id, label });
        }
        return id;
      }
      return undefined;
    }

    const seenChoice = new Set<Element>();
    for (const el of controls) {
      // A button that answers a question: the question, once, as a field on its container.
      const container = choiceOf.get(el);
      if (container) {
        if (seenChoice.has(container)) continue;
        seenChoice.add(container);
        const choice = choiceGroups.get(container)!;
        const record: ExtractedElement = {
          id: `e${elements.length + 1}`,
          kind: 'field',
          tag: container.tagName.toLowerCase(),
          control: 'buttons',
          required: container.getAttribute('aria-required') === 'true',
          label: choice.question,
          labelSource: 'text',
          box: boxOf(container),
          visible: choice.buttons.some(isVisible),
          options: cap(choice.buttons.map((b) => ({ value: textOf(b), label: textOf(b) }))),
        };
        const domId = container.getAttribute('id');
        if (domId) record.domId = domId;
        const group = groupOf(container);
        if (group) record.group = group;
        elements.push(record);
        nodes.push(container);
        continue;
      }
      const kind = classify(el)!;
      let target = el;
      let label: { label: string; source: LabelSource };
      let required = false;
      let visible: boolean;
      let choices: Options | undefined;
      const name = el.getAttribute('name') ?? undefined;

      if (kind.kind === 'field' && kind.control === 'radio') {
        const key = name ? `n:${name}` : '';
        if (key && seenRadio.has(key)) continue;
        if (key) seenRadio.add(key);
        const radios = name ? controls.filter((c) => inputType(c) === 'radio' && c.getAttribute('name') === name) : [el];
        target = radioTarget(radios);
        if (target !== el) radioContainers.add(target);
        label = radioGroupLabel(target, radios);
        required = radios.some(isRequired) || target.getAttribute('aria-required') === 'true';
        // Radios styled as cards hide the input behind its label: the label shows it.
        const shown = (r: Element) => isVisible(r) || isVisible(r.closest('label') ?? r) || Array.from((r as HTMLInputElement).labels ?? []).some(isVisible);
        visible = target !== el ? isVisible(target) && radios.some(shown) : radios.some(shown);
        choices = radioOptions(radios);
      } else if (kind.kind === 'field') {
        label = fieldLabel(el);
        required = isRequired(el);
        // Styled checkboxes are often invisible themselves with a visible label.
        visible = isVisible(el) || (kind.control === 'checkbox' && ((!!el.closest('label') && isVisible(el.closest('label')!)) || Array.from((el as HTMLInputElement).labels ?? []).some(isVisible)));
        if (kind.control === 'select') choices = selectOptions(el as HTMLSelectElement);
      } else {
        label = actionLabel(el);
        visible = isVisible(el);
      }

      const record: ExtractedElement = {
        id: `e${elements.length + 1}`,
        kind: kind.kind,
        tag: target.tagName.toLowerCase(),
        control: kind.control,
        required,
        label: label.label,
        labelSource: label.source,
        box: boxOf(target),
        visible,
      };
      const domId = target.getAttribute('id');
      if (domId) record.domId = domId;
      if (name) record.name = name;
      if (kind.kind === 'field' && kind.control !== 'radio') {
        const constraints = constraintsOf(el, kind.control);
        if (constraints) record.constraints = constraints;
        const autocomplete = norm(el.getAttribute('autocomplete'));
        if (autocomplete) record.autocomplete = autocomplete;
        const placeholder = norm(el.getAttribute('placeholder'));
        if (placeholder) record.placeholder = placeholder;
      }
      const role = kind.kind === 'action' || target !== el ? roleOf(target, kind.control) : undefined;
      if (role) record.role = role;
      const group = groupOf(target);
      if (group) record.group = group;
      if (choices) record.options = choices;
      elements.push(record);
      nodes.push(target);
    }

    // A date split across fields: each part from its own words (autocomplete bday-day, a name like
    // DayOfBirth, dob-day or dob[day], "Day of birth", a DD placeholder), kept only where a group
    // holds two parts or more, so a lone "Year of manufacture" stays a field of its own.
    const partOf = (e: ExtractedElement): 'day' | 'month' | 'year' | null => {
      if (e.kind !== 'field' || !['text', 'number', 'tel', 'select'].includes(e.control)) return null;
      const auto = /-(day|month|year)$/.exec(e.autocomplete ?? '')?.[1];
      if (auto) return auto as 'day' | 'month' | 'year';
      const said = `${e.name ?? ''} ${e.domId ?? ''}`.toLowerCase();
      const m = /(?:^|[\s_\-[.])(day|month|year|dd|mm|yyyy)(?:[\s_\-\]]|$)|(day|month|year)of|(?:dob|birth|date|start)(day|month|year)/.exec(said);
      const word = m?.[1] ?? m?.[2] ?? m?.[3] ?? /^(day|month|year)\b/.exec(e.label.trim().toLowerCase())?.[1] ?? ({ dd: 'day', mm: 'month', yyyy: 'year' } as Record<string, string>)[(e.placeholder ?? '').trim().toLowerCase()];
      const part = word === 'dd' ? 'day' : word === 'mm' ? 'month' : word === 'yyyy' ? 'year' : word;
      return part === 'day' || part === 'month' || part === 'year' ? part : null;
    };
    const parted = elements.map((e) => ({ e, part: partOf(e) })).filter((x) => x.part && x.e.group);
    for (const x of parted) {
      const kinds = new Set(parted.filter((y) => y.e.group === x.e.group).map((y) => y.part));
      if (kinds.size >= 2) x.e.part = x.part!;
    }

    // A cookie or consent banner: the form, or a container, says so in its id, class or label, or
    // at least half its fields are about cookies.
    const BANNER = /cookie|consent|gdpr|onetrust|ot-sdk|didomi|cookiebot|privacy-?banner/i;
    const attrs = (n: Element) => `${n.id} ${typeof n.className === 'string' ? n.className : ''} ${n.getAttribute('aria-label') ?? ''}`;
    const first = nodes[0];
    let banner = false;
    for (let n: Element | null = form ?? first?.parentElement ?? null; n && n !== doc.body; n = n.parentElement) {
      if (BANNER.test(attrs(n))) {
        banner = true;
        break;
      }
    }
    const fieldLabels = elements.filter((e) => e.kind === 'field').map((e) => e.label);
    if (!banner && fieldLabels.length && fieldLabels.filter((l) => /cookie|consent/i.test(l)).length * 2 >= fieldLabels.length) banner = true;

    // A site search: role=search on or around the form, a <search> element, or a form of at most
    // two fields with a search box or that says search in its id, class, label or action.
    let search = false;
    let newsletter = false;
    if (form) {
      const said = `${attrs(form)} ${form.getAttribute('action') ?? ''}`;
      const small = fieldLabels.length <= 2;
      search = Boolean(form.closest('[role="search"], search')) || (small && (nodes.some((n) => n instanceof HTMLInputElement && n.type === 'search') || /search/i.test(said)));
      // A newsletter box: at most three fields, one of them an email address, and the form or its
      // labels and buttons say newsletter, subscribe or mailing list.
      const words = `${said} ${elements.map((e) => e.label).join(' ')}`;
      newsletter = fieldLabels.length <= 3 && elements.some((e) => e.control === 'email' || /e-?mail/i.test(e.label)) && /newsletter|subscribe|mailing list/i.test(words);
    }
    const out: ExtractedForm = { index, pseudo: form === null, banner, search, newsletter, groups, elements };
    if (form) {
      const domId = form.getAttribute('id');
      if (domId) out.domId = domId;
      out.method = (form.getAttribute('method') ?? 'get').toLowerCase();
      try {
        out.actionPath = new URL(form.getAttribute('action') ?? '', doc.baseURI).pathname;
      } catch {
        // Unparseable action; leave it out.
      }
    }
    if (keepNodes) out.nodes = nodes;
    return out;
  });

  return { url: win.location.origin + win.location.pathname, forms };
}
