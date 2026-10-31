// The site script on a single-page app: Kestrel, the React demo site (examples/sites), which moves
// between steps with history.pushState and posts each step itself with fetch.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { fingerprint, generateAgentIdentity, mainForm, mergeMap, scanScript, validateLabels, type Scan, type UsherMap } from '@usher/core';
import { RegistryClient, startRegistry, type RunningRegistry } from '@usher/registry';
import { registerSite } from '../../registry/test/sites.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';

const siteScript = fileURLToPath(new URL('../dist/usher.js', import.meta.url));
const sitesDir = fileURLToPath(new URL('../../../examples/sites/', import.meta.url));
const built = existsSync(join(sitesDir, 'public/kestrel.app.js')) && existsSync(fileURLToPath(new URL('../../site-middleware/dist/index.js', import.meta.url)));

interface DemoField {
  name: string;
  type: string;
  min?: number;
  options?: { value: string }[];
  showIf?: [string, string];
}
interface DemoSite {
  journeys: Record<string, { intent: string; steps: Record<string, { fields: DemoField[] }> }>;
}

let dir: string;
let registry: RunningRegistry;
let server: ChildProcess;
let origin: string;
let browser: Browser;
let client: RegistryClient;
let steps: Record<string, { fields: DemoField[] }>;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

// A valid answer for each field, from the site's own data. Nothing here is checked but its shape.
function answer(f: DemoField): string {
  if (f.options) return f.options[0]!.value;
  if (f.type === 'checkbox') return 'yes';
  if (f.type === 'email') return 'sam@example.com';
  if (f.type === 'number') return String(f.min ?? 1);
  if (f.type === 'date') return '2027-01-15';
  if (f.name.includes('postcode')) return 'SW1A 1AA';
  return 'Test';
}
const shownFields = (fields: DemoField[]) => fields.filter((f) => !f.showIf || fields.find((o) => o.name === f.showIf![0]) && answer(fields.find((o) => o.name === f.showIf![0])!) === f.showIf[1]);

async function fillStep(page: Page, step: string): Promise<void> {
  for (const f of shownFields(steps[step]!.fields)) {
    const value = answer(f);
    if (f.type === 'radio') await page.locator(`input[name="${f.name}"][value="${value}"]`).check();
    else if (f.type === 'checkbox') await page.locator(`input[name="${f.name}"]`).check();
    else if (f.type === 'select') await page.locator(`select[name="${f.name}"]`).selectOption(value);
    else await page.locator(`[name="${f.name}"]`).fill(value);
  }
}

/** A context on a step, with the earlier steps posted as a person would (no token). */
async function openAt(step: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const order = Object.keys(steps);
  for (const earlier of order.slice(0, order.indexOf(step))) {
    const form = Object.fromEntries(shownFields(steps[earlier]!.fields).map((f) => [f.name, answer(f)]));
    await context.request.post(`${origin}/switch/${earlier}`, { form, maxRedirects: 0 });
  }
  const page = await context.newPage();
  await page.goto(`${origin}/switch/${step}${step === order[0] ? '?restart' : ''}`);
  await page.evaluate(() => window.usher.ready);
  return { context, page };
}

// Each step's map, labelled by hand: its own fields (and Back) as custom keys, Continue as nav.next and the
// final button as form.submit (consequential, so held until the user confirms).
async function mapStep(step: string, final: boolean): Promise<UsherMap> {
  const { context, page } = await openAt(step);
  const scan: Scan = await page.evaluate(scanScript());
  await context.close();
  const form = mainForm(scan.forms)!;
  const button = form.elements.find((e) => e.kind === 'action' && e.control === 'submit')!;
  const labels = {
    form: { purpose: 'Get an energy price and switch', intent: 'quote.energy' },
    elements: [
      ...form.elements.filter((e) => e.visible && e !== button).map((e) => ({ id: e.id, key: `custom.${step}_${e.id}`, risk: 'safe' as const, shown_if: null })),
      { id: button.id, key: final ? 'form.submit' : 'nav.next', risk: final ? ('consequential' as const) : ('safe' as const), shown_if: null },
    ],
    advance_action_id: button.id,
  };
  const validation = validateLabels(labels, form.elements);
  assert.ok(validation.ok, JSON.stringify(validation.errors));
  return mergeMap({ form, fingerprint: await fingerprint(form.elements), validation, origin, path: `/switch/${step}`, provenance: { source: 'compiled', compiler: 'test', created_at: '2026-10-30T09:00:00Z', verified: true } });
}

before(async () => {
  if (!built) return;
  dir = await mkdtemp(join(tmpdir(), 'usher-spa-'));
  registry = await startRegistry({ storage: await testStorage(dir), siteScript });
  const { sites } = (await import(new URL('sites.mjs', `file://${sitesDir}`).href)) as { sites: Record<string, DemoSite> };
  steps = sites.kestrel!.journeys.switch!.steps;
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const keys = await registerSite(registry, origin);
  server = spawn(process.execPath, [join(sitesDir, 'server.mjs')], {
    env: {
      ...process.env,
      SITES: 'kestrel',
      HOST: '127.0.0.1',
      PORT_BASE: String(port - Object.keys(sites).indexOf('kestrel')),
      USHER_REGISTRY_URL: registry.url,
      USHER_SITE_KEY_KESTREL: keys.site_key,
      SITES_SETTINGS: join(dir, 'settings.json'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    server.stdout!.on('data', (d: Buffer) => d.toString().includes('on port') && resolve());
    server.once('exit', () => reject(new Error('the demo sites server stopped')));
  });
  browser = await chromium.launch();
  client = new RegistryClient(registry.url, (await generateAgentIdentity()).identity);
  const order = Object.keys(steps);
  for (const [i, step] of order.entries()) await registry.registry.addMap(await mapStep(step, i === order.length - 1));
});
after(async () => {
  if (!built) return;
  await browser.close();
  server.kill();
  await registry.close();
  await rm(dir, { recursive: true });
});

async function knock(page: Page, extra: { session?: string; confirmed?: string[] } = {}) {
  const scan: Scan = await page.evaluate(scanScript());
  return client.knock({ url: page.url(), fingerprint: await fingerprint(mainForm(scan.forms)!.elements), ...extra });
}

const posts = (page: Page) => {
  const seen: string[] = [];
  page.on('request', (r) => r.method() === 'POST' && r.url().startsWith(origin) && seen.push(new URL(r.url()).pathname));
  return seen;
};

test('a held submit reaches neither the server nor the app\'s own fetch', { skip: !built && 'run npm run build first' }, async () => {
  const { context, page } = await openAt('tariff');
  const knocked = await knock(page);
  assert.equal(knocked.match.kind, 'exact');
  assert.deepEqual(await page.evaluate((t) => window.usher.bind(t), knocked.token), { ok: true, session: knocked.session });
  const sent = posts(page);
  await fillStep(page, 'tariff');
  await page.getByRole('button', { name: 'See my prices' }).click();
  await page.waitForTimeout(300);
  assert.deepEqual(sent, [], 'the app did not post the form');
  assert.equal((await page.evaluate(() => window.usher.state())).state, 'awaiting_confirmation');
  assert.equal(await page.getByRole('alert').count(), 0, 'no refusal shown to the person');

  // Confirmed: the app posts it, with the token, and the server accepts.
  const confirmed = await knock(page, { session: knocked.session, confirmed: ['form.submit'] });
  await page.evaluate((t) => window.usher.bind(t), confirmed.token);
  await page.evaluate(() => window.usher.confirm('form.submit'));
  await Promise.all([page.waitForURL(/\/switch\/result$/), page.getByRole('button', { name: 'See my prices' }).click()]);
  assert.deepEqual(sent, ['/switch/tariff']);
  await context.close();
});

test('an agent bound on the first step is judged by each later step\'s own map, as the app moves with pushState', { skip: !built && 'run npm run build first' }, async () => {
  const { context, page } = await openAt('home');
  const knocked = await knock(page);
  await page.evaluate((t) => window.usher.bind(t), knocked.token);
  const first = (await page.evaluate(() => window.usher.state())).match!.digest;
  const sent = posts(page);

  for (const [step, next] of [['home', 'usage'], ['usage', 'tariff']] as const) {
    await fillStep(page, step);
    await Promise.all([page.waitForURL(new RegExp(`/switch/${next}$`)), page.getByRole('button', { name: 'Continue' }).click()]);
  }
  // The tariff step: its own map, notice and state, found without the agent binding again.
  await page.waitForFunction(() => document.querySelector('form')?.dataset.usherState === 'unlocked');
  const state = await page.evaluate(() => window.usher.state());
  assert.notEqual(state.match!.digest, first);
  assert.equal(state.match!.kind, 'exact');
  assert.equal(state.state, 'unlocked');
  assert.equal(await page.locator('form').getAttribute('data-usher-state'), 'unlocked');
  assert.equal(await page.locator('form [data-usher-note]').count(), 1);

  await fillStep(page, 'tariff');
  await page.getByRole('button', { name: 'See my prices' }).click();
  await page.waitForTimeout(300);
  assert.deepEqual(sent, ['/switch/home', '/switch/usage'], 'the final submit is held by the tariff step\'s rules');
  assert.equal((await page.evaluate(() => window.usher.state())).state, 'awaiting_confirmation');
  await context.close();
});

test('a submit while the script is still following the app to a new step waits for that step\'s map', { skip: !built && 'run npm run build first' }, async () => {
  const { context, page } = await openAt('tariff');
  const knocked = await knock(page);
  await page.evaluate((t) => window.usher.bind(t), knocked.token);
  await fillStep(page, 'tariff');
  const sent = posts(page);
  // The address changes and the form is submitted at once: held until the new path's map is known,
  // then sent again and judged by it (and held again, as form.submit needs the user's yes).
  await page.evaluate(() => {
    history.pushState(null, '', '/switch/tariff/');
    document.querySelector('form')!.requestSubmit();
  });
  await page.waitForFunction(() => window.usher.state().state === 'awaiting_confirmation');
  assert.deepEqual(sent, []);
  await context.close();
});
