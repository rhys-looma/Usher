// The walkthrough mapper ("Map my site") against the mock site: refusals, branch discovery,
// lookup lists, boxes, live events, corrections, and that no typed value reaches anything kept.
// The labeller is a stand-in that answers from the mock site's seed maps by label, so the test
// runs offline and checks the walkthrough's own work: what it explores, fills, finds and keeps.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { decodeToken, generateAgentIdentity, signRequest, type ChatFn, type UsherMap } from '@usher/core';
import { createUsherCheck } from '../../site-middleware/src/index.ts';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { knockRequest, seedMaps, startRegistry, type RunningRegistry } from '../src/index.ts';
import { againstPublished, journeyIntent, onSite, ownPagesOnly, Walkthroughs, type WalkthroughRun } from '../src/walkthrough.ts';
import { TEST_PERSON } from '../src/walkthrough-persona.ts';
import { Viewer } from '../src/web/viewer.ts';
import { registerSite, type SiteKeys } from './sites.ts';
import { testStorage } from './storage-helper.ts';

const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
const seeded = await seedMaps('mock-site');
const ADVANCING = ['form.submit', 'nav.next'];
// Layouts B and C word things differently: there the stand-in answers as Muse Spark did when recorded.
let current: 'a' | 'b' | 'c' = 'a';
const recorded = new Map<string, Map<string, { key: string; risk: string }>>();
for (const l of ['b', 'c'] as const) {
  for (const step of ['driver', 'vehicle', 'cover'] as const) {
    const fixture = JSON.parse(await readFile(new URL(`../../core/test/fixtures/labels/${l}-${step}.json`, import.meta.url), 'utf8')) as { attempts: { content: string }[] };
    const labels = JSON.parse(fixture.attempts.at(-1)!.content) as { elements: { id: string; key: string; risk: string }[] };
    recorded.set(`${l}/quote/${step}`, new Map(labels.elements.map((e) => [e.id, e])));
  }
}

// The intent the stand-in names for a page, when a test wants it to differ from the seed maps'.
let namedIntent: ((path: string) => string) | null = null;

// The chat editor's answer, scripted by the test that uses it; the requests it got, to check.
let editAnswer: object = { changes: [], rules: null, unclear: null };
const editRequests: string[] = [];

/** Labels by label text from the seed maps; anything unknown is a custom key, safe. */
// What the fake Muse Spark answers in a walk's conversation: a move, given the choices it was shown.
let moveAnswer: (input: { choices: { id: string; label: string; path: string }[]; owner_says: string }) => object = () => ({ reply: 'OK.', move: 'wait', option: null, path: null, then: [] });
const moveRequests: string[] = [];
const labeller: ChatFn = async (request) => {
  if (String(request.messages[0]!.content).startsWith("You help a website's owner map")) {
    const content = String(request.messages[1]!.content);
    moveRequests.push(content);
    return { content: JSON.stringify(moveAnswer(JSON.parse(content))), usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340, cached_tokens: 0 }, latency_ms: 1, response: {} };
  }
  if (String(request.messages[0]!.content).startsWith('You help a website owner')) {
    editRequests.push(JSON.stringify(request.messages));
    return { content: JSON.stringify(editAnswer), usage: { prompt_tokens: 500, completion_tokens: 80, total_tokens: 580, cached_tokens: 0 }, latency_ms: 1, response: {} };
  }
  const user = request.messages.find((m) => m.role === 'user')!;
  const text = typeof user.content === 'string' ? user.content : user.content.map((c) => ('text' in c ? c.text : '')).join('');
  const extraction = JSON.parse(text.slice(text.indexOf('Extraction:\n') + 12)) as { page: { path: string }; elements: { id: string; kind: string; label: string; candidates: string[] }[] };
  const map = seeded.find((m) => m.path === extraction.page.path) ?? seeded[0]!;
  const all = seeded.flatMap((m) => [...m.fields, ...m.actions]);
  const find = (label: string) => [...map.fields, ...map.actions].find((e) => e.label === label) ?? all.find((e) => e.label === label);
  const elements = extraction.elements.map((e) => {
    const known = recorded.get(`${current}${extraction.page.path}`)?.get(e.id) ?? find(e.label);
    const slug = e.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'thing';
    return { id: e.id, key: known?.key ?? e.candidates[0] ?? `custom.${/^[a-z]/.test(slug) ? slug : `x_${slug}`}`, risk: known?.risk ?? 'safe', shown_if: null };
  });
  const advance = elements.find((e) => ADVANCING.includes(e.key) && extraction.elements.find((x) => x.id === e.id)?.kind === 'action');
  const content = JSON.stringify({ form: { purpose: map.form.purpose, intent: namedIntent?.(extraction.page.path) ?? map.form.intent }, elements, advance_action_id: advance?.id ?? null });
  return { content, usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, cached_tokens: 0 }, latency_ms: 1, response: {} };
};

// What the owner types: each value distinctive, so finding one anywhere is unambiguous.
const SECRET = { 'person.first_name': 'Quillonia', 'person.last_name': 'Zarathustrova', 'contact.email': 'qz7731@example.com', 'contact.phone': '07700 900731', 'address.line1': '73 Wobbleford Lane' };

let dir: string;
let running: RunningRegistry;
let site: MockSite;
let keys: SiteKeys;
let browser: Browser;
let walk: Walkthroughs;
let spent = 0;
let limit = 50;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-walkthrough-'));
  browser = await chromium.launch();
  running = await startRegistry({
    storage: await testStorage(dir),
    siteScript,
    web: { allowPrivate: true, ownerHourly: { walk: 50, chat: 2 } },
    walkthroughs: (registry) =>
      (walk = new Walkthroughs({ registry, browser: async () => browser, compiler: { chat: labeller, model: 'muse-spark-1.3' }, spend: { today: async () => spent, cap: 5 }, dailyLimit: () => limit, maxStarts: 1000, allowPrivate: true, logDir: join(dir, 'log'), frameMs: 150 })),
  });
  site = await startMockSite({ registry: running.url, register: async (o) => (keys = await registerSite(running, o)).site_key });
});
after(async () => {
  await site.stop();
  await running.close();
  await browser.close();
  await rm(dir, { recursive: true });
});

async function finished(origin: string): Promise<WalkthroughRun> {
  for (let i = 0; i < 600; i++) {
    const run = await walk.get(origin);
    if (run && run.status !== 'running') return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`walkthrough did not finish: ${(await walk.get(origin))?.log.join(' | ')}`);
}

async function runOnce(start: string, input: { values?: Record<string, string>; generated?: boolean; pressFinal?: boolean } = {}) {
  const started = await walk.start({ origin: site.url, start: `${site.url}${start}`, generated: input.generated ?? true, pressFinal: input.pressFinal ?? false, by: 'owner', ...(input.values && { values: input.values }) });
  assert.ok('id' in started, 'refused' in started ? started.refused : '');
  return finished(site.url);
}

const fieldsOf = (run: WalkthroughRun, path: string): UsherMap['fields'] => run.pages.find((p) => p.path === path)?.map.fields ?? [];

test('refusals: unclaimed site, start page elsewhere, the daily limit, the budget', async () => {
  assert.match((await walk.refusal('https://unclaimed.example', 'https://unclaimed.example/'))!, /Verify your site first/);
  // Verification withdrawn after a run finished: the run can't be published.
  await running.registry.storage.putCached('walkthrough', 'https://unclaimed.example', { status: 'stopped', pages: [{ map: { fingerprint: {} } }] });
  assert.equal(await walk.publish('https://unclaimed.example'), 0);
  assert.match((await walk.refusal(site.url, 'https://elsewhere.example/quote'))!, /must be on/);
  assert.match((await walk.refusal(site.url, 'not a url'))!, /not an address/);
  spent = 4.9;
  assert.match((await walk.refusal(site.url, `${site.url}/quote/driver`))!, /budget/);
  spent = 0;
  const before = limit;
  limit = 0;
  assert.match((await walk.refusal(site.url, `${site.url}/quote/driver`))!, /per site per day/);
  limit = before;
  assert.equal(await walk.refusal(site.url, `${site.url}/quote/driver`), null);
});

test('a start page with no form stops at once and gives the run back', async () => {
  const key = `${site.url}|${new Date().toISOString().slice(0, 10)}`;
  const used = async () => (await running.registry.storage.getCached<{ n: number }>('walkthrough-runs', key))?.n ?? 0;
  const before = await used();
  const run = await runOnce('/');
  assert.equal(run.status, 'stopped');
  assert.match(run.reason!, /No form on the start page/);
  assert.equal(run.cost_usd, 0);
  assert.equal(await used(), before);
});

/** Waits until the site's run satisfies the check. */
async function until(origin: string, check: (run: WalkthroughRun) => boolean, what: string): Promise<WalkthroughRun> {
  for (let i = 0; i < 600; i++) {
    const run = await walk.get(origin);
    if (run && check(run)) return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const lastChoices = (run: WalkthroughRun) => [...(run.chat ?? [])].reverse().find((m) => m.options)?.options ?? [];

test('a conversation: from the home page, by a click, a choice and words, two journeys in one run', async () => {
  const started = await walk.start({ origin: site.url, start: `${site.url}/`, generated: true, pressFinal: false, by: 'owner', conversation: true });
  assert.ok('id' in started);
  const id = started.id;
  try {
    // The home page has no form: Usher asks, offering the declared journeys by their link text.
    let run = await until(site.url, (r) => Boolean(r.waiting), 'the first question');
    // A page that connects after the question was asked still gets it, and knows it's the owner's turn.
    const missed: { type: string }[] = [];
    walk.subscribe(site.url, run.id, (e) => missed.push(e))?.();
    assert.ok(missed.some((e) => e.type === 'chat'), 'the conversation so far');
    assert.equal(missed.at(-1)?.type, 'waiting', 'and whose turn it is');
    assert.equal(run.pages.length, 0);
    const first = lastChoices(run);
    assert.deepEqual(first.slice(0, 2).map((c) => [c.label, c.path]), [['Health insurance', '/health/about'], ['Car insurance', '/quote/driver']]);
    assert.ok(first.every((c) => onSite(site.url, c.path)), 'every choice is on the site');

    // The owner clicks the car insurance link on the live page.
    const probe = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await probe.goto(`${site.url}/`);
    const box = (await probe.locator('a[href="/quote/driver"]').boundingBox())!;
    await probe.close();
    assert.ok(walk.click(site.url, id, box.x + box.width / 2, box.y + box.height / 2));
    assert.ok(!walk.click(site.url, id, 1, 1), 'the first answer wins');

    // The car journey is mapped up to its consequential button, then Usher asks again.
    run = await until(site.url, (r) => Boolean(r.waiting) && r.pages.length > 0, 'the end of the car journey');
    assert.deepEqual(run.pages.map((p) => p.path), ['/quote/driver', '/quote/vehicle', '/quote/cover']);
    assert.ok(run.chat!.some((m) => m.from === 'usher' && m.pages?.[0] === 0 && /^Mapped/.test(m.text)), 'each page is announced with its picture');
    const next = lastChoices(run);
    assert.ok(next.some((c) => c.path === '/health/about'), 'the health journey is offered');
    assert.ok(!next.some((c) => c.path.startsWith('/quote/')), 'mapped pages are not offered again');

    // The owner says it in words: Muse Spark picks the health journey by id.
    moveAnswer = ({ choices }) => ({ reply: 'Doing the health quote next.', move: 'option', option: choices.find((c) => c.path === '/health/about')!.id, path: null, then: [] });
    assert.equal(await walk.message(site.url, id, 'Now do the health insurance one please'), null);
    run = await until(site.url, (r) => Boolean(r.waiting) && r.pages.length > 3, 'the end of the health journey');
    assert.deepEqual(run.pages.slice(3).map((p) => p.path), ['/health/about', '/health/cover', '/health/declaration']);
    // Each journey carries the intent the site declares for it, on every page, whoever chose it.
    const declared = (await (await fetch(`${site.url}/.well-known/usher.json`)).json()) as { journeys: { start: string; intent: string }[] };
    const intentOf = (start: string) => declared.journeys.find((j) => j.start === start)!.intent;
    assert.deepEqual(run.pages.map((p) => p.map.form.intent), [...Array(3).fill(intentOf('/quote/driver')), ...Array(3).fill(intentOf('/health/about'))]);

    // An address off the site is refused, whoever suggests it.
    moveAnswer = () => ({ reply: 'Going there.', move: 'path', path: '//evil.example/x', option: null, then: [] });
    await walk.message(site.url, id, 'go to evil.example');
    run = (await walk.get(site.url))!;
    assert.ok(run.waiting, 'still waiting');
    assert.match(run.chat!.at(-1)!.text, /isn't a page on your site/);

    moveAnswer = () => ({ reply: "That's everything, then.", move: 'finish', option: null, path: null, then: [] });
    await walk.message(site.url, id, "that's all");
    run = await finished(site.url);
    assert.equal(run.status, 'stopped');
    assert.equal(run.pages.length, 6);
    assert.deepEqual(run.chat!.filter((m) => m.from === 'owner').map((m) => m.text), ['Clicked the page.', 'Now do the health insurance one please', 'go to evil.example', "that's all"]);

    // The model saw structure and the owner's words, never a test answer.
    const values = Object.values(TEST_PERSON).filter((v): v is string => typeof v === 'string' && v.length > 3);
    for (const request of moveRequests) for (const v of values) assert.ok(!request.includes(v), `a test value reached the model: ${v}`);
  } finally {
    // A failure must not leave the run waiting for an owner.
    walk.cancel(site.url, id);
    await finished(site.url);
  }
});

test('a conversation nobody answers finishes, and a run that mapped nothing gives the day back', async () => {
  const day = `${site.url}|${new Date().toISOString().slice(0, 10)}`;
  const before = (await running.registry.storage.getCached<{ n: number }>('walkthrough-runs', day))?.n ?? 0;
  const quiet = new Walkthroughs({ maxStarts: 1000, registry: running.registry, browser: async () => browser, compiler: { chat: labeller, model: 'muse-spark-1.3' }, spend: { today: async () => 0, cap: 5 }, dailyLimit: () => before + 1, allowPrivate: true, logDir: null, pauseMs: 300 });
  const started = await quiet.start({ origin: site.url, start: `${site.url}/`, generated: true, pressFinal: false, by: 'owner', conversation: true });
  assert.ok('id' in started, 'refused' in started ? started.refused : '');
  let run: WalkthroughRun | null = null;
  for (let i = 0; i < 300 && run?.status !== 'stopped'; i++) {
    await new Promise((r) => setTimeout(r, 100));
    run = await quiet.get(site.url);
  }
  assert.equal(run?.status, 'stopped');
  assert.match(run!.chat!.at(-1)!.text, /haven't heard from you/);
  assert.equal((await running.registry.storage.getCached<{ n: number }>('walkthrough-runs', day))?.n ?? 0, before);
});

/** A tiny server that counts what reaches it and serves one page. */
async function counting(page: string): Promise<{ url: string; hits: string[]; server: Server }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
    res.end(page);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, server };
}

test("Usher's browser is no one's proxy: only reads leave the site, and it never navigates away", async () => {
  const other = await counting('elsewhere');
  const registry = await counting('registry');
  const context = await browser.newContext();
  try {
    await ownPagesOnly(context, site.url, { allowPrivate: true, registry: registry.url });
    const page = await context.newPage();
    await page.goto(`${site.url}/`);
    // A string, so the bundler adds nothing the page doesn't have.
    await page.evaluate(`(async () => {
      const quietly = (p) => p.catch(() => undefined);
      await quietly(fetch('${other.url}/read'));
      await quietly(fetch('${other.url}/write', { method: 'POST', body: 'x' }));
      await quietly(fetch('${other.url}/put', { method: 'PUT', body: 'x' }));
      await quietly(fetch('${registry.url}/events', { method: 'POST', body: 'x' }));
    })()`);
    assert.deepEqual(other.hits, ['GET /read']);
    assert.deepEqual(registry.hits, ['POST /events']);
    await assert.rejects(page.goto(`${other.url}/away`));
    assert.ok(!other.hits.includes('GET /away'));
  } finally {
    await context.close();
    other.server.close();
    registry.server.close();
  }
});

test("the conversation's limits: a daily allowance per site, one reading at a time, 40 a run", async () => {
  const thrifty = new Walkthroughs({ registry: running.registry, browser: async () => browser, compiler: { chat: labeller, model: 'muse-spark-1.3' }, spend: { today: async () => 0, cap: 5 }, dailyLimit: () => 50, maxStarts: 50, allowPrivate: true, logDir: null, chatBudgetUsd: 0 });
  const started = await thrifty.start({ origin: site.url, start: `${site.url}/`, generated: true, pressFinal: false, by: 'owner', conversation: true });
  assert.ok('id' in started, 'refused' in started ? started.refused : '');
  try {
    for (let i = 0; i < 300 && !(await thrifty.get(site.url))?.waiting; i++) await new Promise((r) => setTimeout(r, 100));
    const asked = moveRequests.length;
    await thrifty.message(site.url, started.id, 'do the car one');
    assert.equal(moveRequests.length, asked, 'no model call once the allowance is spent');
    assert.match((await thrifty.get(site.url))!.chat!.at(-1)!.text, /messages for today are used up/);
    assert.ok(thrifty.choose(site.url, started.id, 'finish'), 'choices still work');
  } finally {
    thrifty.cancel(site.url, started.id);
  }
});

test("owners' messages are limited per address an hour", async () => {
  const login = await fetch(`${running.url}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: keys.origin, secret: keys.secret_key }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const say = () => fetch(`${running.url}/dashboard/walkthrough/say`, { method: 'POST', headers: { Cookie: cookie, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'id=w_none&text=hello' });
  assert.notEqual((await say()).status, 429);
  assert.notEqual((await say()).status, 429);
  assert.equal((await say()).status, 429);
});

test("Usher's admin has none of the per-site or per-day limits", async () => {
  const strict = new Walkthroughs({ registry: running.registry, browser: async () => browser, compiler: { chat: labeller, model: 'muse-spark-1.3' }, spend: { today: async () => 0, cap: 5 }, dailyLimit: () => 0, maxStarts: 0, allowPrivate: true, logDir: null });
  assert.match((await strict.refusal(site.url, `${site.url}/quote/driver`))!, /started today/);
  assert.equal(await strict.refusal(site.url, `${site.url}/quote/driver`, true), null);
});

test('caps: starts per site per day, whatever was given back, and runs at once', async () => {
  const options = { registry: running.registry, browser: async () => browser, compiler: { chat: labeller, model: 'muse-spark-1.3' }, spend: { today: async () => 0, cap: 5 }, dailyLimit: () => 50, allowPrivate: true, logDir: null };
  assert.match((await new Walkthroughs({ ...options, maxStarts: 0 }).refusal(site.url, `${site.url}/quote/driver`))!, /started today/);
  assert.match((await new Walkthroughs({ ...options, maxLive: 0 }).refusal(site.url, `${site.url}/quote/driver`))!, /several sites/);
});

test("on a site that hasn't joined, the owner can't click: Usher never presses anything there", async () => {
  const listed = await counting('<!doctype html><title>Listed</title><a href="/b" style="display:block;width:400px;height:200px">B</a>');
  await running.registry.setListed(listed.url, { name: 'Listed', journeys: [] });
  try {
    const started = await walk.start({ origin: listed.url, start: `${listed.url}/`, generated: true, pressFinal: false, by: 'owner', conversation: true });
    assert.ok('id' in started, 'refused' in started ? started.refused : '');
    const run = await until(listed.url, (r) => Boolean(r.waiting), 'the question');
    assert.equal(run.clickable, false);
    assert.equal(walk.click(listed.url, started.id, 100, 100), false);
    assert.ok(walk.choose(listed.url, started.id, 'finish'));
    assert.equal((await finished(listed.url)).status, 'stopped');
  } finally {
    await running.registry.setListed(listed.url, null);
    listed.server.close();
  }
});

test("a mapper's token (the owner's walkthrough) is for any intent and isn't held by the site's rules; no agent gets one", async () => {
  const usher = createUsherCheck({ registry: running.url, intent: 'quote.car_insurance', origin: site.url });
  const identity = (await generateAgentIdentity()).identity;
  const knock = async (as?: { walkthrough: string }) => ((await running.registry.knock(await signRequest(knockRequest({ url: `${site.url}/quote/cover`, intent: 'booking.table' }), identity), null, as)).body as { token: string }).token;
  const status = async (token: string, action: string) => {
    const r = await usher.check({ headers: { 'x-usher-token': token } } as never, { action });
    return r.status === 'knock_required' ? r.reason : r.status;
  };
  const mapper = await knock({ walkthrough: new URL(site.url).host });
  assert.equal(decodeToken(mapper)!.claims.scope, 'map');
  // Another intent, a consequential action unconfirmed, and one only the person may do: all fine for the owner's mapper.
  assert.equal(await status(mapper, 'form.submit'), 'ok');
  assert.equal(await status(await knock({ walkthrough: new URL(site.url).host }), 'form.purchase'), 'ok');
  // Still one use per token.
  assert.equal(await status(mapper, 'form.submit'), 'replayed');
  // An agent's knock, the same in every other way, gets an ordinary token.
  const agent = await knock();
  assert.equal(decodeToken(agent)!.claims.scope, undefined);
  assert.equal(await status(agent, 'form.submit'), 'wrong_intent');
});

test('onSite: paths on the origin only', () => {
  const o = 'https://shop.example';
  assert.equal(onSite(o, '/quote?x=1'), '/quote?x=1');
  for (const bad of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', 'quote', '/a b', 'javascript:alert(1)']) assert.equal(onSite(o, bad), null, bad);
});

test('the health journey: every page, lookup lists, boxes, stops before the quote', async () => {
  const run = await runOnce('/health/about');
  assert.equal(run.status, 'stopped', run.reason);
  assert.match(run.reason!, /Get my quote/);
  assert.deepEqual(run.pages.map((p) => p.path), ['/health/about', '/health/cover', '/health/declaration']);
  assert.equal(run.pages[0]!.leads_to, '/health/cover');
  assert.equal(run.pages[1]!.leads_to, '/health/declaration');
  assert.ok(run.pages[0]!.lists.some((l) => l.options > 0 && /address/i.test(l.via)), `address lookup list: ${JSON.stringify(run.pages[0]!.lists)}`);
  for (const p of run.pages) {
    for (const el of [...p.map.fields, ...p.map.actions]) assert.ok(el.box && el.box.width > 0 && el.box.height > 0, `${p.path} ${el.label} has a box`);
    assert.ok(p.screenshot.length > 1000);
  }
  assert.ok(run.plan, 'a plan for the journey');
  assert.ok(run.diff?.length === 3);
});

test('one intent for the whole journey: the one the site declares, whatever the model names on each page', async () => {
  // The model names each page's intent its own way; the site declares quote.health_insurance for /health/about.
  namedIntent = (path) => `quote.${path.split('/').pop()}_cover`;
  try {
    const run = await runOnce('/health/about');
    assert.deepEqual(run.pages.map((p) => p.map.form.intent), ['quote.health_insurance', 'quote.health_insurance', 'quote.health_insurance']);
    assert.ok(run.log.includes('The task\'s intent: quote.health_insurance, as the site declares it.'), run.log.join(' | '));
  } finally {
    namedIntent = null;
  }
  // A site that declares nothing: the first page's intent, for every page.
  assert.deepEqual(journeyIntent([], ['/book/pet'], 'booking.vet_appointment'), { intent: 'booking.vet_appointment', declared: false });
  assert.deepEqual(journeyIntent([{ start: '/book/pet', intent: 'booking.appointment' }], ['/book/pet?restart', '/book/pet'], 'booking.vet_appointment'), { intent: 'booking.appointment', declared: true });
});

for (const layout of ['a', 'b', 'c'] as const) {
  test(`car journey, layout ${layout}: the claims question shows its follow-ups; lookup lists are found`, async () => {
    await site.setLayout(layout);
    current = layout;
    try {
      const run = await runOnce('/quote/driver');
      assert.equal(run.status, 'stopped', run.reason);
      assert.deepEqual(run.pages.map((p) => p.path), ['/quote/driver', '/quote/vehicle', '/quote/cover']);
      const driver = fieldsOf(run, '/quote/driver');
      const shown = driver.filter((f) => f.shown_if?.field === 'person.claims.has_any');
      assert.ok(shown.length >= 1, `claims follow-ups: ${JSON.stringify(run.pages[0]!.conditions)}`);
      assert.ok(shown.every((f) => f.shown_if!.op === 'equals'));
      // Layout C looks the address up from the postcode, and lists what it finds.
      if (layout === 'c') assert.ok(run.pages[0]!.lists.some((l) => l.options > 0), `address lookup list: ${JSON.stringify(run.pages[0]!.lists)}`);
    } finally {
      await site.setLayout('a');
      current = 'a';
    }
  });
}

/** Everything the registry kept or sent about runs: storage, logs and every live event. */
async function everythingKept(): Promise<string> {
  const files: string[] = [];
  const walkDir = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walkDir(p);
      else files.push(await readFile(p, 'utf8').catch(() => ''));
    }
  };
  await walkDir(dir);
  return files.join('\n');
}

test('no typed value is kept, logged or streamed: completed, cancelled and failed runs', async () => {
  const events: string[] = [];
  const watch = (id: string) => walk.subscribe(site.url, id, (e) => events.push(JSON.stringify(e)));
  // Completed (stopped before the quote, the normal end).
  let started = await walk.start({ origin: site.url, start: `${site.url}/health/about`, values: SECRET, generated: true, pressFinal: false, by: 'owner' });
  assert.ok('id' in started);
  watch(started.id);
  const done = await finished(site.url);
  assert.ok(['stopped', 'completed'].includes(done.status));
  // Cancelled as soon as it starts.
  started = await walk.start({ origin: site.url, start: `${site.url}/quote/driver`, values: SECRET, generated: true, pressFinal: false, by: 'owner' });
  assert.ok('id' in started);
  watch(started.id);
  walk.cancel(site.url, started.id);
  assert.equal((await finished(site.url)).status, 'cancelled');
  // Failed: a page that does not exist.
  started = await walk.start({ origin: site.url, start: `${site.url}/quote/nowhere`, values: SECRET, generated: false, pressFinal: false, by: 'owner' });
  assert.ok('id' in started);
  watch(started.id);
  assert.notEqual((await finished(site.url)).status, 'completed');

  const kept = (await everythingKept()) + events.join('\n') + JSON.stringify(await walk.get(site.url));
  for (const value of Object.values(SECRET)) assert.ok(!kept.includes(value), `"${value}" was kept somewhere`);
  assert.ok(events.some((e) => e.includes('"frame"')), 'frames were streamed');
});

test('screenshots mask every field: the centre of each field box is the mask colour', async () => {
  const run = await runOnce('/quote/driver', { values: SECRET });
  const page = await browser.newPage();
  try {
    for (const p of run.pages) {
      const boxes = p.map.fields.filter((f) => f.box && f.control !== 'checkbox' && f.control !== 'radio').map((f) => f.box!);
      const colours = await page.evaluate(
        async ({ png, boxes }) => {
          const img = new Image();
          img.src = `data:image/png;base64,${png}`;
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          return boxes.map((b) => Array.from(ctx.getImageData(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2), 1, 1).data.slice(0, 3)));
        },
        { png: p.screenshot, boxes },
      );
      for (const [r, g, b] of colours) assert.ok(Math.abs(r! - 0xc9) < 12 && Math.abs(g! - 0xcc) < 12 && Math.abs(b! - 0xd4) < 12, `${p.path}: unmasked pixel ${r},${g},${b}`);
    }
  } finally {
    await page.close();
  }
});

test('through the dashboard: start, live events close cleanly, correct, publish', async () => {
  const login = await fetch(`${running.url}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: keys.origin, secret: keys.secret_key }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const post = (path: string, form: Record<string, string>) => fetch(`${running.url}${path}`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie }, body: new URLSearchParams(form) });

  const overview = await (await fetch(`${running.url}/dashboard`, { headers: { Cookie: cookie } })).text();
  assert.match(overview, /Map my site/);
  const refused = await post('/dashboard/walkthrough', { start: 'https://elsewhere.example/', generated: '1' });
  assert.equal(refused.status, 422);
  // Each run maps up to the final button, then asks the owner where next: the test stops it there.
  const stopWhenAsked = async () => {
    for (let i = 0; i < 600; i++) {
      const now = await walk.get(site.url);
      if (!now || now.status !== 'running') return;
      if (now.waiting) return void walk.cancel(site.url, now.id);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const started = await post('/dashboard/walkthrough', { start: `${site.url}/quote/driver`, generated: '1', values: 'person.first_name: Quillonia' });
  assert.equal(started.status, 303);
  void stopWhenAsked();
  const run = await walk.get(site.url);
  assert.equal(run?.status, 'running');

  // The live stream: log lines and frames, then done, then the response ends.
  const res = await fetch(`${running.url}/dashboard/walkthrough/events?id=${run!.id}`, { headers: { Cookie: cookie } });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const text = await res.text();
  assert.match(text, /event: log/);
  assert.match(text, /event: done/);
  assert.ok(!text.includes('Quillonia'));

  const view = await (await fetch(`${running.url}/dashboard/walkthrough`, { headers: { Cookie: cookie } })).text();
  assert.match(view, /class="box /);
  // Step two of setup: the setup strip, mapping still to do until the owner publishes.
  assert.match(view, /<ol class="strip"><li class="done">[^]*?<li class="todo"><span class="mark" aria-hidden="true"><\/span><span><a href="\/dashboard\/walkthrough">Mapped: your forms, checked by you<\/a>/);
  assert.match(view, /src="\/walkthrough\.js"/);

  // A correction: kept, logged as owner-verified, structure only.
  const done = await finished(site.url);
  const el = done.pages[0]!.map.fields.find((f) => f.key === 'person.first_name')!;
  const corrected = await post('/dashboard/walkthrough/correct', { path: '/quote/driver', id: el.id, key: 'custom.forename', risk: 'safe' });
  assert.equal(corrected.status, 303);
  assert.equal((await walk.get(site.url))!.pages[0]!.map.fields.find((f) => f.id === el.id)!.key, 'custom.forename');
  const logs = await everythingKept();
  assert.match(logs, /"owner_verified":true/);
  assert.ok(!logs.includes('Quillonia'));
  const bad = await post('/dashboard/walkthrough/correct', { path: '/quote/driver', id: el.id, key: 'Not A Key' });
  assert.equal(bad.status, 422);

  // Publish: the proposal becomes the maps agents get.
  assert.equal((await post('/dashboard/walkthrough/publish', {})).status, 303);
  const maps = await running.registry.currentMaps(site.url);
  assert.equal(maps.get('/quote/driver')?.fields.find((f) => f.id === el.id)?.key, 'custom.forename');
  assert.ok(![...maps.values()].some((m) => [...m.fields, ...m.actions].some((e) => 'box' in e)), 'published maps carry no boxes');
  // After publishing: mapped is done, and the page points to the next step of setup.
  const after = await (await fetch(`${running.url}/dashboard/walkthrough`, { headers: { Cookie: cookie } })).text();
  assert.match(after, /<b>Published\.<\/b> Each one is a task in your assistant app now, and agents get these maps too\. Next: <a href="\/dashboard#rules">Rules: what assistants may do, in your words<\/a>\./);

  // Again, now the site has maps: an update by default, and the owner's correction is kept.
  const form = await (await fetch(`${running.url}/dashboard/walkthrough/new`, { headers: { Cookie: cookie } })).text();
  assert.match(form, /<input type="radio" name="mode" value="update" checked> <span><b>Update them<\/b>/);
  assert.ok(!form.includes('isn&#39;t published') && !form.includes("isn't published"), 'nothing unpublished to lose');
  assert.equal((await post('/dashboard/walkthrough', { start: `${site.url}/quote/driver`, generated: '1' })).status, 303);
  await stopWhenAsked();
  const update = await finished(site.url);
  assert.equal(update.mode, 'update');
  const kept = update.pages.find((p) => p.path === '/quote/driver')!;
  assert.ok(kept.map.fields.some((f) => f.key === 'custom.forename'), 'the correction survives the update');
  assert.deepEqual(kept.status ?? {}, {}, 'nothing new on an unchanged page');
  assert.match(await (await fetch(`${running.url}/dashboard/walkthrough`, { headers: { Cookie: cookie } })).text(), /An update of your published maps:<\/b> your labels and corrections are kept, and nothing is new/);
  // Not published yet: the start form says a new run would replace it.
  assert.match(await (await fetch(`${running.url}/dashboard/walkthrough/new`, { headers: { Cookie: cookie } })).text(), /Your last run isn't published/);
});

test('againstPublished: matched by id or name, else label; an update keeps the published labels, a fresh run marks differences', () => {
  const published = JSON.parse(readFileSync(new URL('../../../spec/examples/quote-driver.map.json', import.meta.url), 'utf8')) as UsherMap;
  const first = published.fields.find((f) => f.key === 'person.first_name')!;
  first.key = 'custom.forename';
  first.label = 'Forename';
  const fresh = JSON.parse(readFileSync(new URL('../../../spec/examples/quote-driver.map.json', import.meta.url), 'utf8')) as UsherMap;
  // Something the published map never had.
  fresh.fields.push({ ...structuredClone(fresh.fields.find((f) => f.key === 'person.last_name')!), id: 'e900', key: 'person.middle_name', label: 'Middle name', locators: [{ by: 'name', value: 'middle_name' }] });
  const compare = structuredClone(fresh);
  assert.deepEqual(againstPublished(compare, published, false), { [first.id]: 'changed', e900: 'new' });
  assert.equal(againstPublished(fresh, published, true).e900, 'new');
  const updated = fresh.fields.find((f) => f.id === first.id)!;
  assert.deepEqual([updated.key, updated.label], ['custom.forename', 'Forename'], 'by id or name, though the label changed');
  assert.deepEqual(againstPublished(fresh, undefined, true), {}, 'nothing published, nothing to mark');
});

test('finetune:export takes the owner\'s answer over the model\'s, and counts it', async () => {
  const out = join(dir, 'finetune');
  const script = fileURLToPath(new URL('../../core/scripts/finetune-export.ts', import.meta.url));
  await promisify(execFile)(process.execPath, ['--import', 'tsx', script, '--log', join(dir, 'log'), '--out', out], { cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
  const stats = JSON.parse(await readFile(join(out, 'stats.json'), 'utf8')) as { owner_corrections: number; owner_verified: { total: number } };
  assert.ok(stats.owner_corrections >= 1);
  assert.equal(stats.owner_verified.total, 1);
  const rows = (await readFile(join(out, 'train.jsonl'), 'utf8')) + (await readFile(join(out, 'eval.jsonl'), 'utf8'));
  assert.match(rows, /"key":"custom\.forename"/);
  assert.ok(!rows.includes('Quillonia'));
});

test('the picker\'s "See how Usher reads this form": the map\'s own locators give every box, no model call', async () => {
  const viewer = new Viewer({ storage: running.registry.storage, allowPrivate: true, chat: async () => assert.fail('no model call expected'), model: 'muse-spark-1.3', forms: [{ id: 'driver', name: 'Driver', about: 'The mock driver page', url: `${site.url}/quote/driver` }] });
  try {
    assert.equal(await viewer.annotate('driver'), null, 'nothing to draw before the form is picked');
    const driver = seeded.find((m) => m.path === '/quote/driver')!;
    await running.registry.storage.putCached('viewer-pick', 'driver', { map: driver, model: 'muse-spark-1.3', compiled_at: new Date().toISOString() });
    const drawn = await viewer.annotate('driver');
    assert.ok(drawn && drawn.screenshot.length > 1000);
    const visible = drawn.map.fields.filter((f) => !f.shown_if);
    assert.ok(visible.every((f) => f.box && f.box.width > 0), `boxes: ${visible.filter((f) => !f.box).map((f) => f.label)}`);
    assert.ok(drawn.map.actions.every((a) => a.box));
  } finally {
    await viewer.close();
  }
});

test('in production a site whose address is private gets nowhere: every request must reach a public address', async () => {
  const strict = new Walkthroughs({ maxStarts: 1000, registry: running.registry, browser: async () => browser, compiler: { chat: labeller, model: 'muse-spark-1.3' }, spend: { today: async () => 0, cap: 5 }, dailyLimit: () => 50, logDir: null });
  const started = await strict.start({ origin: site.url, start: `${site.url}/quote/driver`, generated: true, pressFinal: false, by: 'owner' });
  assert.ok('id' in started);
  let run = await strict.get(site.url);
  for (let i = 0; i < 300 && run?.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 100));
    run = await strict.get(site.url);
  }
  assert.equal(run?.status, 'failed');
  assert.equal(run?.pages.length, 0);
});

test('the operator walks the public demo site only, and anyone can watch at /demo/walkthrough', async () => {
  let demoWalk!: Walkthroughs;
  const demo = await startRegistry({
    storage: await testStorage(await mkdtemp(join(tmpdir(), 'usher-walkthrough-demo-'))),
    siteScript,
    publicDemo: { origin: site.url, keepAgents: [] },
    web: { allowPrivate: true, adminKey: 'test-admin-key' },
    walkthroughs: (registry) => (demoWalk = new Walkthroughs({ maxStarts: 1000, registry, browser: async () => browser, compiler: { chat: labeller, model: 'muse-spark-1.3' }, spend: { today: async () => 0, cap: 5 }, dailyLimit: () => 5, allowPrivate: true, logDir: null })),
  });
  try {
    const before = await (await fetch(`${demo.url}/demo/walkthrough`)).text();
    assert.match(before, /Watch Usher map a site/);
    const login = await fetch(`${demo.url}/admin/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ key: 'test-admin-key' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await fetch(`${demo.url}/admin/walkthrough`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ path: '/health/about' }) })).status === 303, false, 'not without the admin cookie');
    const started = await fetch(`${demo.url}/admin/walkthrough`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie }, body: new URLSearchParams({ path: '/health/about' }) });
    assert.equal(started.status, 303);
    const run = (await demoWalk.get(site.url))!;
    assert.equal(run.start, `${site.url}/health/about`);
    const live = await fetch(`${demo.url}/demo/walkthrough/events?id=${run.id}`);
    assert.match(await live.text(), /event: done/);
    const after = await (await fetch(`${demo.url}/demo/walkthrough`)).text();
    assert.match(after, /class="box /);
    assert.ok(!after.includes('Correct</summary>'), 'the public view cannot correct');
  } finally {
    await demo.close();
  }
});

test('the chat editor: a sentence becomes proposed changes, checked, applied only when the owner accepts', async () => {
  await runOnce('/health/about', { values: SECRET });
  const login = await fetch(`${running.url}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: keys.origin, secret: keys.secret_key }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const post = (path: string, form: Record<string, string>) => fetch(`${running.url}${path}`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie }, body: new URLSearchParams(form) });
  const view = async () => (await fetch(`${running.url}/dashboard/walkthrough`, { headers: { Cookie: cookie } })).text();
  const field = (key: string) => (walk.get(site.url) as Promise<WalkthroughRun>).then((r) => r.pages[0]!.map.fields.find((f) => f.key === key));

  assert.match(await view(), /Change it in words/);
  const first = (await field('person.first_name'))!;
  editAnswer = {
    changes: [
      { path: '/health/about', id: first.id, key: 'custom.forename', risk: null, label: null, why: 'the owner calls it the forename' },
      { path: '/health/about', id: 'e999', key: 'person.title', risk: null, label: null, why: 'invented' },
      { path: '/health/about', id: first.id, key: 'Not A Key', risk: null, label: null, why: 'bad' },
    ],
    rules: 'Only customers answer the medical questions.',
    unclear: null,
  };
  assert.equal((await post('/dashboard/walkthrough/edit', { text: 'Call first name the forename, and only customers answer medical questions' })).status, 303);
  const proposed = await view();
  assert.match(proposed, /Make these changes/);
  assert.match(proposed, /custom\.forename/);
  assert.match(proposed, /sounds like a site rule/);
  assert.match(proposed, /isn&#39;t in the walkthrough|isn't in the walkthrough/);
  assert.match(proposed, /Not A Key is not a key/);
  assert.equal((await field('person.first_name'))?.id, first.id, 'nothing changes before the owner accepts');
  // The model saw structure and the owner's words, never a typed value.
  for (const value of Object.values(SECRET)) assert.ok(!editRequests.join('').includes(value), value);

  const id = /name="id" value="(e_[0-9a-f]+)"/.exec(proposed)![1]!;
  assert.equal((await post('/dashboard/walkthrough/edit/apply', { id })).status, 303);
  assert.equal((await field('custom.forename'))?.id, first.id);
  assert.match(await everythingKept(), /"owner_verified":true/);
  assert.equal((await post('/dashboard/walkthrough/edit/apply', { id })).status, 409, 'a proposal applies once');

  editAnswer = { changes: [], rules: null, unclear: 'Which page do you mean?' };
  await post('/dashboard/walkthrough/edit', { text: 'fix it' });
  assert.match(await view(), /Which page do you mean\?/);
  assert.equal((await post('/dashboard/walkthrough/edit/discard', {})).status, 303);
  assert.doesNotMatch(await view(), /Which page do you mean/);
});

test('on a listed site that hasn\'t joined, the walk never presses the final step, whatever was ticked', async () => {
  const origin = 'http://127.0.0.1:9';
  await running.registry.setListed(origin, { name: 'Unjoined', journeys: [] });
  const started = await walk.start({ origin, start: `${origin}/quote`, generated: true, pressFinal: true, by: 'operator' });
  assert.ok('id' in started, 'refused' in started ? started.refused : '');
  const run = await finished(origin);
  assert.ok(run.log.some((l) => /has not joined Usher, so the walk stops before the final step/.test(l)), run.log.join('\n'));
  await running.registry.setListed(origin, null);
});
