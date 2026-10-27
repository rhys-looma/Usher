// Retrieval few-shot, the no-training path for Muse Spark Open: before it labels or classifies an
// element, the nearest labelled examples from the exported dataset (data/finetune/train.jsonl, by
// default) go into its prompt. Nearest by the words of the label and options, with the same kind
// and preferably the same control. Examples hold structure only: a label, a control, a key, a risk.

import { readFile } from 'node:fs/promises';
import { words } from './shortlist.ts';

export interface LabelledExample {
  label: string;
  kind: string;
  control: string | null;
  key: string;
  risk: string;
}

export interface ExampleQuery {
  label: string;
  kind: string;
  control?: string | null;
  options?: string[];
}

export class ExampleIndex {
  private readonly indexed: { example: LabelledExample; words: Set<string> }[];

  constructor(examples: LabelledExample[]) {
    const seen = new Set<string>();
    this.indexed = examples
      .filter((e) => {
        const id = `${e.kind}|${e.label.toLowerCase()}|${e.key}`;
        return !seen.has(id) && seen.add(id);
      })
      .map((example) => ({ example, words: words(example.label) }));
  }

  get size(): number {
    return this.indexed.length;
  }

  /** Reads the fine-tuning export's format: lines of { input: { label, kind, control }, output: { key, risk } }. */
  static async fromFile(path: string): Promise<ExampleIndex> {
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    return new ExampleIndex(
      lines.map((l) => {
        const { input, output } = JSON.parse(l) as { input: { label: string; kind: string; control: string | null }; output: { key: string; risk: string } };
        return { label: input.label, kind: input.kind, control: input.control, key: output.key, risk: output.risk };
      }),
    );
  }

  /**
   * Up to k nearest examples of the same kind that share a word with it: Jaccard on the words, plus
   * a little for the same control. None when nothing shares a word: unrelated examples mislead.
   */
  nearest(query: ExampleQuery, k = 5): LabelledExample[] {
    const q = words(`${query.label} ${(query.options ?? []).slice(0, 5).join(' ')}`);
    return this.indexed
      .filter((e) => e.example.kind === query.kind)
      .map((e, order) => {
        const shared = [...q].filter((w) => e.words.has(w)).length;
        const union = new Set([...q, ...e.words]).size || 1;
        return { example: e.example, shared, score: shared / union + (query.control && e.example.control === query.control ? 0.1 : 0), order };
      })
      .filter((s) => s.shared > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, k)
      .map((s) => s.example);
  }
}

/** An example as a line in a prompt. */
export const exampleLine = (e: LabelledExample): string => `${e.control ?? e.kind}: ${JSON.stringify(e.label.slice(0, 80))} → ${e.key} (${e.risk})`;

/**
 * The examples for a whole form: the nearest few for each element, without repeats, at most `cap`.
 * For a prompt section that shows how other sites' elements were labelled.
 */
export function examplesForForm(index: ExampleIndex, elements: ExampleQuery[], perElement = 5, cap = 40): LabelledExample[] {
  const out = new Map<string, LabelledExample>();
  for (let rank = 0; rank < perElement; rank++) {
    for (const el of elements) {
      const e = index.nearest(el, perElement)[rank];
      if (e) out.set(`${e.kind}|${e.label}|${e.key}`, e);
      if (out.size >= cap) return [...out.values()];
    }
  }
  return [...out.values()];
}
