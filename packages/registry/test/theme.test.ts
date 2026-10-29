// Site themes (LU-58): derived from the site's own pages (by code, and by a model choosing among
// candidates by index), only logos from the site's own origin, nothing in use until the owner
// accepts, the owner's page with its live preview, and every theme checked on the way in and out.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { CARD_SURFACE, type ChatFn, type ChatRequest } from '@usher/core';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { seed, startRegistry, type RunningRegistry } from '../src/index.ts';
import { ThemeDeriver } from '../src/theme-derive.ts';
import { CARD_DARK, CARD_LIGHT } from '../src/web/cards.ts';
import { registerSite, type SiteKeys } from './sites.ts';
import { testStorage } from './storage-helper.ts';

const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
let dir: string;
let running: RunningRegistry;
let site: MockSite;
let keys: SiteKeys;
let browser: Browser;
const requests: ChatRequest[] = [];
let answer: (r: ChatRequest) => object = () => ({});
const chat: ChatFn = async (request) => {
  requests.push(request);
  return { content: JSON.stringify(answer(request)), usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940, cached_tokens: 0 }, latency_ms: 1, response: {} };
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-theme-'));
  browser = await chromium.launch();
  running = await startRegistry({
    storage: await testStorage(dir),
    siteScript,
    web: { allowPrivate: true },
    themes: (registry) => new ThemeDeriver({ registry, browser: async () => browser, compiler: { chat, model: 'muse-spark-1.3' }, spend: { today: async () => 0, cap: 5 }, dailyLimit: 50, allowPrivate: true }),
  });
  site = await startMockSite({ registry: running.url, register: async (o) => (keys = await registerSite(running, o)).site_key });
  await seed(running.registry, 'mock-site', site.url);
});
after(async () => {
  await site.stop();
  await running.close();
  await browser.close();
  await rm(dir, { recursive: true });
});

const deriver = (withModel: boolean) => new ThemeDeriver({ registry: running.registry, browser: async () => browser, ...(withModel && { compiler: { chat, model: 'muse-spark-1.3' } }), dailyLimit: 50, allowPrivate: true });

test('the card surfaces contrast is checked against are the cards\' own', () => {
  assert.match(CARD_LIGHT, new RegExp(`--card:${CARD_SURFACE.light};`));
  assert.match(CARD_DARK, new RegExp(`--card:${CARD_SURFACE.dark};`));
});

test('derived by code from Brightwater\'s pages: its name, colours and logo, proposed, not in use', async () => {
  const record = await deriver(false).derive(site.url);
  assert.ok(typeof record !== 'string', String(record));
  assert.deepEqual(record.derived!.candidates.pages, ['/', '/health/about']);
  assert.equal(record.derived!.by, 'code');
  assert.ok(record.derived!.shot?.startsWith('data:image/jpeg;base64,'), 'a masked screenshot');
  const theme = record.proposed!;
  assert.equal(theme.name, 'Brightwater Insurance');
  assert.equal(theme.accent, '#0b6e6e', 'its buttons');
  assert.equal(theme.second, '#0b6e6e', 'its header');
  assert.ok(theme.logo?.startsWith('data:image/png;base64,'), 'its logo, captured from the page');
  assert.equal(record.approved, undefined, 'nothing in use until the owner accepts');
  assert.equal(await running.registry.cardTheme(site.url), undefined);
  // Never a value: the page script reads computed styles and structure only.
  assert.doesNotMatch(JSON.stringify(record.derived!.candidates), /value/i);
});

test('derived by Muse Spark choosing among the candidates by index; a choice out of range falls back to code', async () => {
  requests.length = 0;
  answer = (r) => {
    const text = (r.messages[1]!.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
    const listed = JSON.parse(text.slice(text.indexOf('\n') + 1, text.indexOf('\n', text.indexOf('\n') + 1))) as { names: { i: number; name: string }[]; colours: { i: number; hex: string; where: string }[] };
    return {
      name: listed.names.find((n) => n.name === 'Brightwater Insurance')!.i,
      logo: 0,
      accent: listed.colours.find((c) => c.hex === '#0b6e6e')!.i,
      second: listed.colours.find((c) => c.where.endsWith('body text'))!.i,
      typeface: 'humanist',
      why: 'Teal buttons and header; the round wave mark.',
    };
  };
  const record = await deriver(true).derive(site.url);
  assert.ok(typeof record !== 'string', String(record));
  const request = requests[0]!;
  assert.equal(request.response_format.json_schema.strict, true);
  assert.deepEqual(Object.keys((request.response_format.json_schema.schema as { properties: object }).properties).sort(), ['accent', 'logo', 'name', 'second', 'typeface', 'why']);
  const parts = request.messages[1]!.content as { type: string }[];
  assert.ok(parts.filter((p) => p.type === 'image_url').length >= 2, 'the logos and the masked screenshot');
  assert.equal(record.derived!.by, 'muse-spark-1.3');
  assert.equal(record.proposed!.typeface, 'humanist');
  assert.equal(record.proposed!.second, '#1d2433');
  assert.equal(record.derived!.why, 'Teal buttons and header; the round wave mark.');

  answer = () => ({ name: 99, logo: 42, accent: -1, second: 1.5, typeface: 'comic', why: 'x' });
  const fallback = await deriver(true).derive(site.url);
  assert.ok(typeof fallback !== 'string');
  assert.equal(fallback.proposed!.name, 'Brightwater Insurance');
  assert.equal(fallback.proposed!.accent, '#0b6e6e');
  assert.equal(fallback.proposed!.typeface, 'system');
});

test('only logos from the site\'s own origin', async () => {
  const other: Server = createServer((_, res) => res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#c00"/></svg>'));
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  const elsewhere = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
  const own: Server = createServer((req, res) => {
    if (req.url === '/mark.svg') return res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="20" fill="#05a"/></svg>');
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><title>Acme Ltd</title><header style="background:#05a;color:#fff;padding:10px"><img class="logo" alt="Theirs" src="${elsewhere}/x.svg" width="40" height="40"><a href="/"><img alt="Acme" src="/mark.svg" width="40" height="40"></a></header><main><button style="background:#05a;color:#fff">Start</button></main>`);
  });
  await new Promise<void>((r) => own.listen(0, 'localhost', r));
  const origin = `http://localhost:${(own.address() as { port: number }).port}`;
  try {
    const record = await deriver(false).derive(origin);
    assert.ok(typeof record !== 'string', String(record));
    assert.equal(record.derived!.candidates.logos.length, 1, 'the other origin\'s image is not a candidate');
    assert.equal(record.proposed!.name, 'Acme Ltd');
  } finally {
    own.close();
    other.close();
  }
});

test('the owner\'s page: the proposal, a live preview of the real card, adjust and accept; hostile input refused', async () => {
  const login = await fetch(`${running.url}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: keys.origin, secret: keys.secret_key }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const get = (path: string) => fetch(`${running.url}${path}`, { headers: { Cookie: cookie } });
  const post = (path: string, form: Record<string, string | string[]>) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const x of [v].flat()) body.append(k, x);
    return fetch(`${running.url}${path}`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie }, body });
  };
  assert.match(await (await get('/dashboard')).text(), /Your assistant app's look/);
  const pageRes = await get('/dashboard/theme');
  assert.equal(pageRes.status, 200);
  assert.match(pageRes.headers.get('content-security-policy') ?? '', /frame-src 'self'/);
  const body = await pageRes.text();
  assert.match(body, /proposed<\/b> this from your site/);
  assert.equal((body.match(/<iframe sandbox="allow-scripts" data-src="\/card-preview.html"/g) ?? []).length, 3);
  assert.doesNotMatch(body.slice(body.indexOf('id="samples"')), /<\/script><script(?! type="application\/json")/);
  const card = await fetch(`${running.url}/card-preview.html`);
  assert.match(card.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/);
  assert.match(await card.text(), /via Usher/);

  const form = { name: 'Brightwater', logo: 'current', accent: '#ffff00', second: '#0b6e6e', typeface: 'serif', radius: '8', result_fields: ['thumbnail'] };
  const preview = (await (await post('/dashboard/theme/preview', form)).json()) as { theme: { light: { accent: string } }; notes: string[] };
  assert.notEqual(preview.theme.light.accent, '#ffff00', 'yellow moves for contrast on light cards');
  assert.match(preview.notes.join(' '), /On light cards the accent is #/);
  const bad = await post('/dashboard/theme/preview', { ...form, accent: 'red;}body{display:none}', typeface: 'url(x)' });
  assert.equal(bad.status, 422);
  assert.equal((await post('/dashboard/theme', { ...form, radius: '999' })).status, 422);
  assert.equal(await running.registry.cardTheme(site.url), undefined, 'refused, so nothing in use');

  assert.equal((await post('/dashboard/theme', form)).status, 303);
  const inUse = await running.registry.cardTheme(site.url);
  assert.equal(inUse?.name, 'Brightwater');
  assert.equal(inUse?.typeface, 'serif');
  assert.deepEqual(inUse?.result_fields, ['thumbnail']);
  assert.ok(inUse?.logo, 'the logo kept');
  assert.match(await (await get('/dashboard/theme')).text(), /in use<\/b> on your cards/);
});

test('a site that joins gets a proposal from its pages; one that has a theme keeps it', async () => {
  await running.registry.putSiteTheme(site.url, {});
  running.registry.onJoined!(site.url);
  for (let i = 0; i < 200 && !(await running.registry.siteTheme(site.url)).proposed; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await running.registry.siteTheme(site.url)).proposed?.accent, '#0b6e6e');
  const before = (await running.registry.siteTheme(site.url)).derived!.at;
  running.registry.onJoined!(site.url);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await running.registry.siteTheme(site.url)).derived!.at, before);
});
