import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseVocabularyMarkdown, vocabulary } from '../src/index.ts';

const spec = new URL('../../../spec/', import.meta.url);

test('spec/vocabulary.json is in sync with spec/vocabulary.md (run `npm run vocabulary` if not)', async () => {
  const parsed = parseVocabularyMarkdown(await readFile(new URL('vocabulary.md', spec), 'utf8'));
  const json = JSON.parse(await readFile(new URL('vocabulary.json', spec), 'utf8'));
  assert.deepEqual(json, parsed);
  assert.deepEqual(vocabulary, parsed);
});

test('vocabulary entries are well formed', () => {
  const keys = vocabulary.entries.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, 'keys are unique');
  for (const e of vocabulary.entries) {
    assert.match(e.key, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, e.key);
    assert.ok(!e.key.startsWith('custom.'), e.key);
    assert.ok(e.meaning.length > 0, e.key);
    if (e.sensitive) assert.equal(e.default_risk, 'needs_user', `${e.key} is sensitive`);
  }
});

test('rows are split, kinds and flags read from the markdown', () => {
  const get = (key: string) => vocabulary.entries.find((e) => e.key === key);
  assert.deepEqual(get('address.line2'), { key: 'address.line2', meaning: 'Address lines', kind: 'field', default_risk: 'safe', sensitive: false });
  assert.deepEqual(get('payment.cvc'), { key: 'payment.cvc', meaning: 'Card details', kind: 'field', default_risk: 'needs_user', sensitive: true });
  assert.deepEqual(get('consent.declaration')?.default_risk, 'needs_user');
  assert.deepEqual(get('form.submit'), { key: 'form.submit', meaning: 'Submit the form (request a quote, send a message, make a booking)', kind: 'action', default_risk: 'consequential', sensitive: false });
  assert.equal(get('nav.next')?.kind, 'action');
});
