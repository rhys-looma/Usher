// The demo runner, matched to the final script: eight scenes against production (the public
// registry and the Brightwater demo site), except the layout switch, which uses the demo site's
// admin form. Each scene resets Brightwater to layout A with its maps current, opens its windows
// (dark, large type) and prints the numbers it shows.
//
//   npm run demo -- <scene> [...]     1-8, a scene id, or all; windows stay open until Ctrl+C
//   npm run demo -- 3 --once          run, print the numbers and close
//   npm run demo -- 7 --screen 2560x1440 --zoom 1.5
//
// Scenes: 1 fill, 2 ticket, 3 race, 4 signup, 5 rules-hold, 6 site-sees, 7 govuk, 8 diagram.
// Scene 1 is recorded by hand in an MCP client; the runner only resets and opens the dashboard.
// Live model calls: scene 4's rules preview (about $0.01), and in scenes 1 and 7 the keeper's
// rebuild when the layout changes (a few cents), all within the registry's daily cap.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { UsherMap } from '@usher/core';
import { TOKEN_LIFETIME_SECONDS } from '@usher/core';
import { httpTransport, runAgent, scriptedUser, type Profile } from '../../src/index.ts';
import { diagramCard, raceCard, refusalCard, sceneCard, ticketCard, type RaceSide } from './cards.ts';
import { DRIVER, HEALTH, PATHS, REGISTRY, SITE, currentDigest, dashboard, keeperOutcome, layout, mapByDigest, rulesFor, setLayout, timeline, waitForNewMap } from './production.ts';

const SCENES = [
  { n: 1, id: 'fill', title: 'usher_fill from an MCP client' },
  { n: 2, id: 'ticket', title: 'The ticket for the last knock' },
  { n: 3, id: 'race', title: 'Browser Use, with and without usher_fill' },
  { n: 4, id: 'signup', title: 'Signup and the rules editor' },
  { n: 5, id: 'rules-hold', title: 'Rules hold' },
  { n: 6, id: 'site-sees', title: 'The site sees' },
  { n: 7, id: 'govuk', title: 'Try it on GOV.UK, then the form changes' },
  { n: 8, id: 'diagram', title: 'Map, knock, log' },
] as const;
type SceneId = (typeof SCENES)[number]['id'];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    once: { type: 'boolean', default: false },
    headless: { type: 'boolean', default: false },
    screen: { type: 'string', default: '1920x1080' },
    zoom: { type: 'string', default: '1.25' },
    speed: { type: 'string', default: '1' },
    hold: { type: 'string', default: '6' },
    out: { type: 'string', default: 'demo-out' },
  },
});
const requested: SceneId[] = positionals.flatMap((p) => (p === 'all' ? SCENES.map((s) => s.id) : [SCENES.find((s) => String(s.n) === p || s.id === p)?.id ?? (p as SceneId)]));
const unknown = requested.filter((id) => !SCENES.some((s) => s.id === id));
if (!requested.length || unknown.length) {
  console.error(`${unknown.length ? `No scene ${unknown.join(', ')}. ` : ''}Scenes:\n${SCENES.map((s) => `  ${s.n} ${s.id.padEnd(11)} ${s.title}`).join('\n')}\nRun: npm run demo -- <scene|all> [--once]`);
  process.exit(1);
}

const root = new URL('../../../../', import.meta.url);
const [screenW, screenH] = values.screen.split('x').map(Number) as [number, number];
const zoom = Number(values.zoom);
const out = resolve(values.out);
// Brightwater Health, the headline example: the agent in "rules hold" fills its quote.
const health = JSON.parse(await readFile(new URL('packages/agent/profiles/test-health.json', root), 'utf8')) as Profile & { _comment?: string };
delete health._comment;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const print = (scene: string, numbers: Record<string, unknown>) => {
  console.log(`\n${scene}`);
  for (const [k, v] of Object.entries(numbers)) console.log(`  ${k.padEnd(28)} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
};

const browser: Browser = await chromium.launch({ headless: values.headless, args: [`--force-device-scale-factor=${zoom}`] });
const dir = await mkdtemp(join(tmpdir(), 'usher-live-demo-'));
const windows: BrowserContext[] = [];

/** A window at a fraction of the screen: left or right half, or the whole of it. */
async function window(where: 'left' | 'right' | 'full'): Promise<Page> {
  const w = Math.round((where === 'full' ? screenW : screenW / 2) / zoom);
  const h = Math.round(screenH / zoom);
  const context = await browser.newContext({ colorScheme: 'dark', ...(values.headless ? { viewport: { width: w, height: h } } : { viewport: null }) });
  windows.push(context);
  const page = await context.newPage();
  await place(page, where);
  return page;
}

async function place(page: Page, where: 'left' | 'right' | 'full'): Promise<void> {
  if (values.headless) return;
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
  const width = Math.round((where === 'full' ? screenW : screenW / 2) / zoom);
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: where === 'right' ? width : 0, top: 0, width, height: Math.round(screenH / zoom), windowState: 'normal' } });
}

async function closeWindows(): Promise<void> {
  for (const c of windows.splice(0)) await c.close().catch(() => undefined);
}

// Layout A's driver map, as seeded: what "current" is after a reset.
const SEEDED_DRIVER = (JSON.parse(await readFile(new URL('packages/registry/seed/mock-site/1-driver.map.json', root), 'utf8')) as UsherMap).fingerprint.digest;

/**
 * Brightwater back to the start: layout A, with layout A's driver map current. After a switch
 * back from B, a visitor stays on the page while the site script reports drift and the keeper
 * restores the earlier map (no model needed).
 */
async function reset(): Promise<Record<string, unknown>> {
  const was = await layout();
  let rebuilt: string | undefined;
  const before = await currentDigest('/quote/driver');
  if (was !== 'a' || before !== SEEDED_DRIVER) {
    if (was !== 'a') await setLayout('a');
    const started = Date.now();
    const visitor = await browser.newContext();
    const page = await visitor.newPage();
    let now = before;
    // The site script reports once per page load: look again every 20 s until the keeper has run.
    for (let tries = 0; now !== SEEDED_DRIVER && tries < 9; tries++) {
      await page.goto(DRIVER, { waitUntil: 'load' });
      now = await waitForNewMap('/quote/driver', before, 20_000);
    }
    await visitor.close();
    rebuilt = now === SEEDED_DRIVER ? secs(Date.now() - started) : `not within ${secs(Date.now() - started)}`;
  }
  const maps = Object.fromEntries(await Promise.all(PATHS.map(async (p) => [p, (await currentDigest(p))?.slice(0, 19) ?? 'none'])));
  return { 'layout': `A${was !== 'a' ? ` (was ${was.toUpperCase()})` : ''}${rebuilt ? `; keeper restored the driver map in ${rebuilt}` : ''}`, 'maps': maps };
}

// ---------------------------------------------------------------------------

async function fill(): Promise<void> {
  const state = await reset();
  const board = await window('right');
  await board.goto(`${REGISTRY}/demo/dashboard`);
  const d = await dashboard();
  print('1  usher_fill from an MCP client (record it by hand, in the client on the left)', {
    ...state,
    'hosted MCP': `${REGISTRY}/mcp`,
    'local MCP': 'npx -y @usher-run/mcp',
    'try': `"Get me a health insurance quote from Brightwater. I'm Sam Taylor, born 2 April 1988, WR14 1AA, just me, non-smoker, comprehensive cover with a £250 excess."`,
    'or the car quote': `"Get me a car insurance quote on ${new URL(SITE).host}"`,
    'dashboard': `${REGISTRY}/demo/dashboard`,
    'sessions listed now': d.sessions.length,
    'latest session': d.sessions[0] ?? 'none',
  });
}

async function ticket(): Promise<void> {
  const state = await reset();
  const sid = (await dashboard()).sessions[0];
  if (!sid) throw new Error('No session on the demo dashboard yet: run scene 1 first.');
  const { agent, events } = await timeline(sid);
  const knocks = events.filter((e) => e.action === 'knock').map((e) => ({ path: /on (\/\S+)/.exec(e.detail)?.[1] ?? '?', match: `${/match (\w+)/.exec(e.detail)?.[1] ?? '?'}${/confirmed/.test(e.detail) ? ', confirmed' : ''}`, identity: /identity ([\w-]+)/.exec(e.detail)?.[1] ?? '' }));
  const paths = [...new Set(knocks.map((k) => k.path))].filter((p) => p.startsWith('/'));
  const maps: UsherMap[] = [];
  for (const p of paths) {
    const digest = await currentDigest(p);
    if (digest) maps.push(await mapByDigest(digest));
  }
  const rules = Object.assign({}, ...(await Promise.all(maps.map(async (m) => (await rulesFor(m)).actions)))) as Record<string, string>;
  const identity = knocks[0]?.identity === 'hosted' ? 'hosted' : knocks[0]?.identity === 'web-bot-auth' ? 'Web Bot Auth' : 'signed knock';
  const t = {
    purpose: maps[0]?.form.purpose.replace(/:.*$/, '') ?? 'Car insurance quote',
    session: sid,
    agent,
    identity,
    knocks: knocks.map(({ path, match }) => ({ path, match })),
    byMeaning: events.filter((e) => e.key).length,
    confirm: Object.keys(rules).filter((k) => rules[k] === 'confirm'),
    userOnly: Object.keys(rules).filter((k) => rules[k] === 'forbid'),
    fields: maps.reduce((n, m) => n + m.fields.length, 0),
    digest: maps[0]?.fingerprint.digest ?? '',
  };
  const page = await window('full');
  await page.setContent(ticketCard(t, TOKEN_LIFETIME_SECONDS / 60));
  print('2  The ticket for the last knock', { ...state, 'session': sid, 'agent': `${agent} (${identity})`, 'knocks': t.knocks.map((k) => `${k.path} ${k.match}`).join(', '), 'fields across the maps': t.fields, 'actions done by meaning': t.byMeaning, "needs the user's OK": t.confirm.join(', '), "the user's alone": t.userOnly.join(', ') });
}

async function race(): Promise<void> {
  const state = await reset();
  const runs = (await readFile(new URL('examples/browser-use/results.jsonl', root), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { mode: string; seconds: number; steps: number; actions: string[] });
  const without = runs.find((r) => r.mode === 'without')!;
  const withFill = runs.find((r) => r.mode === 'fill')!;
  // The recordings keep each run's actions and total time, not each action's: they are spread evenly.
  const spread = (r: typeof without, steps: string[]): RaceSide['steps'] => steps.map((what, i) => ({ at: ((i + 1) * r.seconds) / steps.length, what }));
  const left: RaceSide = { title: 'Reading the form', seconds: without.seconds, steps: spread(without, without.actions) };
  const right: RaceSide = { title: 'With usher_fill', seconds: withFill.seconds, steps: spread(withFill, withFill.actions) };
  const speed = Number(values.speed);
  const page = await window('full');
  await page.setContent(raceCard(left, right, `Recorded on 27 October against the live demo site, model muse-spark-1.3; actions are spaced evenly over each run's recorded time${speed !== 1 ? `; replayed at ${speed}x` : ''}.`, speed));
  await page.evaluate('window.startRace()');
  await page.waitForTimeout((Math.max(left.seconds, right.seconds) / speed) * 1000 + 500);
  print('3  Browser Use, with and without usher_fill (replayed)', { ...state, 'reading the form': `${without.seconds} s, ${without.steps} steps`, 'with usher_fill': `${withFill.seconds} s, ${withFill.steps} steps`, 'faster': `${(without.seconds / withFill.seconds).toFixed(1)}x` });
}

async function signup(): Promise<void> {
  const state = await reset();
  const left = await window('left');
  await left.goto(`${REGISTRY}/sites/new`);
  const right = await window('right');
  await right.goto(`${REGISTRY}/demo/dashboard#sandbox`);
  const rule = 'Agents can fill in quotes, but a human confirms the submit. Max five an hour.';
  await right.locator('#rules-text').fill(rule);
  const started = Date.now();
  await Promise.all([right.waitForURL(/\/demo\/dashboard\/rules/, { timeout: 60_000, waitUntil: 'load' }), right.getByRole('button', { name: 'Preview policy' }).click()]);
  const ms = Date.now() - started;
  const card = right.locator('.card.notice:has-text("preview only"), .card.error').first();
  const preview = ((await card.locator('p.small').first().textContent().catch(() => null)) ?? (await card.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
  await card.scrollIntoViewIfNeeded().catch(() => undefined);
  print('4  Signup and the rules editor', { ...state, 'signup': `${REGISTRY}/sites/new`, 'rule': rule, 'policy from Muse Spark in': secs(ms), 'preview': preview.slice(0, 200) });
}

async function rulesHold(): Promise<void> {
  const state = await reset();
  // An agent that skips the page and posts to the quote API without knocking.
  const request = `POST ${SITE}/api/health-quote  (Usher-Agent: demo-unknocked, no token)`;
  const res = await fetch(`${SITE}/api/health-quote`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Usher-Agent': 'demo-unknocked' }, body: '{}' });
  const body = await res.text();
  const left = await window('left');
  await left.setContent(refusalCard({ request, status: res.status, body: JSON.stringify(JSON.parse(body), null, 2), then: 'On the right, an agent that knocked fills the same quote by the map, and stops at "Get my quote" until its user says yes.' }));
  // The agent that knocked: a fresh key, the registry's maps, and a user who takes a moment.
  const transport = await httpTransport(REGISTRY, join(dir, `agent-${Date.now()}.json`));
  const scripted = scriptedUser(health);
  const hold = Number(values.hold) * 1000;
  let paused = 0;
  const started = Date.now();
  const run = await runAgent({
    browser,
    url: HEALTH,
    profile: health,
    intent: 'quote.health_insurance',
    registry: transport,
    viewport: { width: Math.round(screenW / 2 / zoom), height: Math.round(screenH / zoom) - 90 },
    onPage: (page) => place(page, 'right'),
    user: {
      handoff: (field, page) => scripted.handoff(field, page),
      async confirm(action) {
        paused = Date.now() - started;
        await new Promise((r) => setTimeout(r, hold));
        return action.key === 'form.submit';
      },
    },
  });
  await transport.close();
  print('5  Rules hold', { ...state, 'unknocked API post': `HTTP ${res.status} ${(JSON.parse(body) as { error?: string }).error ?? ''}`, 'knocked agent at "Get my quote"': secs(paused), 'held for the user': secs(hold), 'outcome': `${run.outcome} in ${secs(run.total_ms)}`, 'session': run.session ?? 'none' });
}

async function siteSees(): Promise<void> {
  const state = await reset();
  const d = await dashboard();
  const left = await window('left');
  await left.goto(`${REGISTRY}/demo/dashboard#sessions`);
  const right = await window('right');
  if (d.sessions[0]) await right.goto(`${REGISTRY}/demo/dashboard/sessions/${d.sessions[0]}`);
  print('6  The site sees', { ...state, 'sessions listed': d.sessions.length, 'blocked attempts': d.blocked, 'forms explained by Muse Spark': d.explanations, 'latest session': d.sessions[0] ?? 'none' });
}

async function govuk(): Promise<void> {
  const state = await reset();
  // Try it on GOV.UK: the front page's map viewer.
  const left = await window('left');
  await left.goto(`${REGISTRY}/#try`);
  const viewStarted = Date.now();
  await Promise.all([left.waitForURL(/\/viewer/, { timeout: 120_000, waitUntil: 'load' }), left.locator('button[name="form"][value="govuk-contact"]').click()]);
  const viewMs = Date.now() - viewStarted;
  const rows = await left.locator('table tbody tr').count();
  // The form changes: layout B, a visitor, the site script reports drift, the keeper rebuilds.
  const before = await currentDigest('/quote/driver');
  await setLayout('b');
  const switched = Date.now();
  const right = await window('right');
  await right.goto(DRIVER);
  const card = await window('left');
  await card.setContent(sceneCard({ label: 'The form changed', title: 'The keeper rebuilds the map', lede: 'Brightwater switched to layout B. The site script saw a different form and reported drift; no agent was involved.', timer: { id: 't', start: switched, caption: 'Since the switch' } }));
  const after = await waitForNewMap('/quote/driver', before, 180_000);
  const rebuilt = Date.now() - switched;
  await card.evaluate(`window.stopTimer('t', ${switched + rebuilt})`);
  print('7  Try it on GOV.UK, then the form changes', { ...state, 'GOV.UK map in': `${secs(viewMs)}${viewMs < 2000 ? ' (served from cache: the keeper re-maps the picker forms after each run)' : ''}`, 'GOV.UK map rows': rows, 'layout': 'B (the next scene resets it)', 'keeper': after ? `${await keeperOutcome('/quote/driver')} the driver map in ${secs(rebuilt)}` : 'no new map within 180 s', 'map before': before?.slice(0, 19), 'map after': after?.slice(0, 19) ?? 'unchanged' });
}

async function diagram(): Promise<void> {
  const page = await window('full');
  await page.setContent(diagramCard());
  // The still, at 2x for the edit.
  const still = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const shot = await still.newPage();
  await shot.setContent(diagramCard());
  await mkdir(out, { recursive: true });
  const file = join(out, 'map-knock-log.png');
  await writeFile(file, await shot.screenshot());
  await still.close();
  print('8  Map, knock, log', { 'still': file, 'models': 'Muse Spark: maps, rules, explanations, rebuilds · Muse Spark Open: risk second opinion, keeper triage' });
}

const RUN: Record<SceneId, () => Promise<void>> = { fill, ticket, race, signup, 'rules-hold': rulesHold, 'site-sees': siteSees, govuk, diagram };

try {
  for (const id of requested) {
    await closeWindows();
    await RUN[id]();
  }
  if (!values.once) {
    console.log('\nWindows stay open for recording. Ctrl+C to finish.');
    await new Promise<void>((r) => process.once('SIGINT', () => r()));
  }
} finally {
  await closeWindows();
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}
