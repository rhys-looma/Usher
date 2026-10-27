// What the fine-tuning export and its eval share: the example shape and the student's prompt.

import { readFile } from 'node:fs/promises';
import { shortlist, vocabulary } from '../src/index.ts';

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

export interface Example {
  id: string;
  input: ElementInput;
  output: { key: string; risk: string };
  meta: { source: string; path: string; form: string; model: string };
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
export async function systemPrompt(options: { shortlist?: boolean; retrieval?: boolean } = {}): Promise<string> {
  const vocab = JSON.parse(await readFile(new URL('../../../spec/vocabulary.json', import.meta.url), 'utf8')) as { entries: { key: string; kind: string; default_risk: string }[] };
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
  return [...keys, ...retrieval, ...vocab.entries.map((e) => `${e.key} ${e.kind} ${e.default_risk}`)].join('\n');
}
