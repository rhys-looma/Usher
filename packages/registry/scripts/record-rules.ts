// Records Muse Spark's policy drafts for the three test phrasings (needs MODEL_API_KEY).
//   node --import tsx packages/registry/scripts/record-rules.ts

import { writeFile } from 'node:fs/promises';
import { compilerModel, modelApi } from '@usher/core';
import { loadDotEnv } from '../../core/src/compile/env.ts';
import { recordingChat, type RecordedAttempt } from '../../core/test/replay.ts';
import { compileRules, seedMaps } from '../src/index.ts';
import { PHRASINGS, RULES_ORIGIN } from '../test/phrasings.ts';

loadDotEnv();
const model = compilerModel();
const chat = modelApi();
const maps = (await seedMaps('mock-site')).map((m) => ({ ...m, origin: RULES_ORIGIN }));
for (const [i, text] of PHRASINGS.entries()) {
  const attempts: RecordedAttempt[] = [];
  const result = await compileRules(recordingChat(chat, attempts), model, text, RULES_ORIGIN, maps);
  await writeFile(new URL(`../test/fixtures/rules/${i + 1}.json`, import.meta.url), `${JSON.stringify({ model, recorded_at: new Date().toISOString(), text, attempts }, null, 2)}\n`);
  console.log(`${i + 1}: ${result.attempts} attempt(s), ${result.usage.prompt_tokens}/${result.usage.completion_tokens} tokens, $${result.cost_usd?.toFixed(4)}, ${result.latency_ms} ms\n   ${result.summary}\n   ${JSON.stringify(result.policy)}`);
}
