// Values by key, written one way (spec/vocabulary.md, "Values"), to what a particular control takes:
// the option a person's answer means, and a date in the form a field shows it. Code only: the model
// is asked (pickOptionRequest) only when no rule matches, and then only to choose among the labels.

import type { OptionItem } from './extract.ts';
import { vocabulary } from './vocabulary.ts';
import { parseJsonContent, type ChatFn, type ChatRequest } from './compile/model.ts';


/** Day, month or year of a date split across several fields under one key. */
export type DatePart = 'day' | 'month' | 'year';

const DATES = new Set(vocabulary.dates ?? []);
export const isDateKey = (key: string) => DATES.has(key);

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const YES = new Set(['yes', 'y', 'true']);
const NO = new Set(['no', 'n', 'false']);
const truth = (s: string) => (YES.has(norm(s)) ? 'yes' : NO.has(norm(s)) ? 'no' : null);
/** The numbers in a text, without currency, separators or units: "£1,050 a year" is [1050]. */
const numbers = (s: string) => [...s.replace(/(\d),(?=\d{3}\b)/g, '$1').matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));

/**
 * The option a value means: by value, then label (case and spacing aside), then yes/no in any of
 * its forms, then the one option whose only number is the value's ("250" is "£250", "12000" is
 * "Up to 12,000 a year"), a year included. Null when no rule finds exactly one.
 */
export function matchOption(items: OptionItem[], given: string | boolean | number): string | null {
  const text = String(given);
  const exact = items.find((o) => o.value === text);
  if (exact) return exact.value;
  const byLabel = items.filter((o) => norm(o.label) === norm(text) || norm(o.value) === norm(text));
  if (byLabel.length === 1) return byLabel[0]!.value;
  const said = typeof given === 'boolean' ? (given ? 'yes' : 'no') : truth(text);
  if (said) {
    const yesNo = items.filter((o) => truth(o.label) === said || truth(o.value) === said);
    if (yesNo.length === 1) return yesNo[0]!.value;
  }
  const wanted = numbers(text);
  if (wanted.length === 1) {
    const n = wanted[0]!;
    const one = items.filter((o) => {
      const own = numbers(o.label);
      return (own.length === 1 && own[0] === n) || (numbers(o.value).length === 1 && numbers(o.value)[0] === n && own.length <= 1);
    });
    if (one.length === 1) return one[0]!.value;
  }
  return null;
}

/** The request asking the model to choose one option's label for a value, or none. Labelling, not locating. */
export function pickOptionRequest(model: string, field: { key: string; label: string }, items: OptionItem[], given: string): ChatRequest {
  const labels = items.map((o) => o.label);
  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: 'A person gave an answer for a form field. Choose the one option that means what they said, or null if none does. Never guess beyond what the answer says.' },
      { role: 'user', content: JSON.stringify({ field: field.label, key: field.key, answer: given, options: labels }) },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'usher_option', strict: true, schema: { type: 'object', additionalProperties: false, required: ['option'], properties: { option: { anyOf: [{ type: 'string', enum: labels }, { type: 'null' }] } } } } },
  };
}

/** When no rule matches: the model chooses one option's label (or none), and the code maps it to its value. */
export async function pickOption(chat: ChatFn, model: string, field: { key: string; label: string }, items: OptionItem[], given: string): Promise<string | null> {
  const result = await chat(pickOptionRequest(model, field, items, given));
  const option = (parseJsonContent(result.content) as { option?: string | null } | null)?.option;
  return items.find((o) => o.label === option)?.value ?? null;
}

/** How a text field shows a date, from its placeholder, its label's "(DD/MM/YYYY)" or its pattern. */
export function dateFormatOf(field: { placeholder?: string; label?: string; constraints?: { pattern?: string } }): string | null {
  const said = `${field.placeholder ?? ''} ${field.label ?? ''}`.toUpperCase();
  const shown = /\b(DD|D)([/.\- ])(MM|M)\2(YYYY|YY)\b|\b(MM)([/.\- ])(DD)\6(YYYY)\b|\b(YYYY)-(MM)-(DD)\b|\b(MM)([/.\- ])(YYYY)\b/.exec(said)?.[0];
  if (shown) return shown;
  const pattern = field.constraints?.pattern ?? '';
  // \d{2}\/\d{2}\/\d{4} and the like: day first, the UK and European default.
  const p = /^\\d\{1?,?2\}(\\?[/.-])\\d\{1?,?2\}\1\\d\{4\}$/.exec(pattern);
  if (p) return `DD${p[1]!.replace('\\', '')}MM${p[1]!.replace('\\', '')}YYYY`;
  return null;
}

/** An ISO date (YYYY-MM-DD) in a field's own format: "DD/MM/YYYY" gives 24/10/1996. */
export function formatDate(iso: string, format: string): string {
  const [y, m, d] = iso.split('-') as [string, string, string];
  return format
    .replace(/YYYY/, y)
    .replace(/YY/, y.slice(2))
    .replace(/MM/, m)
    .replace(/DD/, d)
    .replace(/\bM\b/, String(Number(m)))
    .replace(/\bD\b/, String(Number(d)));
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * One part of an ISO date for a split field: as text ("24", "10", "1996"), or, for a select, the
 * option meaning it (by number with or without a leading zero, or by month name).
 */
export function datePart(iso: string, part: DatePart, items?: OptionItem[]): string | null {
  const [y, m, d] = iso.split('-') as [string, string, string];
  const raw = part === 'year' ? y : part === 'month' ? m : d;
  if (!items) return raw;
  const plain = String(Number(raw));
  const month = part === 'month' ? MONTHS[Number(m) - 1]! : null;
  return (
    items.find((o) => o.value === raw || o.value === plain)?.value ??
    items.find((o) => norm(o.label) === raw || norm(o.label) === plain)?.value ??
    (month ? items.find((o) => norm(o.label) === month || norm(o.label) === month.slice(0, 3))?.value : undefined) ??
    null
  );
}
