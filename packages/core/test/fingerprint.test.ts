import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fingerprint, signatureInput, similarity } from '../src/index.ts';

const exampleMap = JSON.parse(await readFile(new URL('../../../spec/examples/quote-driver.map.json', import.meta.url), 'utf8'));

test('signature input: control, lowercased normalised label, required flag', () => {
  assert.equal(signatureInput({ kind: 'field', control: 'tel', label: '  Phone   number\n(optional) ', required: false }), 'tel|phone number (optional)|0');
  assert.equal(signatureInput({ kind: 'field', control: 'select', label: 'Title', required: true }), 'select|title|1');
  // Actions are never required.
  assert.equal(signatureInput({ kind: 'action', control: 'submit', label: 'Continue', required: true }), 'submit|continue|0');
});

test('fingerprint of the example map\'s own elements matches its fingerprint', async () => {
  const elements = [
    ...exampleMap.fields.map((f: { control: string; label: string; required: boolean }) => ({ kind: 'field' as const, ...f })),
    ...exampleMap.actions.map((a: { kind: string; label: string }) => ({ kind: 'action' as const, control: a.kind, label: a.label, required: false })),
  ];
  const fp = await fingerprint(elements);
  assert.equal(fp.algo, 'usher-fp-1');
  assert.deepEqual(fp.signature, exampleMap.fingerprint.signature);
  assert.equal(fp.digest, exampleMap.fingerprint.digest);
});

test('similarity is Jaccard over signature sets', () => {
  assert.equal(similarity(['a', 'b'], ['a', 'b']), 1);
  assert.equal(similarity(['a', 'b'], ['c']), 0);
  assert.equal(similarity(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5);
  assert.equal(similarity(['a', 'a', 'b'], ['b', 'a']), 1);
  assert.equal(similarity([], []), 1);
  assert.equal(similarity(exampleMap.fingerprint, exampleMap.fingerprint.signature), 1);
});
