import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortlist } from '../src/index.ts';

test('short list: the closest vocabulary keys for a field, best first', () => {
  assert.equal(shortlist({ kind: 'field', control: 'text', label: 'Surname' })[0], 'person.last_name');
  assert.equal(shortlist({ kind: 'field', control: 'email', label: 'Your email address' })[0], 'contact.email');
  assert.deepEqual(shortlist({ kind: 'field', control: 'tel', label: 'Mobile number' }).slice(0, 2), ['contact.mobile', 'contact.phone']);
  assert.equal(shortlist({ kind: 'field', control: 'text', label: 'Name', autocomplete: 'given-name' })[0], 'person.first_name', 'autocomplete names the key');
  assert.ok(shortlist({ kind: 'field', control: 'radio', label: 'How will you use the car?', options: ['Social only', 'Social and commuting'] }).includes('vehicle.use'));
  assert.ok(shortlist({ kind: 'field', control: 'text', label: 'Favourite colour' }).length === 0, 'nothing in common: no candidates');
  // "address" is in contact.email's meaning (Email address), but it names address.line1.
  assert.equal(shortlist({ kind: 'field', control: 'url', label: 'Address of a page with a form' })[0], 'address.line1');
  assert.equal(shortlist({ kind: 'field', control: 'text', label: 'Address' })[0], 'address.line1');
  assert.equal(shortlist({ kind: 'field', control: 'text', label: 'Your email address' })[0], 'contact.email');
  assert.ok(shortlist({ kind: 'field', control: 'text', label: 'First name' }).every((k) => !['nav.next', 'form.submit'].includes(k)), 'fields get field keys');
});

test('short list: actions, with ui.expand for content-labelled buttons but not for links', () => {
  assert.equal(shortlist({ kind: 'action', control: 'submit', label: 'Continue' })[0], 'nav.next');
  assert.equal(shortlist({ kind: 'action', control: 'submit', label: 'Search' })[0], 'search.submit');
  assert.equal(shortlist({ kind: 'action', control: 'button', label: 'Reject all' })[0], 'ui.dismiss');
  assert.ok(shortlist({ kind: 'action', control: 'button', label: 'Q4 Can I drive any car?' }).includes('ui.expand'));
  assert.deepEqual(shortlist({ kind: 'action', control: 'button', label: 'Windscreen repairs' }), ['ui.expand']);
  assert.deepEqual(shortlist({ kind: 'action', control: 'link', label: 'Universal Credit' }), []);
});
