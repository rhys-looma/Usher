// Drift → rebuild → fast again, timed on the mock site (LU-42, LU-51). Replayed model responses
// with their recorded latency; the keeper runs on a short schedule and nobody visits the page.
//   node --import tsx packages/agent/scripts/drift-demo.ts [--interval-seconds 6]

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { readFixture, replayAny, type LabelFixture } from '../../core/test/replay.ts';
import { startMockSite } from '../../site-middleware/test/mock-site.ts';
import { FileStorage, seed, startRegistry, type KeeperCheck } from '../../registry/src/index.ts';
import { registerSite } from '../../registry/test/sites.ts';
import { httpTransport, runAgent, scriptedUser, summaryLine, type Profile, type RunResult } from '../src/index.ts';

const { values } = parseArgs({ options: { 'interval-seconds': { type: 'string', default: '6' } } });
const interval = Number(values['interval-seconds']);
const root = new URL('../../../', import.meta.url);
const profile = JSON.parse(await readFile(new URL('packages/agent/profiles/test-driver.json', root), 'utf8')) as Profile;
const labels = await Promise.all((['a', 'b'] as const).flatMap((l) => (['driver', 'vehicle', 'cover'] as const).map((s) => readFixture(l, s))));
const triage = JSON.parse(await readFile(new URL('packages/registry/test/fixtures/triage/driver-a-b.json', root), 'utf8')) as LabelFixture;
const spark = { chat: replayAny(labels, { simulateLatency: true }), model: 'muse-spark-1.3' };

const dir = await mkdtemp(join(tmpdir(), 'usher-drift-demo-'));
const running = await startRegistry({
  storage: new FileStorage(dir),
  siteScript: fileURLToPath(new URL('packages/site-script/dist/usher.js', root)),
  keeper: { intervalMinutes: interval / 60, compiler: spark, triage: { chat: replayAny([triage], { simulateLatency: true }), model: triage.model } },
});
const site = await startMockSite({ registry: running.url, register: async (o) => (await registerSite(running, o)).site_key });
await seed(running.registry, 'mock-site', site.url);
const browser = await chromium.launch();
const run = async (key: string): Promise<RunResult> => {
  const t = await httpTransport(running.url, join(dir, key));
  const r = await runAgent({ browser, url: `${site.url}/quote/driver`, profile, intent: 'quote.car_insurance', registry: t, user: scriptedUser(profile), fallback: spark });
  await t.close();
  return r;
};

const rows: [string, string][] = [];
try {
  const before = await run('agent-1.json');
  rows.push(['Agent on layout A, maps current', summaryLine(before)]);

  await site.setLayout('b');
  const switched = Date.now();
  let check: KeeperCheck | undefined;
  while (Date.now() - switched < (interval + 60) * 1000) {
    await new Promise((r) => setTimeout(r, 250));
    check = await running.registry.storage.getCached<KeeperCheck>('keeper-check', `${site.url}|/quote/driver`);
    if (check?.outcome === 'rebuilt') break;
  }
  const rebuiltAfter = (Date.now() - switched) / 1000;
  rows.push([`Layout switched to B; keeper (every ${interval} s) rebuilt /quote/driver`, `${rebuiltAfter.toFixed(1)} s after the switch (check took ${((check?.ms ?? 0) / 1000).toFixed(1)} s, ${check?.outcome}: ${check?.detail})`]);

  const first = await run('agent-2.json');
  rows.push(['First agent after the change', summaryLine(first)]);
  const second = await run('agent-3.json');
  rows.push(['Next agent', summaryLine(second)]);

  const md = [
    '# Drift → rebuild → fast again',
    '',
    `Generated ${new Date().toISOString().slice(0, 10)} by \`packages/agent/scripts/drift-demo.ts\`, on the mock site, with recorded model responses replayed at their recorded latency. Nobody visits the page: the scheduled keeper notices the change.`,
    '',
    '| Step | Result |',
    '| --- | --- |',
    ...rows.map(([a, b]) => `| ${a} | ${b} |`),
    '',
    'The keeper only checks forms it can reach without submitting anything, so on the mock site it rebuilds step 1; steps 2 and 3 sit behind earlier answers. The first agent after the change re-reads those two with the model and shares the maps, so every agent after that is fast on all three.',
    '',
  ];
  await writeFile(new URL('reports/drift-demo.md', root), md.join('\n'));
  console.log(md.join('\n'));
} finally {
  await browser.close();
  await site.stop();
  await running.close();
  await rm(dir, { recursive: true });
}
