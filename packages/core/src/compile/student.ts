// The student: a small model tuned on Muse Spark's labels (docs/finetune.md), served behind an
// OpenAI-compatible endpoint (deploy/finetune/serve.py). It labels one element at a time with the
// exact prompt and input it was trained on, so both live here: the fine-tuning export and eval
// build their examples with these same functions.
//
// It is used only as the classifier's second opinion on risk, behind USHER_STUDENT_MODEL, and the
// stricter risk is always kept (classify.ts reconcile): a student that under-calls risk can't make a
// map less safe. Off unless the flag is set.

import type { ExtractedElement } from '../extract.ts';
import { RISKS, vocabulary, type Risk } from '../vocabulary.ts';
import type { Classification, RiskOpinion } from './classify.ts';
import { costUsd, parseJsonContent, type ChatFn, type ChatRequest, type Usage } from './model.ts';
import { shortlist } from './shortlist.ts';

export interface ElementInput {
  label: string;
  kind: string;
  control: string | null;
  required: boolean;
  /** "6 options: Mr, Mrs, Miss, Ms, Mx, Dr" (up to 8 named). */
  options: string | null;
  constraints: Record<string, unknown> | null;
  form_purpose: string;
  page_title: string;
  /** The elements before and after it, as "control: label". */
  neighbours: { before: string[]; after: string[] };
  /** The short list: the closest vocabulary keys, best first, as "key: meaning". */
  candidates?: string[];
  /** Retrieval few-shot: the nearest labelled examples from training, as "control: label → key (risk)". */
  examples?: string[];
}

/** The element with its short list added: what the model chooses from. */
export function withCandidates(input: ElementInput): ElementInput {
  const meaning = new Map(vocabulary.entries.map((e) => [e.key, e.meaning]));
  const options = input.options?.replace(/^\d+ options?: /, '').split(', ') ?? [];
  const keys = shortlist({ kind: input.kind, control: input.control, label: input.label, options });
  return { ...input, candidates: keys.map((k) => `${k}: ${meaning.get(k)}`) };
}

/**
 * The system prompt a small model gets: the task, and the vocabulary as key, kind, default risk.
 * With the short list, the element carries candidates and the model chooses among them.
 */
export function studentSystemPrompt(options: { shortlist?: boolean; retrieval?: boolean } = {}): string {
  const keys = options.shortlist
    ? [
        'You label one element of a web form for Usher. Answer with JSON: {"key": "<vocabulary key>", "risk": "safe" | "consequential" | "needs_user"}.',
        'The element comes with candidates: the vocabulary keys whose meaning is closest to it, best first, found by code. Choose the most specific candidate whose meaning fits; the first is not always right. Never invent a custom key when a vocabulary key fits. nav.next and form.submit move the form itself forward; a link that leads away from the form, to another page or service, is neither. Only when no candidate fits, use custom.<snake_case_name>, with the risk the element deserves.',
        "Risk is at least the key's default. Vocabulary (key, kind, default risk):",
      ]
    : [
        'You label one element of a web form for Usher. Answer with JSON: {"key": "<vocabulary key>", "risk": "safe" | "consequential" | "needs_user"}.',
        "Use the most specific key that fits; risk is at least the key's default. When no key fits, use custom.<snake_case_name>, with the risk the element deserves. Vocabulary (key, kind, default risk):",
      ];
  const retrieval = options.retrieval ? ['The element also comes with examples: the nearest labelled elements from other sites, as "control: label → key (risk)". Where an example means the same thing, give the same key and risk.'] : [];
  return [...keys, ...retrieval, ...vocabulary.entries.map((e) => `${e.key} ${e.kind} ${e.default_risk}`)].join('\n');
}

/** "6 options: Mr, Mrs, …": the options as the training examples summarise them. */
export function optionsSummary(options: { items: { label: string }[]; total: number } | undefined): string | null {
  if (!options) return null;
  const names = options.items.slice(0, 8).map((o) => o.label);
  return `${options.total} options: ${names.join(', ')}${options.total > names.length ? ', …' : ''}`;
}

/** One extracted element as the student sees it, with its neighbours on the page. */
export function studentInput(elements: ExtractedElement[], i: number, form: { purpose: string; title: string }): ElementInput {
  const e = elements[i]!;
  const describe = (x: ExtractedElement) => `${x.control ?? x.kind}: ${x.label}`;
  return withCandidates({
    label: e.label,
    kind: e.kind,
    control: e.control ?? null,
    required: e.required ?? false,
    options: optionsSummary(e.options),
    constraints: (e.constraints as Record<string, unknown> | undefined) ?? null,
    form_purpose: form.purpose,
    page_title: form.title,
    neighbours: { before: elements.slice(Math.max(0, i - 2), i).map(describe), after: elements.slice(i + 1, i + 3).map(describe) },
  });
}

export function studentRequest(model: string, input: ElementInput): ChatRequest {
  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: studentSystemPrompt({ shortlist: true }) },
      { role: 'user', content: JSON.stringify(input) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'usher_element', strict: true, schema: { type: 'object', additionalProperties: false, required: ['key', 'risk'], properties: { key: { type: 'string' }, risk: { type: 'string', enum: [...RISKS] } } } },
    },
  };
}

/**
 * The student's opinion on each element's risk, one call per element (a few at a time). Shaped like
 * the open-weights classifier's, so the compiler reconciles it the same way: stricter risk kept.
 */
export async function classifyWithStudent(chat: ChatFn, model: string, form: { purpose: string; title: string }, elements: ExtractedElement[], concurrency = 4): Promise<Classification> {
  const opinions: RiskOpinion[] = new Array(elements.length);
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 };
  let latency = 0;
  let next = 0;
  const worker = async () => {
    while (next < elements.length) {
      const i = next++;
      const result = await chat(studentRequest(model, studentInput(elements, i, form)));
      const answer = parseJsonContent(result.content) as { key?: unknown; risk?: unknown };
      if (!RISKS.includes(answer.risk as Risk)) throw new Error(`The student gave no valid risk for ${elements[i]!.id}.`);
      opinions[i] = { id: elements[i]!.id, risk: answer.risk as Risk, reason: `the tuned labeller reads it as ${typeof answer.key === 'string' ? answer.key : 'unknown'}` };
      for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += result.usage[k];
      latency = Math.max(latency, result.latency_ms);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, elements.length) }, worker));
  return { opinions, model, usage, cost_usd: costUsd(model, usage), latency_ms: latency };
}

/** The student's model name when USHER_STUDENT_MODEL is set (and its endpoint), else null: off. */
export function studentModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const model = env.USHER_STUDENT_MODEL?.trim();
  return model && env.USHER_STUDENT_URL?.trim() ? model : null;
}
