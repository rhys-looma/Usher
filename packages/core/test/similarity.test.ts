import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, similarity, type Fingerprint } from '../src/index.ts';
import { LAYOUTS, STEPS, launch, openStep, scan, type Layout, type Step } from './helpers.ts';

// Reports the numbers rather than asserting a threshold: layout B rewords labels on purpose,
// and the registry decides what score counts as a match.
test('similarity table: each step A vs B, and step 1 vs steps 2 and 3', async () => {
  const browser = await launch();
  const fps = new Map<string, Fingerprint>();
  for (const layout of LAYOUTS) {
    for (const step of STEPS) {
      const { context, page } = await openStep(browser, layout, step);
      fps.set(`${layout}:${step}`, await fingerprint((await scan(page)).forms[0]!.elements));
      await context.close();
    }
  }
  await browser.close();

  const fp = (layout: Layout, step: Step) => fps.get(`${layout}:${step}`)!;
  const rows: [string, number][] = [
    ...STEPS.map((s): [string, number] => [`${s} A vs ${s} B`, similarity(fp('a', s), fp('b', s))]),
    ...LAYOUTS.flatMap((l) =>
      (['vehicle', 'cover'] as const).map((s): [string, number] => [`driver ${l.toUpperCase()} vs ${s} ${l.toUpperCase()}`, similarity(fp(l, 'driver'), fp(l, s))]),
    ),
  ];
  const width = Math.max(...rows.map(([name]) => name.length));
  console.log(['', 'usher-fp-1 similarity (Jaccard)', ...rows.map(([name, score]) => `  ${name.padEnd(width)}  ${score.toFixed(3)}`), ''].join('\n'));

  for (const [, score] of rows) assert.ok(score >= 0 && score <= 1);
  for (const s of STEPS) for (const l of LAYOUTS) assert.equal(similarity(fp(l, s), fp(l, s)), 1);
  for (const s of STEPS) assert.notEqual(fp('a', s).digest, fp('b', s).digest, `${s} digests differ between layouts`);
});
