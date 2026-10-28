// Vote mode: up to three labelling runs, majority per element for key and risk. The first run labels
// the whole page; the second asks again only about the contested elements (more than one strong
// short-list candidate, or labelled consequential or needs_user); the third only about those the
// first two disagree on, or that either labelled risky. Elements every run agrees on are never asked
// again. Ties: the stricter risk; for keys the short list's top candidate, else custom.<slug>. What
// is kept per element is counts only: how many runs saw it, how many agreed on the key and the risk.

import type { ScannedForm } from '../inpage.ts';
import { validateLabels, type ResolvedLabel } from '../labels.ts';
import { RISKS, type Risk } from '../vocabulary.ts';
import { parseJsonContent, type ChatFn, type ChatMessage, type ChatRequest, type Usage } from './model.ts';
import { compactExtraction, labelsSchema, systemPrompt, userPrompt } from './prompt.ts';
import { shortlistScored } from './shortlist.ts';

/** Per element: runs that labelled it, and how many of those gave the key and the risk kept. */
export interface ElementAgreement {
  runs: number;
  key: number;
  risk: number;
}

export interface VoteOutcome {
  /** The labels to keep, as the model's raw shape, with key and risk decided by the vote. */
  labels: unknown;
  runs: number;
  agreement: Record<string, ElementAgreement>;
  /** Elements where the runs disagreed, for the log. */
  disagreements: { id: string; keys: string[]; risks: Risk[] }[];
  extra: { usage: Usage; latency_ms: number; request: ChatRequest; asked: string[]; ok: boolean }[];
}

/** Temperature for the runs after the first, so they can disagree. */
const VOTE_TEMPERATURE = 0.6;

/** Short-list candidates scoring close to the best: more than one means the meaning is contested. */
export function strongCandidates(el: ScannedForm['elements'][number]): string[] {
  const scored = shortlistScored({ kind: el.kind, control: el.control, label: el.label, ...(el.options && { options: el.options.items.map((o) => o.label) }), ...(el.placeholder && { placeholder: el.placeholder }), ...(el.autocomplete && { autocomplete: el.autocomplete }) });
  const top = scored[0]?.score ?? 0;
  return scored.filter((s) => s.score >= Math.max(1.5, top * 0.75)).map((s) => s.key);
}

const stricter = (a: Risk, b: Risk): Risk => (RISKS.indexOf(a) >= RISKS.indexOf(b) ? a : b);
const slug = (label: string) => `custom.${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'n$1').slice(0, 40) || 'field'}`;

/** The most common value; null on a tie between the most common. */
function majority<T>(xs: T[]): { value: T | null; count: number; tied: T[] } {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  const best = Math.max(...counts.values());
  const tied = [...counts].filter(([, n]) => n === best).map(([v]) => v);
  return { value: tied.length === 1 ? tied[0]! : null, count: best, tied };
}

export async function vote(input: {
  chat: ChatFn;
  model: string;
  form: ScannedForm;
  page: { path: string; title: string };
  image: string;
  /** The first run: its raw labels and their validated elements. */
  first: { raw: unknown; elements: ResolvedLabel[] };
  maxRuns?: number;
}): Promise<VoteOutcome> {
  const maxRuns = Math.min(3, Math.max(1, input.maxRuns ?? 3));
  const byId = new Map(input.form.elements.map((e) => [e.id, e]));
  const runs = new Map<string, { key: string; risk: Risk }[]>(input.first.elements.map((l) => [l.id, [{ key: l.key, risk: l.risk }]]));
  const extra: VoteOutcome['extra'] = [];

  /** Asks again about these elements only, the page's screenshot as before. */
  async function ask(ids: string[]): Promise<void> {
    const sub: ScannedForm = { ...input.form, elements: input.form.elements.filter((e) => ids.includes(e.id)) };
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: [{ type: 'text', text: userPrompt(compactExtraction(sub, input.page), []) }, { type: 'image_url', image_url: { url: `data:image/png;base64,${input.image}` } }] },
    ];
    const request: ChatRequest = { model: input.model, temperature: VOTE_TEMPERATURE, messages, response_format: { type: 'json_schema', json_schema: { name: 'usher_labels', strict: true, schema: labelsSchema(sub) } } };
    // A run that fails (the provider, the network, a budget) doesn't vote; the first run stands.
    const result = await input.chat(request).catch(() => null);
    if (!result) {
      extra.push({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 }, latency_ms: 0, request, asked: ids, ok: false });
      return;
    }
    let ok = false;
    try {
      const validation = validateLabels(parseJsonContent(result.content), sub.elements);
      if (validation.ok) {
        ok = true;
        for (const l of validation.labels.elements) runs.get(l.id)?.push({ key: l.key, risk: l.risk });
      }
    } catch {
      // A run that doesn't validate doesn't vote.
    }
    extra.push({ usage: result.usage, latency_ms: result.latency_ms, request, asked: ids, ok });
  }

  const risky = (id: string) => runs.get(id)!.some((r) => r.risk !== 'safe');
  const contested = input.first.elements.filter((l) => strongCandidates(byId.get(l.id)!).length > 1 || risky(l.id)).map((l) => l.id);
  if (maxRuns >= 2 && contested.length) await ask(contested);
  const split = (id: string) => new Set(runs.get(id)!.map((r) => `${r.key}|${r.risk}`)).size > 1;
  const third = contested.filter((id) => split(id) || risky(id));
  if (maxRuns >= 3 && third.length) await ask(third);

  const agreement: Record<string, ElementAgreement> = {};
  const disagreements: VoteOutcome['disagreements'] = [];
  const decided = new Map<string, { key: string; risk: Risk }>();
  for (const [id, votes] of runs) {
    const keys = majority(votes.map((v) => v.key));
    const risks = majority(votes.map((v) => v.risk));
    const top = strongCandidates(byId.get(id)!)[0] ?? shortlistScored({ kind: byId.get(id)!.kind, control: byId.get(id)!.control, label: byId.get(id)!.label })[0]?.key;
    const key = keys.value ?? (top && keys.tied.includes(top) ? top : slug(byId.get(id)!.label));
    const risk = risks.value ?? risks.tied.reduce(stricter);
    decided.set(id, { key, risk });
    agreement[id] = { runs: votes.length, key: votes.filter((v) => v.key === key).length, risk: votes.filter((v) => v.risk === risk).length };
    if (new Set(votes.map((v) => `${v.key}|${v.risk}`)).size > 1) disagreements.push({ id, keys: votes.map((v) => v.key), risks: votes.map((v) => v.risk) });
  }

  // The decided labels must still validate together (one key per field, parts of one date): any
  // element whose decision breaks that goes back to the first run's answer.
  const withDecisions = (keep: Set<string>) => {
    const raw = structuredClone(input.first.raw) as { elements: { id: string; key: string; risk: Risk }[] };
    raw.elements = raw.elements.map((e) => (keep.has(e.id) && decided.has(e.id) ? { ...e, ...decided.get(e.id)! } : e));
    return raw;
  };
  let keep = new Set(decided.keys());
  let labels: unknown = withDecisions(keep);
  const check = validateLabels(labels, input.form.elements);
  if (!check.ok) {
    const broken = new Set(check.errors.map((e) => /elements\[(\d+)\]/.exec(e.path)?.[1]).filter((i): i is string => i !== undefined).map((i) => (labels as { elements: { id: string }[] }).elements[Number(i)]!.id));
    keep = new Set([...keep].filter((id) => !broken.has(id)));
    labels = withDecisions(keep);
    if (!validateLabels(labels, input.form.elements).ok) labels = input.first.raw;
    for (const id of broken) {
      const first = runs.get(id)![0]!;
      const votes = runs.get(id)!;
      agreement[id] = { runs: votes.length, key: votes.filter((v) => v.key === first.key).length, risk: votes.filter((v) => v.risk === first.risk).length };
    }
  }
  return { labels, runs: 1 + extra.filter((r) => r.ok).length, agreement, disagreements, extra };
}
