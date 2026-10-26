// What the fine-tuning export and its eval share: the example shape and the student's prompt.

import { readFile } from 'node:fs/promises';

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
}

export interface Example {
  id: string;
  input: ElementInput;
  output: { key: string; risk: string };
  meta: { source: string; path: string; form: string; model: string };
}

/** The system prompt a small model gets: the task, and the vocabulary as key, kind, default risk. */
export async function systemPrompt(): Promise<string> {
  const vocabulary = JSON.parse(await readFile(new URL('../../../spec/vocabulary.json', import.meta.url), 'utf8')) as { entries: { key: string; kind: string; default_risk: string }[] };
  return [
    'You label one element of a web form for Usher. Answer with JSON: {"key": "<vocabulary key>", "risk": "safe" | "consequential" | "needs_user"}.',
    "Use the most specific key that fits; risk is at least the key's default. When no key fits, use custom.<snake_case_name>, with the risk the element deserves. Vocabulary (key, kind, default risk):",
    ...vocabulary.entries.map((e) => `${e.key} ${e.kind} ${e.default_risk}`),
  ].join('\n');
}
