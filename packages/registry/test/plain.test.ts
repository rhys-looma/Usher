// Owners' words: a session as what happened, page by page; the owner's mapping run told apart from
// agents; never a code where the site has words of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UsherMap } from '@usher/core';
import { isMappingRun, keyMeaning, labelsOf, pageName, plainLog, whoRan } from '../src/web/plain.ts';
import type { Session, SessionEvent } from '../src/storage.ts';

const map = {
  path: '/aip/you',
  form: { purpose: 'Mortgage agreement in principle: about you' },
  fields: [{ key: 'person.first_name', label: 'First name' }, { key: 'custom.housing_status', label: 'Where do you live now?' }, { key: 'custom.soft_search', label: 'I agree to a soft credit search' }],
  actions: [{ key: 'nav.next', label: 'Continue' }, { key: 'form.submit', label: 'Get my agreement in principle' }],
} as unknown as UsherMap;
const at = (action: SessionEvent['action'], key?: string): SessionEvent => ({ ts: '2026-11-03T17:00:00Z', source: 'site', action, path: '/aip/you', ...(key && { key }) });
const render = (events: SessionEvent[]) => String(plainLog(events, [map])).replace(/&#39;/g, "'");

test('a session reads as what happened, by what the site calls things', () => {
  const text = render([at('knock'), at('fill', 'person.first_name'), at('select', 'custom.housing_status'), at('submit', 'nav.next'), at('shown', 'custom.soft_search'), at('confirm', 'form.submit'), at('submit', 'form.submit')]);
  assert.match(text, /<h3>About you<\/h3>/);
  assert.match(text, /Filled in First name, Where do you live now\?/);
  assert.match(text, /Went on to the next page/);
  assert.match(text, /Showed the person “I agree to a soft credit search”, word for word/);
  assert.match(text, /The person said yes to “Get my agreement in principle”/);
  assert.match(text, /Pressed “Get my agreement in principle”/);
  assert.match(render([at('run')]), /Finished/);
  assert.doesNotMatch(text, /knock|person\.first_name|custom\.|sha256|score/, 'no codes');
});

test('a key with no words of its own still reads', () => {
  assert.equal(keyMeaning('custom.housing_status'), 'Housing status');
  assert.equal(labelsOf([map]).get('form.submit'), 'Get my agreement in principle');
  assert.equal(pageName(map, map.path), 'About you');
  assert.equal(pageName(undefined, '/x'), '/x');
});

test('the owner\'s own mapping run is told apart from agents', () => {
  const run = { agent: 'walkthrough:shop.example' } as Session;
  assert.equal(isMappingRun(run), true);
  assert.equal(whoRan(run), 'Your mapping run');
  assert.equal(isMappingRun({ agent: 'abc' } as Session), false);
  assert.equal(whoRan({ agent: 'abc', identity: { method: 'hosted' } } as Session), 'An assistant, through Usher');
});
