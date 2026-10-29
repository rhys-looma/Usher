// The plan as an assistant driving its own browser reads it (spec/plan.md, "For a browser"): the
// rules in plain words at the top, what to ask the person for first, the steps in order with each
// field's key, label, options, format and where to find it, the stop points with the site's own
// wording, and how the site's token works. Built from the journey's published maps; nothing is
// compiled on request. placeValues puts the person's answers against each field, in the site's
// own format, for the assistant to type; the values live only in what it returns.

import { LOOKUP_FILLS, type UsherPlan } from './plan.ts';
import { preflight, type Profile, type PreflightProblem } from './preflight.ts';
import { dateFormatOf, datePart, formatDate, matchOption } from './values.ts';
import type { Locator } from './locators.ts';
import type { MapField, MapAction, UsherMap } from './map.ts';

export interface PlanAsk {
  key: string;
  label: string;
  control?: string;
  required: boolean;
  /** The person's own answer: the assistant asks, never guesses. */
  theirs?: true;
  options?: string[];
  more_options?: number;
  /** How to give it: a date as YYYY-MM-DD, say. */
  format?: string;
  /** Only when another answer is given: "when cover.who is partner". */
  only_if?: string;
}

export interface PlanField {
  key: string;
  label: string;
  /** Left out for a text box. */
  control?: string;
  required?: true;
  risk?: 'consequential' | 'needs_user';
  options?: string[];
  more_options?: number;
  /** For one part of a split date: which part, and how many digits. */
  part?: 'day' | 'month' | 'year';
  format?: string;
  /** Where to find it, best first: label "First name", id first_name, css … */
  find: string[];
  only_if?: string;
  /** From prepare_run: what to type or choose, in the site's own form. */
  value?: string;
  /** From prepare_run: what to do instead of typing (run a lookup, leave it to the person). */
  do?: string;
}

export interface PlanStepView {
  n: number;
  url: string;
  title: string;
  fields: PlanField[];
  lookups?: { key: string; label: string; find: string[]; run_with: string; fills: string[] }[];
  forward: { key: string; label: string; find: string[]; stop?: true } | null;
}

export interface PlanStop {
  step: number;
  key: string;
  label: string;
  /** The site's own wording, to show the person exactly as it is. */
  verbatim?: string;
  say: string;
}

export interface BrowserPlan {
  usher_plan_for: 'browser';
  site: { name: string; origin: string; joined: boolean };
  /** What Usher knows of the journey, in words: "3 of 3 pages", or "the first page; more may follow". */
  known: string;
  rules: string[];
  ask_first: PlanAsk[];
  steps: PlanStepView[];
  stops: PlanStop[];
  token: string;
  /** From prepare_run: anything in the answers the site won't accept, by key. */
  problems?: Pick<PreflightProblem, 'key' | 'label' | 'message' | 'expected'>[];
}

export interface BrowserPlanContext {
  name: string;
  joined: boolean;
  /** The site owner's rules in their own words, when it has joined and set them. */
  siteRules?: string;
}

const MAX_OPTIONS = 12;

/** Where to find an element, as short phrases a model can act on: what it reads first (label, role, placeholder), then an id; two at most. */
function finders(locators: Locator[]): string[] {
  const rank = (l: Locator) => ({ label: 0, role: 1, placeholder: 2, id: 3, name: 4, css: 5 })[l.by] ?? 6;
  return [...locators].sort((a, b) => rank(a) - rank(b)).slice(0, 2).map((l) => {
    switch (l.by) {
      case 'label':
        return `label "${l.value}"`;
      case 'role':
        return `${l.value} "${l.name ?? ''}"`;
      case 'placeholder':
        return `placeholder "${l.value}"`;
      case 'id':
        return `id ${l.value}`;
      case 'name':
        return `name ${l.value}`;
      default:
        return `css ${l.value}`;
    }
  });
}

function optionLabels(f: { options?: { items: { label: string }[]; total: number } }): Pick<PlanField, 'options' | 'more_options'> {
  if (!f.options) return {};
  const labels = f.options.items.map((o) => o.label).slice(0, MAX_OPTIONS);
  return { options: labels, ...(f.options.total > labels.length && { more_options: f.options.total - labels.length }) };
}

function onlyIf(f: Pick<MapField, 'shown_if'>): string | undefined {
  const c = f.shown_if;
  if (!c) return undefined;
  const v = Array.isArray(c.value) ? c.value.join(' or ') : c.value;
  return c.op === 'checked' ? `when ${c.field} is ticked` : c.op === 'filled' ? `when ${c.field} is given` : `when ${c.field} ${c.op === 'not_equals' ? 'is not' : 'is'} ${String(v)}`;
}

function formatOf(f: MapField): string | undefined {
  if (f.part) return f.part === 'year' ? 'the year, 4 digits' : `the ${f.part}, 2 digits`;
  if (f.control === 'date') return 'a date (the browser\'s date box)';
  const shown = dateFormatOf(f);
  if (shown) return shown;
  if (f.constraints?.format === 'date') return 'a date, DD/MM/YYYY';
  return undefined;
}

const isConsent = (key: string) => key.startsWith('consent.');
const stopSay = (risk: string) =>
  risk === 'needs_user'
    ? 'This is your user\'s to answer or do. Ask them, show them this wording exactly, and enter only what they say.'
    : 'Show this to your user word for word and wait for their yes before you go on.';

/** The rules at the top, in plain words: the site's own if it set them, then Usher's defaults. */
function rulesFor(ctx: BrowserPlanContext): string[] {
  return [
    ...(ctx.joined && ctx.siteRules ? [`${ctx.name}'s own rules: ${ctx.siteRules.trim()}`] : []),
    'Ask your user for everything in ask_first in one go, before the first page.',
    'Fill safe fields freely, in order, by the find hints.',
    'At each stop, show the wording exactly and wait for your user\'s yes. Never tick a consent yourself.',
    'Submit only after your user confirms. Never invent an answer that is theirs.',
  ];
}

/**
 * The plan for an assistant with a browser, from the journey's plan and its maps. `url` is where
 * the journey starts on the site.
 */
export function browserPlan(plan: UsherPlan, maps: Map<string, UsherMap>, ctx: BrowserPlanContext): BrowserPlan {
  const lookupFilled = new Set((plan.lookups ?? []).flatMap((l) => LOOKUP_FILLS[l.key]?.fills ?? []));
  const steps: PlanStepView[] = [];
  const stops: PlanStop[] = [];
  plan.steps.forEach((s, i) => {
    const map = maps.get(s.path)!;
    const n = i + 1;
    const fields: PlanField[] = map.fields.map((f) => {
      // A text box is the default: control is given only when it is something else.
      const out: PlanField = { key: f.key, label: f.label, ...(f.control !== 'text' && { control: f.control }), find: finders(f.locators) };
      if (f.required) out.required = true;
      if (f.risk !== 'safe') out.risk = f.risk;
      Object.assign(out, optionLabels(f));
      if (f.part) out.part = f.part;
      const format = formatOf(f);
      if (format) out.format = format;
      const cond = onlyIf(f);
      if (cond) out.only_if = cond;
      if (isConsent(f.key) || f.risk === 'needs_user') stops.push({ step: n, key: f.key, label: f.label.slice(0, 80), ...(isConsent(f.key) && { verbatim: f.label }), say: stopSay(isConsent(f.key) ? 'consequential' : f.risk) });
      return out;
    });
    const lookups = map.actions
      .filter((a) => LOOKUP_FILLS[a.key])
      .map((a) => ({ key: a.key, label: a.label, find: finders(a.locators), run_with: LOOKUP_FILLS[a.key]!.input, fills: LOOKUP_FILLS[a.key]!.fills.filter((k) => map.fields.some((f) => f.key === k)) }));
    const advance = s.advance ? map.actions.find((a) => a.id === s.advance!.id) : undefined;
    const forward: PlanStepView['forward'] = advance ? { key: advance.key, label: advance.label, find: finders(advance.locators), ...(advance.risk !== 'safe' && { stop: true as const }) } : null;
    if (advance && advance.risk !== 'safe') stops.push({ step: n, key: advance.key, label: advance.label, say: advance.risk === 'needs_user' ? stopSay('needs_user') : `Before pressing "${advance.label}", tell your user what it does and wait for their yes.` });
    steps.push({ n, url: `${plan.origin}${s.path}`, title: map.form.purpose, fields, ...(lookups.length && { lookups }), forward });
  });
  // Ask first: what the person must give, across the journey; not what a lookup fills, not consents.
  const ask_first: PlanAsk[] = plan.inputs
    .filter((i) => (i.required || i.risk === 'needs_user') && !isConsent(i.key) && !lookupFilled.has(i.key))
    .map((i) => {
      const ask: PlanAsk = { key: i.key, label: i.label, ...(i.control !== 'text' && { control: i.control }), required: i.required };
      if (i.risk === 'needs_user') ask.theirs = true;
      Object.assign(ask, optionLabels(i));
      if (i.control === 'date' || i.constraints?.format === 'date') ask.format = 'a date, e.g. 14 March 1988';
      const cond = onlyIf(i);
      if (cond) ask.only_if = cond;
      return ask;
    });
  const known = plan.complete ? `${plan.steps.length} of ${plan.steps.length} pages, to the end` : plan.steps.length === 1 ? 'the first page only; more may follow, and you may need to ask your user again there' : `${plan.steps.length} pages so far; more may follow`;
  return {
    usher_plan_for: 'browser',
    site: { name: ctx.name, origin: plan.origin, joined: ctx.joined },
    known,
    rules: rulesFor(ctx),
    ask_first,
    steps,
    stops,
    token: ctx.joined
      ? `${ctx.name} has joined Usher: call knock with the first step's url (prepare_run does it for you once your user has confirmed) and open the entry_url it returns, which carries the token for this session. The site refuses the final step without it.`
      : `${ctx.name} has not joined Usher: there is no token. Usher mapped it read-only; you fill it in your user's own browser session. Usher's defaults are the rules.`,
  };
}

/**
 * The plan with the person's answers in place: each value against its field, in the site's form
 * (options by their label, dates as the site wants them, split dates by part), lookups marked to run
 * with their input, and problems by key for anything the site won't take. Nothing is kept.
 */
export function placeValues(view: BrowserPlan, plan: UsherPlan, maps: Map<string, UsherMap>, given: Profile): BrowserPlan {
  const checked = preflight(plan.inputs, given);
  const values = checked.normalised;
  const fieldOf = (step: PlanStepView, key: string, part?: string): MapField | undefined =>
    maps.get(new URL(step.url).pathname)?.fields.find((f) => f.key === key && (part ? f.part === part : true));
  const steps = view.steps.map((step) => ({
    ...step,
    fields: step.fields.map((pf) => {
      const out: PlanField = { ...pf };
      const raw = values[pf.key];
      const field = fieldOf(step, pf.key, pf.part);
      if (isConsent(pf.key)) {
        out.do = 'stop: show the wording to your user; tick it only after they say yes';
        return out;
      }
      if (step.lookups?.some((l) => l.fills.includes(pf.key)) && raw === undefined) {
        out.do = 'filled by the lookup on this page; if it lists results, ask your user which one';
        return out;
      }
      if (raw === undefined) return out;
      if (pf.risk === 'needs_user') out.do = 'their answer: enter it only as they gave it, and confirm it with them at the stop';
      const iso = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
      if (field?.part && iso) out.value = datePart(iso, field.part, field.options?.items) ?? iso;
      else if (iso && field && field.control !== 'date') out.value = formatDate(iso, dateFormatOf(field) ?? 'DD/MM/YYYY');
      else if (field?.options) {
        const value = matchOption(field.options.items, raw);
        out.value = field.options.items.find((o) => o.value === value)?.label ?? String(raw);
      } else if (typeof raw === 'boolean') out.value = raw ? 'tick' : 'leave unticked';
      else out.value = String(raw);
      return out;
    }),
    ...(step.lookups && {
      lookups: step.lookups.map((l) => (values[l.run_with] !== undefined ? { ...l, run_with: `${l.run_with} = ${String(values[l.run_with])}` } : l)),
    }),
  }));
  // A consent is a stop the person confirms, not an answer to give: never a missing value.
  const problems = checked.problems.filter((p) => !(p.problem === 'missing' && isConsent(p.key)));
  return { ...view, steps, ...(problems.length && { problems: problems.map(({ key, label, message, expected }) => ({ key, label, message, ...(expected && { expected }) })) }) };
}

/** The keys of a plan's stop points the person can confirm up front (consents and the final step). */
export function confirmableStops(view: BrowserPlan): string[] {
  return view.stops.filter((s) => s.key.startsWith('consent.') || ['form.submit', 'form.purchase', 'form.apply'].includes(s.key)).map((s) => s.key);
}

export type { MapAction };
