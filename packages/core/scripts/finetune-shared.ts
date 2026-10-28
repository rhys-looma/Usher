// What the fine-tuning export and its eval share: the example shape, and the student's prompt and
// input, which live in src/compile/student.ts so the served student sees exactly what it learned.

import { studentSystemPrompt, withCandidates, type ElementInput } from '../src/index.ts';

export { withCandidates, type ElementInput };

export interface Example {
  id: string;
  input: ElementInput;
  output: { key: string; risk: string };
  meta: { source: string; path: string; form: string; model: string };
}

/** The student's prompt, as trained and as served (src/compile/student.ts). */
export async function systemPrompt(options: { shortlist?: boolean; retrieval?: boolean } = {}): Promise<string> {
  return studentSystemPrompt(options);
}
