// Pre-flight validation (LU-40): before an agent touches a page, check every value it will enter
// against the map (or a plan's inputs): required fields present, options matched by value or by
// label, pattern, min, max, length and format. Problems come back by semantic key.

import type { Options } from './extract.ts';
import type { MapConstraints, MapField } from './map.ts';
import { isDateKey, matchOption } from './values.ts';

export type ProfileValue = string | boolean;
export type Profile = Record<string, ProfileValue>;

/** What preflight needs to know about a field: a map field or a plan input. */
export interface FieldSpec {
  key: string;
  label: string;
  control: string;
  required: boolean;
  risk: string;
  constraints?: MapConstraints;
  options?: Options;
  shown_if?: MapField['shown_if'];
  part?: MapField['part'];
}

export interface PreflightProblem {
  key: string;
  label: string;
  problem: 'missing' | 'not_an_option' | 'pattern' | 'too_small' | 'too_large' | 'too_short' | 'too_long' | 'format' | 'type';
  message: string;
  /** What would be accepted, in words (option labels, a format). */
  expected?: string;
}

export interface PreflightResult {
  ok: boolean;
  problems: PreflightProblem[];
  /** The profile with option labels replaced by option values, ready to fill. */
  normalised: Profile;
}

function conditionHolds(field: FieldSpec, profile: Profile): boolean {
  const c = field.shown_if;
  if (!c) return true;
  const answer = profile[c.field];
  switch (c.op) {
    case 'equals':
      return answer === c.value;
    case 'not_equals':
      return answer !== undefined && answer !== c.value;
    case 'in':
      return Array.isArray(c.value) && typeof answer === 'string' && c.value.includes(answer);
    case 'checked':
      return answer === true;
    case 'filled':
      return answer !== undefined && answer !== '';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Checks the values for these fields. Fields the user must do themselves (needs_user) are not the
 * agent's to fill and are skipped, except that a required one must be present for the user to use.
 */
export function preflight(fields: FieldSpec[], profile: Profile): PreflightResult {
  const problems: PreflightProblem[] = [];
  const normalised: Profile = { ...profile };
  const say = (f: FieldSpec, problem: PreflightProblem['problem'], message: string, expected?: string) =>
    problems.push({ key: f.key, label: f.label, problem, message, ...(expected && { expected }) });

  for (const f of fields) {
    if (!conditionHolds(f, normalised)) continue;
    const value = normalised[f.key];
    if (value === undefined || value === '') {
      if (f.required) say(f, 'missing', `"${f.label}" is required and the profile has no ${f.key}.`);
      continue;
    }
    if (f.control === 'checkbox') {
      if (typeof value !== 'boolean') say(f, 'type', `"${f.label}" is a tick box: use true or false.`);
      else if (f.required && value === false && f.risk !== 'needs_user') say(f, 'missing', `"${f.label}" must be ticked.`);
      continue;
    }
    const text = String(value);
    // A search box takes whatever the user wants to search for: only its length limit applies.
    if (f.key === 'search.query') {
      const max = f.constraints?.max_length;
      if (max !== undefined && text.length > max) say(f, 'too_long', `"${f.label}" takes at most ${max} characters.`);
      continue;
    }
    const c = f.constraints ?? {};
    // A date is YYYY-MM-DD whatever the site shows (vocabulary, "Values"). A text box in the site's
    // own format, or a date split into parts, is checked as a date; its pattern and length are for
    // the form the fill types, not for this value.
    const date = f.control === 'date' || c.format === 'date' || Boolean(f.part) || isDateKey(f.key);
    if (date) {
      if (!ISO_DATE.test(text) || Number.isNaN(Date.parse(text))) {
        say(f, 'format', `"${text}" is not a date in the form YYYY-MM-DD for "${f.label}".`, 'YYYY-MM-DD');
        continue;
      }
      if (f.control !== 'date') continue;
    }
    if (f.options) {
      // The option the value means: by value, label, yes/no, or the one number it carries.
      const matched = matchOption(f.options.items, value);
      if (matched !== null) {
        normalised[f.key] = matched;
        continue;
      }
      // Only the first options are in the map; a value beyond them can't be checked here.
      if (f.options.truncated) continue;
      say(f, 'not_an_option', `"${text}" is not an option for "${f.label}".`, f.options.items.map((o) => o.label).join(', '));
      continue;
    }
    if ((f.control === 'email' || c.format === 'email') && !EMAIL.test(text)) say(f, 'format', `"${f.label}" needs an email address.`, 'name@example.com');
    if (c.pattern && !new RegExp(`^(?:${c.pattern})$`).test(text)) say(f, 'pattern', `"${f.label}" doesn't match the format the site expects.`, `pattern ${c.pattern}`);
    if (c.min_length !== undefined && text.length < c.min_length) say(f, 'too_short', `"${f.label}" needs at least ${c.min_length} characters.`);
    if (c.max_length !== undefined && text.length > c.max_length) say(f, 'too_long', `"${f.label}" takes at most ${c.max_length} characters.`);
    const numeric = f.control === 'number' || typeof c.min === 'number' || typeof c.max === 'number';
    const comparable = numeric ? Number(text) : text;
    if (numeric && Number.isNaN(comparable)) say(f, 'type', `"${f.label}" needs a number.`);
    else {
      if (c.min !== undefined && comparable < (numeric ? Number(c.min) : String(c.min))) say(f, 'too_small', `"${f.label}" must be at least ${c.min}.`);
      if (c.max !== undefined && comparable > (numeric ? Number(c.max) : String(c.max))) say(f, 'too_large', `"${f.label}" must be at most ${c.max}.`);
    }
  }
  return { ok: problems.length === 0, problems, normalised };
}
