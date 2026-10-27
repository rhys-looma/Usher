// Rebuilds seed/mock-site from the recorded Muse Spark labels for layout A (no API calls).
// Run with: node scripts/with-mock-sites.mjs node --import tsx packages/registry/scripts/build-seed.ts

import { writeFile } from 'node:fs/promises';
import { compilePage } from '@usher/core';
import { launch, openStep, STEPS } from '../../core/test/helpers.ts';
import { readFixture, replayChat } from '../../core/test/replay.ts';

const leadsTo = { driver: '/quote/vehicle', vehicle: '/quote/cover', cover: '/quote/result' } as const;
const browser = await launch();
for (const [index, step] of STEPS.entries()) {
  const fixture = await readFixture('a', step);
  const { context, page } = await openStep(browser, 'a', step);
  const { map } = await compilePage(page, {
    chat: replayChat(fixture),
    model: fixture.model,
    logDir: null,
    step: index + 1,
    leadsTo: leadsTo[step],
    now: () => new Date(fixture.recorded_at),
  });
  await context.close();
  // Rewritten to the demo site's real origin when seeded (seed.ts).
  const seeded = { ...map, origin: 'https://quote.example' };
  await writeFile(new URL(`../seed/mock-site/${index + 1}-${step}.map.json`, import.meta.url), `${JSON.stringify(seeded, null, 2)}\n`);
  console.log(`seed/mock-site/${index + 1}-${step}.map.json ${map.fingerprint.digest}`);
}
await browser.close();
