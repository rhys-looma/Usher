// The plan for an assistant driving its own browser (browser-plan.ts): from Brightwater Health's
// three mapped pages, the rules at the top, what to ask first, the steps with where to find each
// field, the stops, and the answers placed in the site's own form. Compact, and no values in the plan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { browserPlan, composePlan, confirmableStops, placeValues, type UsherMap } from '../src/index.ts';

const seed = new URL('../../registry/seed/mock-site/', import.meta.url);
async function health() {
  const maps = new Map<string, UsherMap>();
  for (const f of ['4-health-about', '5-health-cover', '6-health-declaration']) {
    const m = JSON.parse(await readFile(new URL(`${f}.map.json`, seed), 'utf8')) as UsherMap;
    maps.set(m.path, { ...m, origin: 'https://brightwater.example' });
  }
  const plan = composePlan('/health/about', maps)!;
  return { maps, plan, view: browserPlan(plan, maps, { name: 'Brightwater', joined: true, siteRules: 'Agents may fill the quote.' }) };
}

test('the plan: rules first, ask first, steps in order with find hints, the stops; under 8 KB', async () => {
  const { view } = await health();
  assert.ok(JSON.stringify(view).length < 8000, `${JSON.stringify(view).length} bytes`);
  assert.equal(view.known, '3 of 3 pages, to the end');
  assert.match(view.rules[0]!, /^Brightwater's own rules: Agents may fill the quote\./);
  assert.ok(view.rules.some((r) => /Never tick a consent yourself/.test(r)));
  assert.deepEqual(view.steps.map((s) => new URL(s.url).pathname), ['/health/about', '/health/cover', '/health/declaration']);
  const asks = view.ask_first.map((a) => a.key);
  for (const key of ['person.first_name', 'person.dob', 'address.postcode', 'cover.level', 'person.smoker']) assert.ok(asks.includes(key), key);
  assert.ok(!asks.some((k) => k.startsWith('consent.')), 'consents are stops, not questions');
  assert.equal(view.ask_first.find((a) => a.key === 'person.smoker')?.theirs, true);
  assert.deepEqual(view.stops.map((s) => s.key), ['person.smoker', 'consent.declaration', 'form.submit']);
  assert.match(view.stops.find((s) => s.key === 'consent.declaration')!.verbatim!, /I confirm/);
  assert.deepEqual(confirmableStops(view), ['consent.declaration', 'form.submit']);
  const title = view.steps[0]!.fields.find((f) => f.key === 'person.title')!;
  assert.equal(title.find[0], 'label "Title"', 'what a model reads first');
  assert.ok(title.options!.includes('Mr'));
  assert.match(view.token, /has joined Usher/);
  const unjoined = browserPlan((await health()).plan, (await health()).maps, { name: 'Brightwater', joined: false });
  assert.match(unjoined.token, /has not joined Usher: there is no token/);
  assert.ok(!unjoined.rules.some((r) => /own rules/.test(r)));
});

test('answers placed in the site\'s form: option labels, split dates by part, lookups to run; problems by key', async () => {
  const { maps, plan, view } = await health();
  const placed = placeValues(view, plan, maps, { 'person.title': 'mr', 'person.first_name': 'Sam', 'person.dob': '1988-04-02', 'address.postcode': 'WR14 1AA', 'cover.level': 'Comprehensive', 'person.smoker': 'no' });
  const about = placed.steps[0]!;
  const field = (key: string, part?: string) => about.fields.find((f) => f.key === key && (!part || f.part === part))!;
  assert.equal(field('person.title').value, 'Mr');
  assert.equal(field('person.first_name').value, 'Sam');
  assert.deepEqual(['day', 'month', 'year'].map((p) => field('person.dob', p).value), ['02', '04', '1988']);
  assert.equal(about.lookups![0]!.run_with, 'address.postcode = WR14 1AA');
  assert.match(field('person.smoker').do!, /their answer/);
  const declaration = placed.steps[2]!.fields.find((f) => f.key === 'consent.declaration')!;
  assert.equal(declaration.value, undefined);
  assert.match(declaration.do!, /tick it only after they say yes/);
  const bad = placeValues(view, plan, maps, { 'cover.level': 'Platinum' });
  const level = bad.problems?.find((p) => p.key === 'cover.level');
  assert.match(level!.message, /option/i, 'not one of the site\'s options');
  assert.ok(level!.expected?.includes('Comprehensive'), 'with what the site would take');
  assert.ok(bad.problems?.some((p) => p.key === 'person.first_name'), 'and missing required answers, by key');
  assert.ok(!JSON.stringify(view).includes('WR14 1AA'), 'the plan itself holds no values');
});
