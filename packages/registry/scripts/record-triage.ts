// Records Muse Spark Open's triage of the mock site's driver page changing from layout A to B and
// back (needs BASETEN_API_KEY). The recompile replays Muse Spark's recorded labels.
//   node --import tsx packages/registry/scripts/record-triage.ts

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelApi, openModel } from '@usher/core';
import { loadDotEnv } from '../../core/src/compile/env.ts';
import { readFixture, recordingChat, replayAny, type RecordedAttempt } from '../../core/test/replay.ts';
import { startMockSite } from '../../site-middleware/test/mock-site.ts';
import { FileStorage, seed, startRegistry } from '../src/index.ts';
import { registerSite } from '../test/sites.ts';

loadDotEnv();
const dir = await mkdtemp(join(tmpdir(), 'usher-triage-'));
const labels = await Promise.all((['a', 'b'] as const).flatMap((l) => (['driver', 'vehicle', 'cover'] as const).map((s) => readFixture(l, s))));
const attempts: RecordedAttempt[] = [];
const model = openModel();
const running = await startRegistry({
  storage: new FileStorage(dir),
  siteScript: fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url)),
  keeper: { compiler: { chat: replayAny(labels), model: 'muse-spark-1.3' }, triage: { chat: recordingChat(modelApi({ provider: 'baseten' }), attempts), model } },
});
const site = await startMockSite({ registry: running.url, register: async (o) => (await registerSite(running, o)).site_key });
await seed(running.registry, 'mock-site', site.url);
await site.setLayout('b');
const result = await running.keeper!.check(site.url, '/quote/driver');
console.log(JSON.stringify(result, null, 1));
// And back again: the current map is now B's, so A is the change.
await site.setLayout('a');
console.log(JSON.stringify(await running.keeper!.check(site.url, '/quote/driver'), null, 1));
await writeFile(new URL('../test/fixtures/triage/driver-a-b.json', import.meta.url), `${JSON.stringify({ model, recorded_at: new Date().toISOString(), attempts }, null, 2)}\n`);
await site.stop();
await running.close();
await rm(dir, { recursive: true });
