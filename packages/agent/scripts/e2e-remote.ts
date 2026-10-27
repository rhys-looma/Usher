// End to end against a running stack: docker compose locally, or a deployment.
//
//   node --import tsx packages/agent/scripts/e2e-remote.ts [--registry <url>] [--site <url>] --secret uss_…
//   (defaults: REGISTRY_PUBLIC_URL and USHER_SITE_URL, else the local stack's, read from docker-compose.yml)
//
// Uses recorded model responses (no spend) unless --live. Checks: health; an unknocked API call
// is refused; Agent A (Muse Spark) completes the quote, building maps if there are none; Agent B
// (Spark Open, MCP) runs on the maps and is faster; the session is readable with the site's secret;
// layout B is reported as drift; the dashboard shows the session, the refusal and the drift.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { compilerModel, modelApi, openModel } from '@usher/core';
import { loadDotEnv } from '../../core/src/compile/env.ts';
import { readFixture, replayAny } from '../../core/test/replay.ts';
import { httpTransport, mcpTransport, runAgent, scriptedUser, summaryLine, type Profile } from '../src/index.ts';

// The local stack's addresses, from the one file that names them.
const compose = await readFile(new URL('../../../docker-compose.yml', import.meta.url), 'utf8').catch(() => '');
const fromCompose = (name: string) => new RegExp(`${name}:\\s*(\\S+)`).exec(compose)?.[1];
const { values } = parseArgs({
  options: {
    registry: { type: 'string', default: process.env.REGISTRY_PUBLIC_URL ?? fromCompose('REGISTRY_PUBLIC_URL') ?? '' },
    site: { type: 'string', default: process.env.USHER_SITE_URL ?? fromCompose('USHER_DEV_SITE_ORIGIN') ?? '' },
    secret: { type: 'string', default: 'uss_localdevelopmentonly00000000' },
    live: { type: 'boolean', default: false },
  },
});
if (!values.registry || !values.site) {
  console.error('Give --registry and --site, or set REGISTRY_PUBLIC_URL and USHER_SITE_URL.');
  process.exit(2);
}
const registry = values.registry.replace(/\/$/, '');
const site = values.site.replace(/\/$/, '');
const profile = JSON.parse(await readFile(new URL('../profiles/test-driver.json', import.meta.url), 'utf8')) as Profile;
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

const recorded = (set: 'labels' | 'labels-open') =>
  Promise.all((['a', 'b'] as const).flatMap((l) => (['driver', 'vehicle', 'cover'] as const).map((s) => readFixture(l, s, set))));
loadDotEnv();
const openFixtures = await recorded('labels-open');
const spark = values.live ? { chat: modelApi(), model: compilerModel() } : { chat: replayAny(await recorded('labels'), { simulateLatency: true }), model: 'muse-spark-1.3' };
const sparkOpen = values.live ? { chat: modelApi({ provider: 'baseten' }), model: openModel() } : { chat: replayAny(openFixtures, { simulateLatency: true }), model: openFixtures[0]!.model };

const health = await (await fetch(`${registry}/healthz`)).json();
check('registry healthy', health.ok === true, `storage ${health.storage}, site script ${health.site_script}`);
const siteHealth = await (await fetch(`${site}/healthz`)).json().catch(() => ({}));
check('site healthy and on layout A', siteHealth.ok === true && siteHealth.layout === 'a');

const refused = await fetch(`${site}/api/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Usher-Agent': 'e2e-unknocked' }, body: '{}' });
check('unknocked API call refused', refused.status === 403 && (await refused.json()).error === 'knock_required');

const dir = await mkdtemp(join(tmpdir(), 'usher-e2e-remote-'));
const browser = await chromium.launch();
try {
  const a = await httpTransport(registry, join(dir, 'a.json'));
  const runA = await runAgent({ browser, url: `${site}/quote/driver`, profile, intent: 'quote.car_insurance', registry: a, user: scriptedUser(profile), fallback: spark });
  await a.close();
  check('Agent A (Muse Spark) completed the quote', runA.outcome === 'completed', summaryLine(runA));

  const b = await mcpTransport(registry, join(dir, 'b.json'));
  const runB = await runAgent({ browser, url: `${site}/quote/driver`, profile, intent: 'quote.car_insurance', registry: b, user: scriptedUser(profile), fallback: sparkOpen });
  await b.close();
  check('Agent B (Spark Open, MCP) ran on the maps', runB.outcome === 'completed' && runB.pages.every((p) => p.map_source === 'registry'), summaryLine(runB));
  check('Agent B faster than Agent A', runB.total_ms < runA.total_ms, `${(runB.total_ms / 1000).toFixed(2)}s vs ${(runA.total_ms / 1000).toFixed(2)}s`);

  const session = await fetch(`${registry}/sessions/${runA.session}`, { headers: { Authorization: `Bearer ${values.secret}` } });
  const events = session.ok ? ((await session.json()) as { events: { action: string; key?: string }[] }).events : [];
  check('session readable with the secret key, by semantic key', events.some((e) => e.action === 'fill' && e.key === 'person.dob'), `${events.length} events`);
  check('session not readable without it', (await fetch(`${registry}/sessions/${runA.session}`)).status === 404);

  // Layout B: a person's page load is enough for the site script to notice.
  await fetch(`${site}/__admin/variant`, { method: 'POST', body: new URLSearchParams({ variant: 'b' }), redirect: 'manual' });
  const page = await browser.newPage();
  await page.goto(`${site}/quote/driver`);
  await page.evaluate(() => (window as unknown as { usher: { ready: Promise<void> } }).usher.ready);
  await page.waitForTimeout(500);
  await page.close();
  await fetch(`${site}/__admin/variant`, { method: 'POST', body: new URLSearchParams({ variant: 'a' }), redirect: 'manual' });

  const login = await fetch(`${registry}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: site, secret: values.secret }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const dashboard = await (await fetch(`${registry}/dashboard`, { headers: { Cookie: cookie } })).text();
  check('dashboard sign-in', login.status === 303 && dashboard.includes('Agent sessions'));
  check('dashboard shows the blocked unknocked attempt', dashboard.includes('e2e-unknocked'));
  check('dashboard shows drift after layout B', dashboard.includes('drifted'));
  check('dashboard lists agent sessions', (dashboard.match(/\/dashboard\/sessions\/s_/g) ?? []).length >= 2);
} finally {
  await browser.close();
  await rm(dir, { recursive: true });
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${values.live ? ' (live models)' : ' (recorded model responses)'}`);
process.exit(failed.length ? 1 : 0);
