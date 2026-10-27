import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExampleIndex, classifierRequest, exampleLine, examplesForForm, userPrompt, type ExtractedElement } from '../src/index.ts';

const index = new ExampleIndex([
  { label: 'Date of birth', kind: 'field', control: 'date', key: 'person.dob', risk: 'safe' },
  { label: 'Your date of birth', kind: 'field', control: 'text', key: 'person.dob', risk: 'safe' },
  { label: 'Date of birth', kind: 'field', control: 'date', key: 'person.dob', risk: 'safe' },
  { label: 'How did you hear about us?', kind: 'field', control: 'select', key: 'custom.how_did_you_hear', risk: 'safe' },
  { label: 'Extra cheese', kind: 'field', control: 'checkbox', key: 'custom.pizza_topping_extra_cheese', risk: 'safe' },
  { label: 'Get my quote', kind: 'action', control: 'submit', key: 'form.submit', risk: 'consequential' },
]);

test('retrieval: nearest by shared words and kind, repeats merged, nothing unrelated', () => {
  assert.equal(index.size, 5, 'the repeated example is merged');
  assert.deepEqual(index.nearest({ label: 'Date of birth', kind: 'field', control: 'date' }).map((e) => e.control), ['date', 'text'], 'the same control first');
  assert.deepEqual(index.nearest({ label: 'Where did you hear of us', kind: 'field' }).map((e) => e.key), ['custom.how_did_you_hear']);
  assert.deepEqual(index.nearest({ label: 'I confirm the details are true', kind: 'field', control: 'checkbox' }), [], 'no shared word: no examples');
  assert.deepEqual(index.nearest({ label: 'Get my quote', kind: 'field' }), [], 'actions are not examples for fields');
  assert.equal(exampleLine(index.nearest({ label: 'Get my quote', kind: 'action' })[0]!), 'submit: "Get my quote" → form.submit (consequential)');
});

test('retrieval: examples for a whole form go into the labeller and classifier prompts only when given', () => {
  const shots = examplesForForm(index, [{ label: 'Date of birth', kind: 'field', control: 'date' }, { label: 'Get your quote', kind: 'action' }], 5, 2);
  assert.deepEqual(shots.map((e) => e.key), ['person.dob', 'form.submit'], 'the nearest for each element first, capped');
  assert.match(userPrompt({}, shots), /Labelled examples from other sites[\s\S]*date: "Date of birth" → person\.dob \(safe\)[\s\S]*Label this form/);
  assert.doesNotMatch(userPrompt({}), /Labelled examples/);
  const el = { id: 'e1', kind: 'field', control: 'date', label: 'Date of birth', required: true } as ExtractedElement;
  assert.match(String(classifierRequest('m', 'A quote', [el], index).messages[1]!.content), /person\.dob \(safe\)/);
  assert.doesNotMatch(String(classifierRequest('m', 'A quote', [el]).messages[1]!.content), /Labelled examples/);
});
