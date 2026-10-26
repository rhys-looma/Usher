import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { agentStanding, effectiveRules, looserRules, pathMatches, policyRulesFor, stricterRule, type UsherMap, type UsherPolicy } from '../src/index.ts';
import { policySchemaErrors } from '../src/schemas.ts';

const read = async (path: string) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const example: UsherPolicy = await read('../../../spec/examples/policy/quote.policy.json');
const driver: UsherMap = await read('../../registry/seed/mock-site/1-driver.map.json');
const cover: UsherMap = await read('../../registry/seed/mock-site/3-cover.map.json');

test('the spec example validates; the schema refuses unknown rules and members', () => {
  assert.equal(policySchemaErrors(example), null);
  assert.notEqual(policySchemaErrors({ ...example, default: { actions: { 'form.submit': 'maybe' } } }), null);
  assert.notEqual(policySchemaErrors({ ...example, extra: true }), null);
  assert.notEqual(policySchemaErrors({ ...example, forms: [{ match: { path: '/a', digest: `sha256:${'0'.repeat(64)}` } }] }), null, 'match by one thing');
});

test('path patterns: * within a segment, ** across segments', () => {
  assert.ok(pathMatches('/quote/*', '/quote/cover'));
  assert.ok(!pathMatches('/quote/*', '/quote/cover/extra'));
  assert.ok(pathMatches('/account/**', '/account/settings/email'));
  assert.ok(pathMatches('/quote/cover', '/quote/cover'));
  assert.ok(!pathMatches('/quote.cover', '/quoteXcover'), 'dots are literal');
});

test('rules for a form: default, then matching form entries in order', () => {
  const rules = policyRulesFor(example, '/quote/cover');
  assert.deepEqual(rules.actions, { 'form.submit': 'confirm', 'consent.marketing': 'forbid' });
  assert.equal(rules.agent_lane, true);
  assert.equal(policyRulesFor(example, '/account/settings').agent_lane, false);
  assert.equal(policyRulesFor(undefined, '/x').agent_lane, true, 'no policy: agents welcome, map risk decides');
});

test('effective rules: the map\'s risk is a floor the policy can only raise', () => {
  const none = effectiveRules(undefined, cover, '/quote/cover');
  assert.equal(none.actions['form.submit'], 'confirm');
  assert.equal(none.actions['consent.declaration'], 'forbid');
  assert.equal(none.actions['policy.cover_level'], 'allow');
  const stricter = effectiveRules({ ...example, default: { actions: { 'policy.cover_level': 'confirm', 'form.submit': 'forbid' } } }, cover, '/quote/cover');
  assert.equal(stricter.actions['policy.cover_level'], 'confirm');
  assert.equal(stricter.actions['form.submit'], 'forbid');
  // Even a looser policy that slipped past validation can't lower a rule.
  const looser = effectiveRules({ ...example, default: { actions: { 'form.submit': 'allow', 'consent.declaration': 'allow' } } }, cover, '/quote/cover');
  assert.equal(looser.actions['form.submit'], 'confirm');
  assert.equal(looser.actions['consent.declaration'], 'forbid');
  assert.equal(stricterRule('allow', 'forbid'), 'forbid');
});

test('validator: a policy may not loosen an action below its map risk or vocabulary default', () => {
  assert.deepEqual(looserRules(example, [driver, cover]), []);
  const loose: UsherPolicy = { ...example, default: { actions: { 'form.submit': 'allow' } }, forms: [{ match: { path: '/quote/*' }, actions: { 'consent.declaration': 'confirm', 'person.dob': 'confirm' } }] };
  const issues = looserRules(loose, [driver, cover]);
  assert.deepEqual(issues.map((i) => [i.path, i.code]), [
    ['default.actions.form.submit', 'looser_than_map'],
    ['forms[0].actions.consent.declaration', 'looser_than_map'],
  ]);
  assert.match(issues[0]!.message, /consequential .*at least "confirm", not "allow"/);
  // No map has the key: the vocabulary default applies.
  assert.equal(looserRules({ ...example, default: { actions: { 'payment.card_number': 'confirm' } }, forms: [] }, [driver])[0]?.code, 'looser_than_map');
});

test('agents: allow lists and block lists', () => {
  assert.equal(agentStanding(example, 'any'), 'allowed');
  assert.equal(agentStanding({ ...example, agents: { block: ['bad'] } }, 'bad'), 'blocked');
  assert.equal(agentStanding({ ...example, agents: { allow: ['good'] } }, 'other'), 'not_allowed');
  assert.equal(agentStanding({ ...example, agents: { allow: ['good'] } }, 'good'), 'allowed');
});
