import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { composePlan, preflight, type UsherMap } from '../src/index.ts';
import { planSchemaErrors } from '../src/schemas.ts';

const seedDir = new URL('../../registry/seed/mock-site/', import.meta.url);
const maps = new Map<string, UsherMap>();
for (const f of (await readdir(seedDir)).sort()) {
  const m = JSON.parse(await readFile(new URL(f, seedDir), 'utf8')) as UsherMap;
  maps.set(m.path, m);
}

test('a plan follows leads_to from the first step to the end, gathering inputs by key', () => {
  const plan = composePlan('/quote/driver', maps)!;
  assert.equal(planSchemaErrors(plan), null);
  assert.deepEqual(plan.steps.map((s) => [s.path, s.advance?.key, s.leads_to]), [
    ['/quote/driver', 'nav.next', '/quote/vehicle'],
    ['/quote/vehicle', 'nav.next', '/quote/cover'],
    ['/quote/cover', 'form.submit', '/quote/result'],
  ]);
  assert.equal(plan.complete, true, 'the last step leads to a page with no form');
  assert.equal(plan.inputs.length, 13 + 8 + 7);
  const occupation = plan.inputs.find((i) => i.key === 'person.occupation')!;
  assert.deepEqual([occupation.required, occupation.options?.total, occupation.options?.truncated, occupation.steps], [true, 173, true, ['/quote/driver']]);
  assert.deepEqual(plan.inputs.find((i) => i.key === 'person.claims.date')!.shown_if, { field: 'person.claims.has_any', op: 'equals', value: 'yes' });
  assert.deepEqual(plan.consequential.map((c) => c.key), ['form.submit']);
});

test('a plan stops where the way forward is not known yet', () => {
  const partial = new Map(maps);
  const vehicle = partial.get('/quote/vehicle')!;
  partial.set('/quote/vehicle', { ...vehicle, actions: vehicle.actions.map(({ leads_to: _, ...a }) => a) });
  const plan = composePlan('/quote/driver', partial)!;
  assert.deepEqual([plan.complete, plan.stops_at, plan.steps.length], [false, '/quote/vehicle', 2]);
  assert.equal(composePlan('/nowhere', maps), null);
});

test('pre-flight: required, options by value or label, format, pattern and range, by key', () => {
  const plan = composePlan('/quote/driver', maps)!;
  const profile = JSON.parse('{"person.title":"Mr","person.first_name":"Sam","person.last_name":"Taylor","person.dob":"02/04/1988","contact.email":"sam@","address.postcode":"NOT A POSTCODE","address.line1":"1 High Street","person.occupation":"teacher","person.employment_status":"Employed","person.claims.has_any":"no","vehicle.registration":"AB12CDE","vehicle.make":"Ford","vehicle.model":"Fiesta","vehicle.year":"1900","vehicle.annual_mileage":"8000","vehicle.use":"social-and-commuting","vehicle.overnight_location":"driveway","vehicle.modifications.has_any":"no","policy.start_date":"2026-11-15","policy.cover_level":"Gold","policy.voluntary_excess":"250","policy.no_claims_years":"5","consent.declaration":true}');
  const result = preflight(plan.inputs.filter((i) => i.risk !== 'needs_user'), profile);
  assert.deepEqual(
    result.problems.map((p) => [p.key, p.problem]),
    [
      ['person.dob', 'format'],
      ['contact.email', 'format'],
      ['address.postcode', 'pattern'],
      ['vehicle.year', 'too_small'],
      ['policy.cover_level', 'not_an_option'],
      ['policy.payment_frequency', 'missing'],
    ],
  );
  assert.equal(result.normalised['person.title'], 'mr', 'an option given by its label becomes its value');
  assert.equal(result.normalised['person.employment_status'], 'employed');
  assert.ok(!result.problems.some((p) => p.key === 'person.claims.date'), 'not asked: no claims');
  assert.match(result.problems.find((p) => p.key === 'policy.cover_level')!.expected!, /Comprehensive/);
  assert.ok(!result.problems.some((p) => p.key === 'person.occupation'), 'a truncated list cannot rule a value out here');
});

test('a site search: the query is free text and search.submit is a safe way forward', () => {
  const search: UsherMap = {
    ...maps.get('/quote/driver')!,
    path: '/search',
    fields: [{ ...maps.get('/quote/driver')!.fields[0]!, key: 'search.query', label: 'Search', control: 'text', required: true, risk: 'safe', constraints: { pattern: '[a-z]+', max_length: 20 } }],
    actions: [{ ...maps.get('/quote/driver')!.actions[0]!, key: 'search.submit', label: 'Search', risk: 'safe' }],
  };
  delete search.fields[0]!.options;
  assert.equal(preflight(search.fields, { 'search.query': 'Car Insurance 2026!' }).ok, true, 'no pattern check on a search box');
  assert.deepEqual(preflight(search.fields, { 'search.query': 'x'.repeat(21) }).problems.map((p) => p.problem), ['too_long']);
  assert.deepEqual(preflight(search.fields, {}).problems.map((p) => p.problem), ['missing']);
  const plan = composePlan('/search', new Map([['/search', search]]))!;
  assert.equal(plan.steps[0]!.advance?.key, 'search.submit');
  assert.deepEqual(plan.consequential, [], 'nothing for the user to confirm');
});
