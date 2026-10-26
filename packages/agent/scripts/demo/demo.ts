// The demo runner: the video's sequence, scene by scene, on the mock site.
//
//   npm run demo                 serve http://localhost:4200/demo; run scenes from the page (keys 1-6, 0 for all)
//   npm run demo -- race         run one scene (or several, or all) once the page is open
//   npm run demo -- race --now   don't wait for the page
//   npm run demo -- all --once   run, print the numbers and exit
//
// Every scene resets the registry and the site first, so each runs on its own. Model calls are
// replayed from recordings at the latency they had live, except the session explanation, which
// is generated live when MODEL_API_KEY is set (about $0.005). The page is served only when
// USHER_DEMO=1, and only to this machine.

import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright';
import { compilerModel, generateSigningKey, modelApi, type ChatFn } from '@usher/core';
import { loadDotEnv } from '../../../core/src/compile/env.ts';
import { readFixture, replayAny, type LabelFixture } from '../../../core/test/replay.ts';
import { startMockSite } from '../../../site-middleware/test/mock-site.ts';
import { FileStorage, Keeper, seed, startRegistry, type KeeperCheck, type PolicyRecord, type Storage } from '../../../registry/src/index.ts';
import { httpTransport, mcpTransport, runAgent, scriptedUser, type AgentEvent, type FallbackModel, type Profile, type RunResult, type UserChannel } from '../../src/index.ts';
import { Stage } from './stage.ts';

const SCENES = [
  { id: 'locked', title: 'Locked' },
  { id: 'says-yes', title: 'The site says yes' },
  { id: 'race', title: 'The race' },
  { id: 'rules-hold', title: 'Rules hold' },
  { id: 'site-sees', title: 'The site sees' },
  { id: 'stays-fresh', title: 'Stays fresh' },
];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { now: { type: 'boolean', default: false }, once: { type: 'boolean', default: false }, 'registry-port': { type: 'string', default: '4200' }, 'site-port': { type: 'string', default: '4100' } },
});
if (process.env.USHER_DEMO !== '1') {
  console.error('The demo is off unless USHER_DEMO=1. Run it with: npm run demo');
  process.exit(1);
}
const requested = positionals.flatMap((p) => (p === 'all' ? SCENES.map((s) => s.id) : [p]));
for (const id of requested) {
  if (!SCENES.some((s) => s.id === id)) {
    console.error(`No scene "${id}". Scenes: ${SCENES.map((s) => s.id).join(', ')}, or all.`);
    process.exit(1);
  }
}
loadDotEnv();

const root = new URL('../../../../', import.meta.url);
const SITE = `http://localhost:${values['site-port']}`;
const RULE = 'Agents can fill in quotes, but a human confirms the submit. Max five an hour.';
const REPLAYED = 'Model calls are replayed from recordings, at the latency they had live.';
const profile = JSON.parse(await readFile(new URL('packages/agent/profiles/test-driver.json', root), 'utf8')) as Profile;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const money = (n: number) => `$${n.toFixed(4)}`;

// Recorded model responses.
const layouts = ['a', 'b'] as const;
const steps = ['driver', 'vehicle', 'cover'] as const;
const sparkFixtures = await Promise.all(layouts.flatMap((l) => steps.map((s) => readFixture(l, s))));
const openFixtures = await Promise.all(layouts.flatMap((l) => steps.map((s) => readFixture(l, s, 'labels-open'))));
const rulesFixture = JSON.parse(await readFile(new URL('packages/registry/test/fixtures/rules/1.json', root), 'utf8')) as LabelFixture & { text: string };
const triageFixture = JSON.parse(await readFile(new URL('packages/registry/test/fixtures/triage/driver-a-b.json', root), 'utf8')) as LabelFixture;
if (rulesFixture.text !== RULE) throw new Error('The recorded rule differs from the demo rule.');
const spark: FallbackModel = { chat: replayAny(sparkFixtures, { simulateLatency: true }), model: 'muse-spark-1.3' };
const open: FallbackModel = { chat: replayAny(openFixtures, { simulateLatency: true }), model: openFixtures[0]!.model };

// The rules model is switched between an instant replay (for setting scenes up) and a timed one.
const rulesQuick = replayAny([rulesFixture]);
const rulesTimed = replayAny([rulesFixture], { simulateLatency: true });
let rulesChat: ChatFn = rulesQuick;

// The one live call: explaining a session. Capped for the whole run.
let explainSpend = 0;
const EXPLAIN_CAP_USD = 0.1;
const explainer = process.env.MODEL_API_KEY
  ? {
      model: compilerModel(),
      chat: (async (request) => {
        if (explainSpend >= EXPLAIN_CAP_USD) throw new Error('The demo has spent its explanation budget.');
        const result = await modelApi()(request);
        explainSpend += (result.usage.prompt_tokens * 1.25 + result.usage.completion_tokens * 4.25) / 1e6;
        return result;
      }) as ChatFn,
    }
  : undefined;

// Storage that each scene replaces, so every scene starts clean on the same registry.
const dir = await mkdtemp(join(tmpdir(), 'usher-demo-'));
let generation = 0;
let current: Storage = new FileStorage(join(dir, `state-${generation}`));
const storage = new Proxy({} as Storage, {
  get: (_, key) => {
    const value = (current as unknown as Record<string | symbol, unknown>)[key];
    return typeof value === 'function' ? value.bind(current) : value;
  },
});

const stage = new Stage(SCENES, (scene) => void play(scene === 'all' ? SCENES.map((s) => s.id) : [scene]));
const siteKey = `usp_demo${randomBytes(9).toString('base64url')}`;
const secret = `uss_demo${randomBytes(18).toString('base64url')}`;
const running = await startRegistry({
  storage,
  port: Number(values['registry-port']),
  url: `http://localhost:${values['registry-port']}`,
  signingKey: (await generateSigningKey()).privateJwk,
  siteScript: fileURLToPath(new URL('packages/site-script/dist/usher.js', root)),
  chat: (request) => rulesChat(request),
  model: rulesFixture.model,
  ...(explainer && { explainer }),
  web: { allowPrivate: true },
  // Every agent here runs from this machine.
  limits: { knock: 100_000, drift: 100_000, events: 100_000, read: 100_000, write: 100_000 },
  demo: stage.handle,
});
const REG = running.url;
await running.registry.ensureSite(SITE, siteKey, secret);
const site = await startMockSite({ registry: REG, port: Number(values['site-port']), register: async () => siteKey });
const browser = await chromium.launch();

async function reset(o: { maps: boolean; policy: boolean }): Promise<void> {
  const old = current;
  current = new FileStorage(join(dir, `state-${++generation}`));
  await old.close?.();
  await running.registry.ensureSite(SITE, siteKey, secret);
  await site.setLayout('a');
  rulesChat = rulesQuick;
  running.registry.onDrift = undefined;
  if (o.maps) await seed(running.registry, 'mock-site', SITE);
  if (o.policy) await current.putPolicy({ ...policy, confirmed_at: new Date().toISOString() });
}

// The site's confirmed rule, made once from the recording, for scenes that start after it.
await reset({ maps: true, policy: false });
const proposed = await running.registry.proposeRulesFor(SITE, RULE);
if (proposed.status !== 201) throw new Error(`The recorded rule no longer replays: ${JSON.stringify(proposed.body)}`);
await running.registry.confirmRulesFor(SITE, (proposed.body as { id: string }).id);
const policy = (await current.getPolicy(SITE)) as PolicyRecord;

// ---------------------------------------------------------------------------
// Agents and panes
// ---------------------------------------------------------------------------

type Who = 'A' | 'B' | 'unknocked';
const AGENTS: Record<Who, { model: string; fallback?: FallbackModel }> = {
  A: { model: 'Muse Spark', fallback: spark },
  B: { model: 'Muse Spark Open', fallback: open },
  unknocked: { model: 'no model' },
};
let agentFiles = 0;

/** Runs an agent in a pane (or off screen with no pane), with its timer and counters live. */
async function agent(who: Who, pane: string | null, extra: { user?: UserChannel; onPage?: (page: Page) => void } = {}): Promise<RunResult> {
  const keyFile = join(dir, `agent-${++agentFiles}.json`);
  const transport = who === 'B' ? await mcpTransport(REG, keyFile) : await httpTransport(REG, keyFile);
  const name = who === 'unknocked' ? 'The agent' : `Agent ${who}`;
  const say = (patch: Parameters<Stage['pane']>[1]) => pane && stage.pane(pane, patch);
  const onEvent = (e: AgentEvent) => {
    if (e.type === 'page') say({ status: `${name} opens ${e.path}` });
    if (e.type === 'knock') say({ status: e.match === 'exact' ? `Knocked: the map for ${e.path}` : e.match === 'lookup' ? `Found the map for ${e.path} without knocking` : `Knocked: no map for ${e.path} yet` });
    if (e.type === 'model') say({ status: e.done ? `Built the map for ${e.path} and shared it` : `No map: ${AGENTS[who].model} reads ${e.path}`, tone: e.done ? undefined : 'wait', tokens: e.usage.prompt_tokens + e.usage.completion_tokens, cost_usd: e.cost_usd });
    if (e.type === 'filled') say({ status: `Filled ${e.filled} fields by key on ${e.path}`, tone: undefined });
  };
  say({ started_at: Date.now(), ended_at: undefined, tone: undefined, status: `${name} starts` });
  try {
    const result = await runAgent({
      browser,
      url: `${SITE}/quote/driver`,
      profile,
      intent: 'quote.car_insurance',
      registry: transport,
      user: extra.user ?? scriptedUser(profile),
      ...(AGENTS[who].fallback && { fallback: AGENTS[who].fallback }),
      ...(who === 'unknocked' && { knock: false, headers: { 'Usher-Agent': 'unknocked-demo-agent' } }),
      viewport: { width: 1100, height: 760 },
      onPage: async (page) => {
        extra.onPage?.(page);
        if (pane) await stage.stream(pane, page);
      },
      onEvent,
    });
    say({ ended_at: Date.now(), tokens: result.usage.prompt_tokens + result.usage.completion_tokens, cost_usd: result.cost_usd });
    return result;
  } finally {
    await transport.close();
  }
}

/** The site owner's dashboard, signed in, streaming into a pane. */
async function dashboard(pane: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const page = await context.newPage();
  await page.goto(`${REG}/dashboard`);
  await page.fill('input[name=origin]', SITE);
  await page.fill('input[name=secret]', secret);
  await Promise.all([page.waitForURL(`${REG}/dashboard`), page.getByRole('button', { name: 'Sign in' }).click()]);
  await stage.stream(pane, page);
  return page;
}

const scrollTo = (page: Page, selector: string) => page.locator(selector).first().evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'start' }));

/** A call to the site's API with no knock, as a script would make it. */
async function unknockedApiCall(): Promise<{ status: number; body: string }> {
  const res = await fetch(`${SITE}/api/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Usher-Agent': 'curious-bot' }, body: '{}' });
  return { status: res.status, body: JSON.stringify(JSON.parse(await res.text()), null, 2) };
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

const scenes: Record<string, () => Promise<void>> = {
  async locked() {
    stage.clear('locked', 'Locked', 'An agent fills in the quote without knocking, then asks for a price.');
    await reset({ maps: true, policy: false });
    stage.pane('agent', { title: 'An agent that skips the knock', subtitle: 'sends Usher-Agent, never knocks', status: 'Starting' });
    let refusal = '';
    const result = await agent('unknocked', 'agent', {
      onPage: (page) =>
        page.on('response', (r) => {
          if (r.status() === 403) void r.text().then((t) => (refusal = t));
        }),
    });
    await pause(300);
    const body = refusal ? JSON.parse(refusal) : {};
    stage.pane('agent', { status: `Refused: 403 ${body.error ?? ''}`, tone: 'bad' });
    stage.card('refused', { title: 'The site said no', tone: 'bad', lines: ['HTTP 403 on “Get my quote”'], code: JSON.stringify(body, null, 2) });
    stage.number('Refused after', secs(result.total_ms));
    stage.number('Status', '403');
    stage.number('Error', String(body.error));
    stage.number('Where to knock', String(body.knock_url));
  },

  async 'says-yes'() {
    stage.clear('says-yes', 'The site says yes', 'The owner writes a rule in plain English. Muse Spark turns it into a policy; nothing applies until they confirm.', REPLAYED);
    await reset({ maps: true, policy: false });
    stage.pane('owner', { title: 'Site dashboard', subtitle: 'Brightwater Motor (demo)', status: 'Signed in as the site owner' });
    const page = await dashboard('owner');
    await scrollTo(page, '#rules');
    await pause(1200);
    stage.pane('owner', { status: 'Typing the rule', started_at: Date.now() });
    const typing = Date.now();
    await page.locator('#rules-text').pressSequentially(RULE, { delay: 45 });
    const typed = Date.now() - typing;
    rulesChat = rulesTimed;
    const asked = Date.now();
    stage.pane('owner', { status: 'Muse Spark turns the rule into a policy', tone: 'wait' });
    await Promise.all([page.waitForURL('**/dashboard/rules', { timeout: 120_000 }), page.getByRole('button', { name: 'Propose policy' }).click()]);
    const proposedMs = Date.now() - asked;
    const draft = (await current.listDrafts(SITE)).find((d) => d.status === 'pending')!;
    await scrollTo(page, '.card.notice');
    stage.pane('owner', { status: 'Proposed: check it, then confirm', tone: undefined });
    stage.card('policy', { title: 'Proposed policy', tone: 'info', lines: [draft.summary], code: describePolicy(draft.policy) });
    await pause(3500);
    await Promise.all([page.waitForURL('**/confirm'), page.getByRole('button', { name: 'Confirm and apply' }).click()]);
    await scrollTo(page, '#rules');
    stage.pane('owner', { status: 'Rules applied', tone: 'ok', ended_at: Date.now() });
    stage.card('policy', { title: 'Applied', tone: 'ok' });
    stage.number('Rule typed in', secs(typed));
    stage.number('Policy proposed in', `${secs(proposedMs)} (recorded)`);
    stage.number('Applied', 'on confirm');
    await pause(1500);
    await page.context().close();
  },

  async race() {
    stage.clear('race', 'The race', 'Agent A has no map: Muse Spark reads every page, then shares the map. Agent B knocks and runs on it.', REPLAYED);
    await reset({ maps: false, policy: true });
    stage.pane('A', { title: 'Agent A', subtitle: 'Muse Spark · no map', status: 'Ready', counters: true });
    stage.pane('B', { title: 'Agent B', subtitle: 'Muse Spark Open · knocks', status: 'Knocks once Agent A has shared the map', counters: true });
    const a = await agent('A', 'A');
    stage.pane('A', { status: a.outcome === 'completed' ? `Quote reached · ${a.maps_submitted} maps shared` : `Stopped: ${a.reason}`, tone: a.outcome === 'completed' ? 'ok' : 'bad' });
    const b = await agent('B', 'B');
    stage.pane('B', { status: b.outcome === 'completed' ? `Quote reached · ${b.pages.filter((p) => p.map_source === 'registry').length} of ${b.pages.length} pages from maps` : `Stopped: ${b.reason}`, tone: b.outcome === 'completed' ? 'ok' : 'bad' });
    stage.number('Agent A, no map', `${secs(a.total_ms)} · ${(a.usage.prompt_tokens + a.usage.completion_tokens).toLocaleString('en-GB')} tokens · ${money(a.cost_usd)}`);
    stage.number('Agent B, map', `${secs(b.total_ms)} · ${(b.usage.prompt_tokens + b.usage.completion_tokens).toLocaleString('en-GB')} tokens · ${money(b.cost_usd)}`);
    stage.number('Faster with the map', `${(a.total_ms / b.total_ms).toFixed(1)}×`);
  },

  async 'rules-hold'() {
    stage.clear('rules-hold', 'Rules hold', 'The site said a person confirms “Get my quote”. The agent waits for its user. A script that skips the knock is refused.');
    await reset({ maps: true, policy: true });
    stage.pane('B', { title: 'Agent B', subtitle: 'Muse Spark Open · knocks', status: 'Ready' });
    let waited = 0;
    const scripted = scriptedUser(profile);
    const user: UserChannel = {
      handoff: scripted.handoff,
      async confirm(element) {
        stage.pane('B', { status: `Paused at “${element.label}”: waiting for the user`, tone: 'wait' });
        const t = Date.now();
        const yes = await stage.ask(`Agent B wants to press “${element.label}”. Go ahead?`, 6000);
        waited = Date.now() - t;
        stage.pane('B', { status: yes ? 'The user said yes: the agent knocks again, confirmed' : 'The user said no', tone: undefined });
        return yes;
      },
    };
    const run = await agent('B', 'B', { user });
    stage.pane('B', { status: run.outcome === 'completed' ? 'Quote reached, with the user’s yes' : `Stopped: ${run.reason}`, tone: run.outcome === 'completed' ? 'ok' : 'bad' });
    await pause(1500);
    const api = await unknockedApiCall();
    stage.card('api', { title: 'A script calls the API without knocking', tone: 'bad', lines: [`POST ${SITE}/api/quote → ${api.status}`], code: api.body });
    stage.number('Waited for the user', secs(waited));
    stage.number('Agent B', `${run.outcome} in ${secs(run.total_ms)}`);
    stage.number('Unknocked API call', String(api.status));
  },

  async 'site-sees'() {
    stage.clear('site-sees', 'The site sees', 'Every agent session as a log by meaning, never values; what was blocked; and a plain-English explanation.', explainer ? 'The explanation is generated live by Muse Spark.' : 'No MODEL_API_KEY: the explanation is skipped.');
    await reset({ maps: true, policy: true });
    stage.card('setup', { title: 'Just now', tone: 'info', lines: ['Agent B got a quote, with its user’s yes', 'A script called /api/quote without knocking'] });
    await agent('B', null);
    await unknockedApiCall();
    stage.pane('owner', { title: 'Site dashboard', subtitle: 'Brightwater Motor (demo)', status: 'Overview', started_at: Date.now() });
    const page = await dashboard('owner');
    await pause(2000);
    await scrollTo(page, '#sessions');
    stage.pane('owner', { status: 'Agent sessions' });
    await pause(2500);
    await Promise.all([page.waitForURL('**/dashboard/sessions/*'), page.locator('a[href^="/dashboard/sessions/"]').first().click()]);
    stage.pane('owner', { status: 'The session timeline: what the agent did, by key' });
    await pause(1500);
    await scrollTo(page, 'ol.timeline');
    await pause(3500);
    const sid = new URL(page.url()).pathname.split('/').pop()!;
    const events = (await current.getSession(sid))?.events.length ?? 0;
    let explained = 'skipped';
    if (explainer) {
      stage.pane('owner', { status: 'Muse Spark explains the session', tone: 'wait' });
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      const t = Date.now();
      await Promise.all([page.waitForURL('**/explain', { timeout: 60_000 }), page.getByRole('button', { name: /Explain/ }).click()]);
      explained = secs(Date.now() - t);
      const text = await page.locator('.card.notice p').first().textContent();
      stage.card('explain', { title: 'The explanation', tone: 'ok', lines: [text ?? ''] });
      stage.pane('owner', { status: 'Explained', tone: undefined });
      await pause(4000);
    }
    await page.goto(`${REG}/dashboard`);
    await scrollTo(page, '#blocked');
    stage.pane('owner', { status: 'The blocked attempt', tone: 'bad', ended_at: Date.now() });
    const blocked = (await current.readLog('blocked', SITE)).length;
    stage.number('Session events', String(events));
    stage.number('Blocked attempts', String(blocked));
    stage.number('Explanation', explainer ? `${explained} · live` : 'skipped');
    await pause(4000);
    await page.context().close();
  },

  async 'stays-fresh'() {
    stage.clear('stays-fresh', 'Stays fresh', 'The site changes its form. The keeper notices, rebuilds the map, and the next agents are fast again.', REPLAYED);
    await reset({ maps: true, policy: true });
    const keeper = new Keeper(running.registry, { compiler: spark, triage: { chat: replayAny([triageFixture], { simulateLatency: true }), model: triageFixture.model }, intervalMinutes: 0 });
    running.registry.onDrift = (origin, path) => void keeper.check(origin, path).catch(() => undefined);
    try {
      stage.pane('agent', { title: 'An agent on layout A', subtitle: 'Muse Spark Open · knocks', status: 'Ready' });
      const before = await agent('B', 'agent');
      stage.pane('agent', { status: `Done in ${secs(before.total_ms)}, all from maps`, tone: 'ok' });
      await pause(1500);

      await site.setLayout('b');
      const switched = Date.now();
      stage.card('clock', { title: 'Form changed to layout B', tone: 'info', timer: { started_at: switched }, lines: ['A visitor’s page notices the change'] });
      stage.pane('visitor', { title: 'A visitor', subtitle: 'a person, never logged', status: 'Opens the quote page' });
      const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
      const visitor = await context.newPage();
      await stage.stream('visitor', visitor);
      await visitor.goto(`${SITE}/quote/driver`);
      stage.pane('visitor', { status: 'The site script sees a different form and reports drift' });
      let check: KeeperCheck | undefined;
      while (Date.now() - switched < 120_000) {
        await pause(250);
        check = await current.getCached<KeeperCheck>('keeper-check', `${SITE}|/quote/driver`);
        if (check?.outcome === 'rebuilt') break;
        if (check && Date.now() - switched > 3000) stage.card('clock', { lines: [`The keeper: ${check.outcome}`] });
      }
      const rebuilt = Date.now() - switched;
      stage.card('clock', { title: 'Map rebuilt', tone: 'ok', timer: { started_at: switched, ended_at: switched + rebuilt }, lines: [`The keeper: ${check?.detail ?? check?.outcome ?? 'no check'}`] });
      await context.close();

      stage.pane('visitor', { title: 'The next agent', subtitle: 'Muse Spark Open · knocks', status: 'Ready', ended_at: undefined, tone: undefined });
      const next = await agent('B', 'visitor');
      const fromMaps = (r: RunResult) => `${r.pages.filter((p) => p.map_source === 'registry').length} of ${r.pages.length} pages from maps`;
      stage.pane('visitor', { status: `${secs(next.total_ms)} · ${fromMaps(next)}`, tone: 'ok' });
      stage.pane('agent', { title: 'The agent after', subtitle: 'Muse Spark Open · knocks', status: 'Ready', ended_at: undefined, tone: undefined });
      const after = await agent('B', 'agent');
      stage.pane('agent', { status: `${secs(after.total_ms)} · ${fromMaps(after)}`, tone: 'ok' });
      stage.number('Agent on layout A', secs(before.total_ms));
      stage.number('Switch to rebuilt map', secs(rebuilt));
      stage.number('Next agent', `${secs(next.total_ms)} (${fromMaps(next)})`);
      stage.number('The agent after', `${secs(after.total_ms)} (${fromMaps(after)})`);
    } finally {
      running.registry.onDrift = undefined;
      await keeper.close();
    }
  },
};

function describePolicy(p: { default?: { actions?: Record<string, string>; rate_limits?: { action: string; per: string; max: number; window: string }[] } }): string {
  const lines = Object.entries(p.default?.actions ?? {}).map(([key, rule]) => `${key} → ${rule}`);
  for (const r of p.default?.rate_limits ?? []) lines.push(`${r.action}: at most ${r.max} per ${r.per} per ${r.window}`);
  return lines.join('\n');
}

let playing = Promise.resolve();
function play(ids: string[]): Promise<void> {
  playing = playing.then(async () => {
    for (const id of ids) {
      const title = SCENES.find((s) => s.id === id)!.title;
      const t = Date.now();
      try {
        await scenes[id]!();
        stage.set({ running: false });
        console.log(`\n${id}: ${title} (${secs(Date.now() - t)})`);
        for (const [k, v] of stage.state.numbers) console.log(`  ${k}: ${v}`);
      } catch (err) {
        stage.set({ running: false, caption: `Scene failed: ${err instanceof Error ? err.message : String(err)}` });
        console.error(`\n${id} failed:`, err);
        process.exitCode = 1;
      }
      if (ids.length > 1) await pause(3000);
    }
  });
  return playing;
}

async function shutdown(): Promise<void> {
  await browser.close();
  await site.stop();
  await running.close();
  await rm(dir, { recursive: true, force: true });
  if (explainSpend) console.log(`Live model spend (explanations): $${explainSpend.toFixed(4)}`);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown().then(() => process.exit()));

console.log(`Usher demo on ${REG}/demo  (site ${SITE}; scenes: ${SCENES.map((s, i) => `${i + 1} ${s.id}`).join(', ')}, 0 all)`);
if (requested.length) {
  if (!values.now) {
    console.log('Waiting for the page to open…');
    while (!stage.watching) await pause(200);
    await pause(1500);
  }
  await play(requested);
  if (values.once) {
    await shutdown();
    process.exit();
  }
}
