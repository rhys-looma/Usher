// Records Muse Spark reading the natural prompt's details against the Brightwater plan (needs
// MODEL_API_KEY). Tests replay it.
//   node --import tsx packages/mcp/scripts/record-details.ts

import { writeFile } from 'node:fs/promises';
import { compilerModel, composePlan, modelApi } from '@usher/core';
import { loadDotEnv } from '../../core/src/compile/env.ts';
import { recordingChat, type RecordedAttempt } from '../../core/test/replay.ts';
import { seedMaps } from '../../registry/src/index.ts';
import { mapDetails } from '../src/details.ts';
import { NATURAL } from '../test/natural.ts';

loadDotEnv();
const model = compilerModel();
const maps = await seedMaps('mock-site');
const plan = composePlan('/quote/driver', new Map(maps.map((m) => [m.path, m])))!;
const attempts: RecordedAttempt[] = [];
const result = await mapDetails(recordingChat(modelApi(), attempts), model, plan, NATURAL, { logDir: null, given: () => true });
await writeFile(new URL('../test/fixtures/details/natural.json', import.meta.url), `${JSON.stringify({ model, recorded_at: new Date().toISOString(), attempts }, null, 2)}\n`);
console.log(`${Object.keys(result.values).length} keys, ${result.usage.prompt_tokens}/${result.usage.completion_tokens} tokens, $${result.cost_usd?.toFixed(4)}, ${result.latency_ms} ms`);
console.log(Object.keys(result.values).sort().join(' '));
