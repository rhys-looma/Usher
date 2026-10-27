// The map a site publishes in its own page (<script type="application/usher+json">). The site
// script extracts the live form and labels it from the site's current map: unchanged, the
// current map as it is; changed, the live structure with each element keyed by the current
// map's element it still is, and the rest marked unlabelled. Pure, so it runs in the site script.

import type { ExtractedGroup } from './extract.ts';
import type { Fingerprint } from './fingerprint.ts';
import type { ScannedElement } from './inpage.ts';
import type { MapAction, MapField, UsherMap } from './map.ts';

/** Elements no current-map element matches: custom.unlabelled_<n>, which no agent profile holds. */
export const UNLABELLED = /^custom\.unlabelled_\d+$/;

export interface PublishInput {
  origin: string;
  /** The current map's path pattern, or the page's path. */
  path: string;
  elements: ScannedElement[];
  groups: ExtractedGroup[];
  fingerprint: Fingerprint;
  /** The site's current map for this page, if it has one. */
  current: UsherMap | null;
  /** The live element (by id) a current-map element's own locators find, if exactly one. */
  same?: (element: MapField | MapAction) => string | undefined;
  now: string;
}

export interface Published {
  map: UsherMap;
  /** The current map unchanged (the live form is the one it was built for). */
  exact: boolean;
  /** Live element ids that kept a key, and those left unlabelled. */
  kept: string[];
  unlabelled: string[];
}

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 1));
const jaccard = (a: Set<string>, b: Set<string>) => (a.size + b.size ? [...a].filter((w) => b.has(w)).length / new Set([...a, ...b]).size : 0);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * How sure we are that a live element is a current-map element. Its own locators finding it is
 * certain; otherwise the label, the options, the constraints, and being the only one of its kind.
 */
function score(live: ScannedElement, old: MapField | MapAction, found: string | undefined, onlyOfKind: boolean): number {
  const oldControl = 'control' in old ? old.control : old.kind;
  if (live.control !== oldControl || (live.kind === 'action') !== !('control' in old)) return 0;
  if (found === live.id) return 1;
  let s = 0;
  if (words(live.label).size && same([...words(live.label)].sort(), [...words(old.label)].sort())) s = Math.max(s, 0.9);
  const options = 'options' in old && old.options && live.options;
  if (options && old.options!.items.length > 1 && same(old.options!.items.map((o) => o.value), live.options!.items.map((o) => o.value))) s = Math.max(s, 0.8);
  const { format: _, ...constraints } = ('constraints' in old && old.constraints) || {};
  if (Object.keys(constraints).length && same(constraints, live.constraints ?? {})) s = Math.max(s, 0.6);
  if (onlyOfKind) s = Math.max(s, 0.6);
  return Math.max(s, jaccard(words(live.label), words(old.label)) * 0.7);
}

export function publishMap(input: PublishInput): Published | null {
  const { current } = input;
  if (!current) return null;
  if (current.fingerprint.digest === input.fingerprint.digest) return { map: current, exact: true, kept: [], unlabelled: [] };

  const olds = [...current.fields, ...current.actions];
  const kindOf = (e: { control?: string; kind?: string }) => ('control' in e && e.control ? e.control : e.kind);
  const count = <T>(list: T[], key: (t: T) => string | undefined) => list.reduce((m, t) => m.set(key(t), (m.get(key(t)) ?? 0) + 1), new Map<string | undefined, number>());
  const liveKinds = count(input.elements, (e) => e.control);
  const oldKinds = count(olds, kindOf);
  const found = new Map(olds.map((o) => [o, input.same?.(o)]));

  // Best pairs first, each element used once; below 0.5 is a guess, so it stays unlabelled.
  const pairs = input.elements.flatMap((live) =>
    olds.map((old) => ({ live, old, s: score(live, old, found.get(old), liveKinds.get(live.control) === 1 && oldKinds.get(kindOf(old)) === 1) })),
  );
  pairs.sort((a, b) => b.s - a.s);
  const match = new Map<string, MapField | MapAction>();
  const taken = new Set<MapField | MapAction>();
  for (const p of pairs) {
    if (p.s < 0.5) break;
    if (match.has(p.live.id) || taken.has(p.old)) continue;
    match.set(p.live.id, p.old);
    taken.add(p.old);
  }

  // The current map's field ids, now the live ones, for conditions.
  const idOf = new Map([...match].map(([liveId, old]) => [old.id, liveId]));
  let n = 0;
  const fields: MapField[] = [];
  const actions: MapAction[] = [];
  for (const el of input.elements) {
    const old = match.get(el.id);
    if (el.kind === 'action') {
      const a = old as MapAction | undefined;
      // An action nobody recognises is treated as one the user confirms.
      actions.push({ id: el.id, key: a?.key ?? `custom.unlabelled_${++n}`, label: el.label, kind: el.control, risk: a?.risk ?? 'consequential', locators: el.locators, ...(a?.leads_to && { leads_to: a.leads_to }) });
      continue;
    }
    const f = old as MapField | undefined;
    const format = f?.constraints?.format;
    const constraints = { ...el.constraints, ...(format && { format }) };
    const shownIf = f?.shown_if && idOf.get(f.shown_if.field);
    fields.push({
      id: el.id,
      key: f?.key ?? `custom.unlabelled_${++n}`,
      label: el.label,
      control: el.control,
      required: el.required,
      // A field nobody recognises is the user's to fill.
      risk: f?.risk ?? 'needs_user',
      ...(f?.sensitive && { sensitive: true }),
      ...(Object.keys(constraints).length > 0 && { constraints }),
      ...(el.options && { options: el.options }),
      ...(el.group && { group: el.group }),
      ...(f?.shown_if && shownIf && { shown_if: { ...f.shown_if, field: shownIf } }),
      locators: el.locators,
    });
  }
  const used = new Set(fields.map((f) => f.group).filter(Boolean));
  const groups = input.groups.filter((g) => used.has(g.id));
  return {
    map: {
      usher: '0.1',
      origin: input.origin,
      path: input.path,
      fingerprint: input.fingerprint,
      form: current.form,
      ...(groups.length > 0 && { groups }),
      fields,
      actions,
      provenance: { source: 'site', created_at: input.now, verified: false },
    },
    exact: false,
    kept: [...match.keys()],
    unlabelled: input.elements.filter((e) => !match.has(e.id)).map((e) => e.id),
  };
}
