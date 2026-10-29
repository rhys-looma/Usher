// What the fine-tuning export and its eval share: the example shape, and the student's prompt and
// input, which live in src/compile/student.ts so the served student sees exactly what it learned.

import { studentSystemPrompt, withCandidates, type ElementInput, type TrainingExample } from '../src/index.ts';

export { withCandidates, type ElementInput };

/** One training example (src/compile/training-set.ts). */
export type Example = TrainingExample;

/** The student's prompt, as trained and as served (src/compile/student.ts). */
export async function systemPrompt(options: { shortlist?: boolean; retrieval?: boolean } = {}): Promise<string> {
  return studentSystemPrompt(options);
}
