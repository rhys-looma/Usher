// Rebuilds seed/mock-site from the recorded Muse Spark labels for layout A (no API calls): the car
// journey (1-3) and Brightwater Health (4-6).
// Run with: node scripts/with-mock-sites.mjs node --import tsx packages/registry/scripts/build-seed.ts

import { writeFile } from 'node:fs/promises';
import { compilePage } from '@usher/core';
import { HEALTH_STEPS, launch, openStep, STEPS, stepPath, type AnyStep } from '../../core/test/helpers.ts';
import { readFixture, replayChat } from '../../core/test/replay.ts';

const journeys: AnyStep[][] = [STEPS, HEALTH_STEPS];
const browser = await launch();
for (const [index, step] of journeys.flat().entries()) {
  const journey = journeys.find((j) => j.includes(step))!;
  const after = journey[journey.indexOf(step) + 1];
  const leadsTo = after ? stepPath(after) : stepPath(step).replace(/[^/]+$/, 'result');
  const fixture = await readFixture('a', step);
  const { context, page } = await openStep(browser, 'a', step);
  const { map } = await compilePage(page, {
    chat: replayChat(fixture),
    model: fixture.model,
    logDir: null,
    step: journey.indexOf(step) + 1,
    leadsTo,
    now: () => new Date(fixture.recorded_at),
  });
  await context.close();
  // Rewritten to the demo site's real origin when seeded (seed.ts).
  const seeded = { ...map, origin: 'https://quote.example' };
  await writeFile(new URL(`../seed/mock-site/${index + 1}-${step}.map.json`, import.meta.url), `${JSON.stringify(seeded, null, 2)}\n`);
  console.log(`seed/mock-site/${index + 1}-${step}.map.json ${map.fingerprint.digest}`);
}
await browser.close();
