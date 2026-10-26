// Field and action vocabulary as data (LU-49).
//
// spec/vocabulary.md is the source of truth; spec/vocabulary.json is generated from it with
// `npm run vocabulary`, and a test keeps the two in sync.

import vocabularyJson from '../../../spec/vocabulary.json' with { type: 'json' };

export type Risk = 'safe' | 'consequential' | 'needs_user';

export const RISKS: readonly Risk[] = ['safe', 'consequential', 'needs_user'];

export interface VocabularyEntry {
  key: string;
  meaning: string;
  kind: 'field' | 'action';
  default_risk: Risk;
  sensitive: boolean;
}

export interface Vocabulary {
  usher_vocabulary: string;
  entries: VocabularyEntry[];
}

export const vocabulary = vocabularyJson as Vocabulary;

/** custom.<slug>, for meanings the vocabulary doesn't cover. */
export const CUSTOM_KEY = /^custom\.[a-z][a-z0-9_]*$/;

/** Parses the tables in vocabulary.md. Rows under the "Actions" heading are actions. */
export function parseVocabularyMarkdown(markdown: string): Vocabulary {
  const version = /^# .*draft (\d+\.\d+)/m.exec(markdown)?.[1];
  if (!version) throw new Error('vocabulary.md: no "draft x.y" version in the title');
  const entries: VocabularyEntry[] = [];
  let section = '';
  for (const line of markdown.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      section = heading[1]!.trim();
      continue;
    }
    const cells = /^\|(.+)\|\s*$/.exec(line)?.[1]!.split('|').map((c) => c.trim());
    if (!cells || cells.length !== 3 || !cells[0]!.startsWith('`')) continue;
    const [keysCell, meaning, riskCell] = cells as [string, string, string];
    const keys = [...keysCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    const flags = riskCell.split(',').map((f) => f.trim());
    const risk = flags[0] as Risk;
    if (!RISKS.includes(risk)) throw new Error(`vocabulary.md: unknown risk "${riskCell}" for ${keysCell}`);
    for (const key of keys) {
      entries.push({ key, meaning, kind: section === 'Actions' ? 'action' : 'field', default_risk: risk, sensitive: flags.includes('sensitive') });
    }
  }
  return { usher_vocabulary: version, entries };
}
