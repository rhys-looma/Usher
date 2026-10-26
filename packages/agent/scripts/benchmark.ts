// Benchmark (LU-41): the same journeys three ways, for both agents, five runs each.
//   (a) the agent reads every page with its model, no Usher
//   (b) the agent uses maps: via a knock on an Usher site, or a registry lookup elsewhere
//   (c) the agent gets a plan for the journey first, then uses the maps
// Journeys: the mock site's three steps (submitted: a made-up quote), and a real public
// single-page form filled but never submitted. Writes reports/benchmark.md.
//
//   node --import tsx packages/agent/scripts/benchmark.ts [--runs 5] [--live]
//
// Model responses are replayed (fixtures, then the compiler log) at their recorded latency. With
// --live, the first run of each configuration that calls a model is live (and logged, so later
// runs replay it); the report says which runs were live.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type Browser } from 'playwright';
import { DEFAULT_LOG_DIR, compilePage, compilerModel, modelApi, openModel, type ChatFn } from '@usher/core';
import { loadDotEnv } from '../../core/src/compile/env.ts';
import { readFixture, replayAny, replayFromLog } from '../../core/test/replay.ts';
import { startMockSite } from '../../site-middleware/test/mock-site.ts';
import { FileStorage, seed, startRegistry } from '../../registry/src/index.ts';
import { registerSite } from '../../registry/test/sites.ts';
import { httpTransport, mcpTransport, runAgent, scriptedUser, type FallbackModel, type Profile, type RegistryTransport, type RunResult } from '../src/index.ts';

const { values } = parseArgs({ options: { runs: { type: 'string', default: '5' }, live: { type: 'boolean', default: false } } });
const RUNS = Number(values.runs);
loadDotEnv();
const root = new URL('../../../', import.meta.url);
const logDir = new URL('data/compiler-log/', root);
const read = async (path: string) => JSON.parse(await readFile(new URL(path, root), 'utf8'));

const sparkFixtures = await Promise.all((['a', 'b'] as const).flatMap((l) => (['driver', 'vehicle', 'cover'] as const).map((s) => readFixture(l, s))));
const openFixtures = await Promise.all((['a', 'b'] as const).flatMap((l) => (['driver', 'vehicle', 'cover'] as const).map((s) => readFixture(l, s, 'labels-open'))));

/** Recorded responses first (fixtures, then the compiler log, re-read each time), at recorded latency. */
function replayed(fixtures: typeof sparkFixtures): ChatFn {
  const fromFixtures = replayAny(fixtures, { simulateLatency: true });
  return async (request) => {
    try {
      return await fromFixtures(request);
    } catch {
      return (await replayFromLog(logDir, { simulateLatency: true })).chat(request);
    }
  };
}

interface Agent {
  name: string;
  model: string;
  transport: (registry: string, key: string) => Promise<RegistryTransport>;
  fallback: (live: boolean) => FallbackModel;
}
const agents: Agent[] = [
  {
    name: 'Agent A (Muse Spark, HTTP)',
    model: compilerModel(),
    transport: (r, k) => httpTransport(r, k),
    fallback: (live) => (live ? { chat: modelApi(), model: compilerModel(), logDir: DEFAULT_LOG_DIR } : { chat: replayed(sparkFixtures), model: 'muse-spark-1.3' }),
  },
  {
    name: 'Agent B (Muse Spark Open, MCP)',
    model: openModel(),
    transport: (r, k) => mcpTransport(r, k),
    fallback: (live) => (live ? { chat: modelApi({ provider: 'baseten' }), model: openModel(), logDir: DEFAULT_LOG_DIR } : { chat: replayed(openFixtures), model: openFixtures[0]!.model }),
  },
];

interface Row {
  journey: string;
  config: string;
  agent: string;
  runs: RunResult[];
  live: boolean[];
  note?: string;
}

const dir = await mkdtemp(join(tmpdir(), 'usher-bench-'));
// Every agent here runs from one address, so the per-address limits are lifted for the run.
const registry = await startRegistry({
  storage: new FileStorage(join(dir, 'registry')),
  siteScript: fileURLToPath(new URL('packages/site-script/dist/usher.js', root)),
  limits: { knock: 100_000, drift: 100_000, events: 100_000, read: 100_000, write: 100_000 },
});
const site = await startMockSite({ registry: registry.url, register: async (o) => (await registerSite(registry, o)).site_key });
await seed(registry.registry, 'mock-site', site.url);
const browser: Browser = await chromium.launch();

// The public form's map, as the registry would hold it after one compile: replayed from the
// compiler log, or compiled live with --live. A fresh clone has no log, so without --live the
// public journey is left out (and the report says so).
const PUBLIC = 'https://httpbin.org/forms/post';
let publicSkipped: string | null = null;
{
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  try {
    await page.goto(PUBLIC, { waitUntil: 'load' });
    const chat = values.live ? modelApi() : (await replayFromLog(logDir)).chat;
    const compiled = await compilePage(page, { chat, model: values.live ? compilerModel() : 'muse-spark-1.3', logDir: values.live ? DEFAULT_LOG_DIR : null });
    await registry.registry.addMap(compiled.map);
  } catch (err) {
    publicSkipped = /compiler log/.test(String(err)) ? 'no recorded Muse Spark response for it in data/compiler-log (gitignored); run with --live once to record one (about $0.03)' : `it could not be mapped: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
    console.log(`Leaving out ${PUBLIC}: ${publicSkipped}.`);
  } finally {
    await page.context().close();
  }
}

const journeys = [
  { name: 'Mock quote site, 3 steps, submitted', url: `${site.url}/quote/driver`, profile: (await read('packages/agent/profiles/test-driver.json')) as Profile, dryRun: false },
  ...(publicSkipped ? [] : [{ name: 'httpbin.org/forms/post, 1 page, filled not submitted', url: PUBLIC, profile: (await read('packages/agent/profiles/httpbin-order.json')) as Profile, dryRun: true }]),
];
const configs = [
  { name: '(a) reads pages, no Usher', noUsher: true, usePlan: false, usesModel: true },
  { name: '(b) maps via knock / lookup', noUsher: false, usePlan: false, usesModel: false },
  { name: '(c) plan, then maps', noUsher: false, usePlan: true, usesModel: false },
];

const rows: Row[] = [];
let n = 0;
try {
  for (const journey of journeys) {
    for (const config of configs) {
      for (const agent of agents) {
        const row: Row = { journey: journey.name, config: config.name, agent: agent.name, runs: [], live: [] };
        for (let i = 0; i < RUNS; i++) {
          const live = values.live && config.usesModel && i === 0;
          const transport = await agent.transport(registry.url, join(dir, `agent-${n++}.json`));
          try {
            const run = await runAgent({
              browser,
              url: journey.url,
              profile: journey.profile,
              intent: 'quote.car_insurance',
              registry: transport,
              user: scriptedUser(journey.profile),
              fallback: agent.fallback(live),
              noUsher: config.noUsher,
              usePlan: config.usePlan,
              dryRun: journey.dryRun,
            });
            row.runs.push(run);
            row.live.push(live);
            if (run.outcome !== 'completed' && /no recorded|not in the compiler log/i.test(run.reason ?? '')) {
              row.note = `no recorded ${agent.model} response for this page; run with --live once to record it`;
              break;
            }
          } finally {
            await transport.close();
          }
        }
        rows.push(row);
        const ok = row.runs.filter((r) => r.outcome === 'completed').length;
        console.log(`${journey.name} | ${config.name} | ${agent.name}: ${ok}/${row.runs.length} ok${row.note ? ` (${row.note})` : ''}`);
      }
    }
  }
} finally {
  await browser.close();
  await site.stop();
  await registry.close();
  await rm(dir, { recursive: true });
}

// Report.
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0;
};
const sec = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
const stat = (xs: number[], fmt: (n: number) => string) => (xs.length ? `${fmt(median(xs))} (${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))})` : '–');
const replayedRuns = (r: Row) => r.runs.filter((_, i) => !r.live[i]);
const lines = [
  '# Benchmark',
  '',
  `Generated ${new Date().toISOString().slice(0, 10)} by \`packages/agent/scripts/benchmark.ts\`, ${RUNS} runs per row.`,
  '',
  '## Method',
  '',
  '- **Journeys.** The mock quote site\'s three steps, submitted (the quote is made up), and a real public single-page form, [httpbin.org/forms/post](https://httpbin.org/forms/post), filled but never submitted (a dry run stops before its submit).',
  '- **Configurations.** (a) The agent reads each page with its model (extraction and a screenshot, labelled as the compiler does) and acts on that, without Usher: no knock, nothing shared. (b) The agent uses maps: on the mock site, which runs Usher, by knocking; on httpbin, which does not, by looking the map up in the registry by fingerprint (no token). (c) The agent first gets a plan for the journey and checks its data against it, then uses the maps.',
  '- **Agents.** Agent A falls back to Muse Spark over HTTP; Agent B to Muse Spark Open, talking to the registry over MCP. In (b) and (c) neither calls a model.',
  '- **Model responses** are replayed from recordings at the latency they had when recorded, so wall time and model time reflect real model calls without spending on every run. Tokens and cost are the recorded calls\' usage. Rows marked live include one live run, listed separately.',
  '- **Success**: the run completed (for the dry run: every value filled, nothing submitted). Medians with the range in brackets. In replayed rows each recording\'s latency is fixed, so the spread is the agent and browser\'s own variation; the live rows show real model latency, which varies more.',
  '',
  '## Results (replayed runs)',
  '',
  '| Journey | Configuration | Agent | Success | Wall time | Model time | Tokens in / out | Cost |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((r) => {
    const rs = replayedRuns(r);
    if (!rs.length) return `| ${r.journey} | ${r.config} | ${r.agent} | – | – | – | – | ${r.note ?? 'no replayed runs'} |`;
    return `| ${r.journey} | ${r.config} | ${r.agent} | ${rs.filter((x) => x.outcome === 'completed').length}/${rs.length} | ${stat(rs.map((x) => x.total_ms), sec)} | ${stat(rs.map((x) => x.model_ms), sec)} | ${median(rs.map((x) => x.usage.prompt_tokens))} / ${median(rs.map((x) => x.usage.completion_tokens))} | $${median(rs.map((x) => x.cost_usd)).toFixed(4)} |`;
  }),
  '',
  ...(rows.some((r) => r.live.includes(true))
    ? [
        '## Live runs',
        '',
        '| Journey | Configuration | Agent | Outcome | Wall time | Model time | Tokens in / out | Cost |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows.flatMap((r) => r.runs.filter((_, i) => r.live[i]).map((x) => `| ${r.journey} | ${r.config} | ${r.agent} | ${x.outcome} | ${sec(x.total_ms)} | ${sec(x.model_ms)} | ${x.usage.prompt_tokens} / ${x.usage.completion_tokens} | $${x.cost_usd.toFixed(4)} |`)),
        '',
      ]
    : ['No live runs in this report: every run replayed recorded responses.', '']),
  ...(rows.some((r) => r.note) || publicSkipped
    ? ['## Notes', '', ...(publicSkipped ? [`- ${PUBLIC} was left out: ${publicSkipped}.`] : []), ...rows.filter((r) => r.note).map((r) => `- ${r.journey}, ${r.config}, ${r.agent}: ${r.note}.`), '']
    : []),
];
await writeFile(new URL('reports/benchmark.md', root), lines.join('\n'));
console.log(lines.join('\n'));
