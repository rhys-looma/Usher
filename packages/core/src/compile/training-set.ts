// The student's training set, shared by the fine-tuning export (scripts/finetune-export.ts) and the
// registry's automatic retraining (packages/registry/src/trainer.ts), so both build the same
// examples: an owner's correction becomes an example, owners' answers win over any number of model
// runs, the set is split into train and eval by form, and each example becomes a chat row.
// Structure only: labels, options and neighbouring labels, never anything a person typed.

import { createHash } from 'node:crypto';
import { studentSystemPrompt, withCandidates, type ElementInput } from './student.ts';

export interface TrainingExample {
  id: string;
  input: ElementInput;
  output: { key: string; risk: string };
  /** model is the teacher's name, or 'owner' for an owner's correction. */
  meta: { source: string; path: string; form: string; model: string };
}

/** An owner's correction as the registry logs it (walkthrough.ts correct). */
export interface CorrectionRecord {
  ts?: string;
  task: 'correction';
  owner_verified: true;
  url: string;
  path: string;
  page_title?: string;
  form_purpose?: string;
  element: { kind: string; control: string | null; label: string; required: boolean; options: string | null; constraints: Record<string, unknown> | null; neighbours: { before: string[]; after: string[] } };
  owner: { key: string; risk: string };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Ports change from run to run; the mock site is one source. */
export function exampleSource(url: URL): string {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? 'mock-quote-site' : url.hostname;
}

/** The example's id: its structure and neighbours, not the purpose and title a model wrote (they vary in wording). */
export function exampleId(input: ElementInput): string {
  const { form_purpose: _p, page_title: _t, candidates: _c, examples: _e, ...structure } = input;
  return sha(JSON.stringify(structure)).slice(0, 16);
}

/** An owner's correction as a training example, or null for an entry logged without its element. */
export function correctionExample(c: CorrectionRecord): TrainingExample | null {
  if (c.task !== 'correction' || !c.owner_verified || !c.element?.neighbours) return null;
  const url = new URL(c.url);
  const e = c.element;
  const input = withCandidates({ label: e.label, kind: e.kind, control: e.control, required: e.required, options: e.options, constraints: e.constraints, form_purpose: c.form_purpose ?? '', page_title: c.page_title ?? '', neighbours: e.neighbours });
  return { id: exampleId(input), input, output: { key: c.owner.key, risk: c.owner.risk }, meta: { source: exampleSource(url), path: c.path, form: `${exampleSource(url)}${c.path}`, model: 'owner' } };
}

export const isOwnerVerified = (ex: TrainingExample) => ex.meta.model === 'owner';

/**
 * One example per element. An owner's answer wins outright (the latest, if there were several);
 * otherwise the most common answer. Returns how many elements had conflicting answers.
 */
export function dedupeExamples(examples: TrainingExample[]): { unique: TrainingExample[]; conflicts: number } {
  const byInput = new Map<string, TrainingExample[]>();
  for (const ex of examples) byInput.set(ex.id, [...(byInput.get(ex.id) ?? []), ex]);
  let conflicts = 0;
  const unique: TrainingExample[] = [];
  for (const group of byInput.values()) {
    const owner = group.filter(isOwnerVerified).at(-1);
    if (owner) {
      if (group.some((ex) => JSON.stringify(ex.output) !== JSON.stringify(owner.output))) conflicts++;
      unique.push(owner);
      continue;
    }
    const votes = new Map<string, number>();
    for (const ex of group) votes.set(JSON.stringify(ex.output), (votes.get(JSON.stringify(ex.output)) ?? 0) + 1);
    if (votes.size > 1) conflicts++;
    const best = [...votes].sort((a, b) => b[1] - a[1])[0]![0];
    unique.push(group.find((ex) => JSON.stringify(ex.output) === best)!);
  }
  return { unique, conflicts };
}

/**
 * Train and eval by form, so no eval form is seen in training: forms in a fixed order (by hash) go
 * to eval until it holds the share asked for. The same examples always give the same split.
 */
export function splitByForm(unique: TrainingExample[], evalShare: number): { train: TrainingExample[]; eval: TrainingExample[] } {
  const forms = [...new Set(unique.map((ex) => ex.meta.form))].sort((a, b) => sha(a).localeCompare(sha(b)));
  const size = new Map<string, number>();
  for (const ex of unique) size.set(ex.meta.form, (size.get(ex.meta.form) ?? 0) + 1);
  const evalForms = new Set<string>();
  let inEval = 0;
  for (const form of forms) {
    if (inEval >= evalShare * unique.length) break;
    // Skip a form that would push eval far past its share; a later, smaller one may fit.
    if (evalForms.size && inEval + size.get(form)! > evalShare * unique.length * 1.5) continue;
    evalForms.add(form);
    inEval += size.get(form)!;
  }
  return { train: unique.filter((ex) => !evalForms.has(ex.meta.form)), eval: unique.filter((ex) => evalForms.has(ex.meta.form)) };
}

/** Chat format for supervised fine-tuning: system, user, assistant, one JSON object per line. */
export function chatRow(ex: TrainingExample, system = studentSystemPrompt({ shortlist: true })): string {
  return JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(ex.input) }, { role: 'assistant', content: JSON.stringify(ex.output) }] });
}
