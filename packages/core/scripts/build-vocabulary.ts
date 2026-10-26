// Regenerates spec/vocabulary.json from spec/vocabulary.md.

import { readFile, writeFile } from 'node:fs/promises';
import { parseVocabularyMarkdown } from '../src/vocabulary.ts';

const spec = new URL('../../../spec/', import.meta.url);
const vocabulary = parseVocabularyMarkdown(await readFile(new URL('vocabulary.md', spec), 'utf8'));
await writeFile(new URL('vocabulary.json', spec), `${JSON.stringify(vocabulary, null, 2)}\n`);
console.log(`spec/vocabulary.json: ${vocabulary.entries.length} entries`);
