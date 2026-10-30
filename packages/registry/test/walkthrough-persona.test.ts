// The walkthrough's stand-ins: a harmless answer for a required field no test value covers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standIn, testStartDate } from '../src/walkthrough-persona.ts';

const now = new Date('2026-10-30T12:00:00Z');
const field = (control: string, extra: object = {}) => ({ control, required: true, ...extra });

test('a required field with no test value gets a stand-in the site will accept', () => {
  const options = { items: [{ value: '', label: 'Please select' }, { value: '25', label: '25 years' }, { value: '30', label: '30 years' }] };
  assert.equal(standIn(field('select', { options }), now), '25');
  assert.equal(standIn(field('radio', { options: { items: [{ value: 'just-me', label: 'Just me' }] } }), now), 'just-me');
  assert.equal(standIn(field('checkbox'), now), true);
  assert.equal(standIn(field('number', { constraints: { min: 25000, max: 10000000 } }), now), '25000');
  assert.equal(standIn(field('number', { constraints: { min: 0, max: 40 } }), now), '1');
  assert.equal(standIn(field('number', { constraints: { max: 0 } }), now), '0');
  assert.equal(standIn(field('date'), now), testStartDate(now));
  assert.equal(standIn(field('date', { constraints: { max: '2026-01-01' } }), now), '2026-01-01');
  assert.equal(standIn(field('email'), now), 'test@example.com');
  assert.equal(standIn(field('text'), now), 'Test');
  assert.equal(standIn(field('textarea'), now), 'Test');
});

test('a pattern picks the first stand-in it accepts, or none', () => {
  assert.equal(standIn(field('text', { constraints: { pattern: '[A-Za-z]{1,2}[0-9][A-Za-z0-9]? ?[0-9][A-Za-z]{2}' } }), now), 'WR14 1AA');
  assert.equal(standIn(field('text', { constraints: { pattern: '[A-Za-z0-9 ]{2,8}' } }), now), 'Test');
  assert.equal(standIn(field('text', { constraints: { pattern: '[0-9]{6}' } }), now), '123456');
  assert.equal(standIn(field('text', { constraints: { pattern: 'ZZ[0-9]{9}' } }), now), undefined);
  assert.equal(standIn(field('text', { constraints: { pattern: '(' } }), now), undefined);
});

test('optional fields, files and passwords are left alone', () => {
  assert.equal(standIn({ control: 'text', required: false }, now), undefined);
  assert.equal(standIn(field('file'), now), undefined);
  assert.equal(standIn(field('password'), now), undefined);
  assert.equal(standIn(field('select', { options: { items: [{ value: '', label: 'Choose one' }] } }), now), undefined);
});
