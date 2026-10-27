// How two semantic keys for the same element compare, for scoring and for the disagreements report.
// Exact match is the strict measure; equivalence forgives near-synonyms that an agent would fill
// the same way, and custom keys that name the same thing in different words.

/** Pairs an agent fills from the same answer. */
export const SYNONYMS: readonly (readonly [string, string])[] = [['contact.phone', 'contact.mobile']];

const NAME_KEYS = new Set(['person.full_name', 'person.first_name', 'person.last_name']);

const STOP = new Set(['a', 'an', 'the', 'your', 'you', 'my', 'of', 'for', 'to', 'in', 'on', 'at', 'and', 'or', 'is', 'are', 'do', 'does', 'did', 'what', 'which', 'how', 'please', 'with', 'by', 'from']);

/** The words of a custom key's slug, lowercased, roughly stemmed, without filler words. */
export function slugWords(key: string): Set<string> {
  const slug = key.replace(/^custom\./, '');
  const stem = (w: string) => w.replace(/(ing|ed)$/, '').replace(/(?<=..)s$/, '');
  return new Set(slug.split(/[_.]+/).filter((w) => w && !STOP.has(w)).map(stem));
}

/** Two custom keys match when, after normalising, one slug's words contain the other's. */
export function sameCustomSlug(a: string, b: string): boolean {
  const [x, y] = [slugWords(a), slugWords(b)];
  if (!x.size || !y.size) return false;
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  return [...small].every((w) => big.has(w));
}

export type KeyComparison =
  /** The same key. */
  | 'exact'
  /** A listed synonym pair, or a name split differently where the form has one name field. */
  | 'synonym'
  /** Two custom keys for the same thing, worded differently. */
  | 'custom_same'
  /** Two custom keys that don't normalise to the same slug. */
  | 'custom_wording'
  /** One side used a vocabulary key and the other a custom key. */
  | 'custom_vs_vocabulary'
  /** Two different vocabulary keys. */
  | 'different';

export interface KeyContext {
  /** The form has a single name field, so full name and first or last name mean the same box. */
  singleNameField?: boolean;
}

export function compareKeys(a: string, b: string, context: KeyContext = {}): KeyComparison {
  if (a === b) return 'exact';
  if (SYNONYMS.some(([x, y]) => (a === x && b === y) || (a === y && b === x))) return 'synonym';
  if (context.singleNameField && NAME_KEYS.has(a) && NAME_KEYS.has(b)) return 'synonym';
  const customA = a.startsWith('custom.');
  const customB = b.startsWith('custom.');
  if (customA && customB) return sameCustomSlug(a, b) ? 'custom_same' : 'custom_wording';
  if (customA || customB) return 'custom_vs_vocabulary';
  return 'different';
}

/** Equivalent for scoring: exact, a synonym, or the same custom slug. */
export const equivalentKeys = (a: string, b: string, context: KeyContext = {}): boolean => ['exact', 'synonym', 'custom_same'].includes(compareKeys(a, b, context));

/** Whether a set of keys (one form's) has exactly one name field. */
export const singleNameField = (keys: Iterable<string>): boolean => [...keys].filter((k) => NAME_KEYS.has(k)).length === 1;
