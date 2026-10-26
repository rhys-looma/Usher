// Locators (LU-18).
//
// locatorKit() runs inside the page and must stay self-contained, like extractForms: every
// helper lives inside it and nothing is imported at runtime. It builds candidate locators for
// an extracted element and resolves locators the way a runtime would, keeping only candidates
// that resolve to exactly the element they describe.

export type LocatorBy = 'id' | 'name' | 'label' | 'role' | 'placeholder' | 'css';

export interface Locator {
  by: LocatorBy;
  value: string;
  /** Accessible name, for `role` locators. */
  name?: string;
}

/** The parts of an extracted element that locators are built from. */
export interface LocatorSource {
  kind: 'field' | 'action';
  control: string;
  domId?: string;
  name?: string;
  label: string;
  labelSource: string;
  role?: string;
  placeholder?: string;
}

export interface LocatorKit {
  /** Elements a locator resolves to. A radio group counts once, as its container. */
  resolve(locator: Locator): Element[];
  /** Locators for `target` in priority order, each resolving to exactly `target`. */
  locatorsFor(target: Element, source: LocatorSource): Locator[];
  /** A structural CSS selector for `target`, unique in the document. */
  cssFor(target: Element): string;
}

export function locatorKit(): LocatorKit {
  const doc = document;
  const SKIP_TEXT = 'select, option, optgroup, textarea, script, style, template, noscript';
  // Label sources a runtime can find again by label text.
  const LABELLED = ['label-for', 'label-wrap', 'aria-labelledby', 'aria-label'];

  function norm(s: string | null | undefined): string {
    return (s ?? '').replace(/\s+/g, ' ').trim();
  }

  // Same rules as the extractor's textOf: label text without option lists or typed content.
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

  function attrSelector(attr: string, value: string): string {
    return `[${attr}="${CSS.escape(value)}"]`;
  }

  // A radio stands for its group: the fieldset or radiogroup holding every radio of that
  // name in the same form, else the group's first radio. Mirrors the extractor.
  function groupTarget(el: Element): Element {
    if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || !el.name) return el;
    const scope: ParentNode = el.form ?? doc;
    const radios = Array.from(scope.querySelectorAll(`input[type="radio"]${attrSelector('name', el.name)}`)).filter(
      (r) => (r as HTMLInputElement).form === el.form,
    );
    const first = radios[0] ?? el;
    const container = first.parentElement?.closest('fieldset, [role="radiogroup"], [role="group"]');
    if (container && radios.every((r) => container.contains(r))) return container;
    return first;
  }

  function unique(els: Element[]): Element[] {
    return Array.from(new Set(els.map(groupTarget)));
  }

  const ROLE_SELECTORS: Record<string, string> = {
    button: 'button, input[type="submit"], input[type="button"], input[type="reset"], input[type="image"], [role="button"]',
    link: 'a[href], [role="link"]',
    group: 'fieldset, [role="group"]',
    radiogroup: '[role="radiogroup"]',
  };

  function hasRole(el: Element, role: string): boolean {
    const explicit = norm(el.getAttribute('role')).split(' ')[0];
    return explicit ? explicit === role : true;
  }

  function accessibleName(el: Element): string {
    const labelledBy = idrefText(el, 'aria-labelledby');
    if (labelledBy) return labelledBy;
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria;
    if (el.tagName === 'FIELDSET') {
      const legend = Array.from(el.children).find((c) => c.tagName === 'LEGEND');
      return legend ? textOf(legend) : '';
    }
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      return norm(el.getAttribute('value')) || norm(el.getAttribute('alt')) || (type === 'reset' ? 'Reset' : 'Submit');
    }
    return textOf(el) || norm(el.querySelector('img[alt]')?.getAttribute('alt')) || norm(el.getAttribute('title'));
  }

  function labelled(value: string): Element[] {
    const found: Element[] = [];
    for (const lab of Array.from(doc.querySelectorAll('label'))) {
      if (textOf(lab) === value && lab.control) found.push(lab.control);
    }
    for (const el of Array.from(doc.querySelectorAll('[aria-label]'))) {
      if (norm(el.getAttribute('aria-label')) === value) found.push(el);
    }
    for (const el of Array.from(doc.querySelectorAll('[aria-labelledby]'))) {
      if (idrefText(el, 'aria-labelledby') === value) found.push(el);
    }
    return found;
  }

  function resolve(locator: Locator): Element[] {
    try {
      switch (locator.by) {
        case 'id':
          return unique(Array.from(doc.querySelectorAll(attrSelector('id', locator.value))));
        case 'name':
          return unique(Array.from(doc.querySelectorAll(attrSelector('name', locator.value))));
        case 'label':
          return unique(labelled(locator.value));
        case 'placeholder':
          return unique(Array.from(doc.querySelectorAll('[placeholder]')).filter((el) => norm(el.getAttribute('placeholder')) === locator.value));
        case 'role': {
          const selector = ROLE_SELECTORS[locator.value] ?? `[role="${CSS.escape(locator.value)}"]`;
          return unique(
            Array.from(doc.querySelectorAll(selector)).filter((el) => hasRole(el, locator.value) && accessibleName(el) === (locator.name ?? '')),
          );
        }
        case 'css':
          return Array.from(doc.querySelectorAll(locator.value));
      }
    } catch {
      return [];
    }
    return [];
  }

  function only(selector: string, target: Element): boolean {
    const found = doc.querySelectorAll(selector);
    return found.length === 1 && found[0] === target;
  }

  // Structural selector: tag and type inside the form if that is unique, else a tag and
  // nth-of-type path from <body>. Never uses ids, names or classes, which redesigns change.
  function cssFor(target: Element): string {
    const tag = target.tagName.toLowerCase();
    const type = target.getAttribute('type');
    const typed = type ? `${tag}[type="${CSS.escape(type)}"]` : tag;
    const short = target.closest('form') ? [`form ${typed}`, `form ${tag}`] : [typed];
    for (const s of short) if (only(s, target)) return s;

    const parts: string[] = [];
    for (let el: Element | null = target; el && el !== doc.documentElement; el = el.parentElement) {
      const name = el.tagName.toLowerCase();
      if (el === doc.body) {
        parts.unshift('body');
        break;
      }
      const same = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c.tagName === el!.tagName) : [el];
      parts.unshift(same.length > 1 ? `${name}:nth-of-type(${same.indexOf(el) + 1})` : name);
    }
    return parts.join(' > ');
  }

  function locatorsFor(target: Element, source: LocatorSource): Locator[] {
    const candidates: Locator[] = [];
    if (source.domId) candidates.push({ by: 'id', value: source.domId });
    if (source.name) candidates.push({ by: 'name', value: source.name });
    if (source.kind === 'field' && source.control !== 'radio' && source.label && LABELLED.includes(source.labelSource)) {
      candidates.push({ by: 'label', value: source.label });
    }
    if (source.role && source.label) candidates.push({ by: 'role', value: source.role, name: source.label });
    if (source.placeholder) candidates.push({ by: 'placeholder', value: source.placeholder });

    const kept = candidates.filter((loc) => {
      const found = resolve(loc);
      return found.length === 1 && found[0] === target;
    });
    // CSS is the last resort: only when fewer than two semantic locators survive.
    if (kept.length < 2) kept.push({ by: 'css', value: cssFor(target) });
    return kept;
  }

  return { resolve, locatorsFor, cssFor };
}
