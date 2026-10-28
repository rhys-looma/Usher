// Records Muse Spark reading the natural prompts' details against Brightwater's plans, car and
// health (needs MODEL_API_KEY). Tests replay them.
//   node --import tsx packages/mcp/scripts/record-details.ts

import { writeFile } from 'node:fs/promises';
import { compilerModel, composePlan, modelApi } from '@usher/core';
import { loadDotEnv } from '../../core/src/compile/env.ts';
import { recordingChat, type RecordedAttempt } from '../../core/test/replay.ts';
import { seedMaps } from '../../registry/src/index.ts';
import { mapDetails } from '../src/details.ts';
import { NATURAL, NATURAL_HEALTH } from '../test/natural.ts';

loadDotEnv();
const model = compilerModel();
const maps = await seedMaps('mock-site');
for (const [start, text, file] of [['/quote/driver', NATURAL, 'natural'], ['/health/about', NATURAL_HEALTH, 'natural-health']] as const) {
  const plan = composePlan(start, new Map(maps.map((m) => [m.path, m])))!;
  const attempts: RecordedAttempt[] = [];
  const result = await mapDetails(recordingChat(modelApi(), attempts), model, plan, text, { logDir: null, given: () => true });
  await writeFile(new URL(`../test/fixtures/details/${file}.json`, import.meta.url), `${JSON.stringify({ model, recorded_at: new Date().toISOString(), attempts }, null, 2)}\n`);
  console.log(`${file}: ${Object.keys(result.values).length} keys, ${result.usage.prompt_tokens}/${result.usage.completion_tokens} tokens, $${result.cost_usd?.toFixed(4)}, ${result.latency_ms} ms`);
  console.log(Object.keys(result.values).sort().join(' '));
}
