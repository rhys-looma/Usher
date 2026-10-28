// The walkthrough mapper ("Map my site") against the mock site: refusals, branch discovery,
// lookup lists, boxes, live events, corrections, and that no typed value reaches anything kept.
// The labeller is a stand-in that answers from the mock site's seed maps by label, so the test
// runs offline and checks the walkthrough's own work: what it explores, fills, finds and keeps.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import type { ChatFn, UsherMap } from '@usher/core';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { seedMaps, startRegistry, type RunningRegistry } from '../src/index.ts';
import { Walkthroughs, type WalkthroughRun } from '../src/walkthrough.ts';
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

/** Labels by label text from the seed maps; anything unknown is a custom key, safe. */
const labeller: ChatFn = async (request) => {
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
  const content = JSON.stringify({ form: { purpose: map.form.purpose, intent: map.form.intent }, elements, advance_action_id: advance?.id ?? null });
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
    web: { allowPrivate: true },
    walkthroughs: (registry) =>
      (walk = new Walkthroughs({ registry, browser: async () => browser, compiler: { chat: labeller, model: 'muse-spark-1.3' }, spend: { today: async () => spent, cap: 5 }, dailyLimit: () => limit, allowPrivate: true, logDir: join(dir, 'log'), frameMs: 150 })),
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
  assert.match((await walk.refusal('https://unclaimed.example', 'https://unclaimed.example/'))!, /not proved/);
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
  const started = await post('/dashboard/walkthrough', { start: `${site.url}/quote/driver`, generated: '1', values: 'person.first_name: Quillonia' });
  assert.equal(started.status, 303);
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
  const strict = new Walkthroughs({ registry: running.registry, browser: async () => browser, compiler: { chat: labeller, model: 'muse-spark-1.3' }, spend: { today: async () => 0, cap: 5 }, dailyLimit: () => 50, logDir: null });
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
    walkthroughs: (registry) => (demoWalk = new Walkthroughs({ registry, browser: async () => browser, compiler: { chat: labeller, model: 'muse-spark-1.3' }, spend: { today: async () => 0, cap: 5 }, dailyLimit: () => 5, allowPrivate: true, logDir: null })),
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
