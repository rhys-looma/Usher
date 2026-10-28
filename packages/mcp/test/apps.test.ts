// MCP Apps: the card resource and the tools that render with it, and the card itself in a small
// host harness (a page that answers ui/initialize and passes tool results, as Claude and ChatGPT
// do). The decision card's Confirm hands the answers back as a message for the model, and those
// answers complete the fill through usher_confirm; the result card shows the figures verbatim; the
// ticket shows structure only. Text results are unchanged, so nothing depends on the card.
// USHER_CARD_SHOTS=<dir> also saves screenshots of each card (docs/mcp-apps.md).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium, type Browser, type Page } from 'playwright';
import { seed, startRegistry, type RunningRegistry } from '@usher/registry';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { registerSite } from '../../registry/test/sites.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';
import { CARD_URI, claudeDomain } from '../src/apps.ts';
import { hostedMcp } from '../src/hosted.ts';

const profile = JSON.parse(await readFile(new URL('../../agent/profiles/test-driver.json', import.meta.url), 'utf8')) as Record<string, string | boolean>;
const { _comment: _, 'consent.declaration': _d, 'consent.marketing': _m, ...values } = profile;
const shots = process.env.USHER_CARD_SHOTS;

let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let browser: Browser;
const open: Client[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-apps-'));
  browser = await chromium.launch();
  registry = await startRegistry({ storage: await testStorage(dir), siteScript: fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url)), mcp: (r) => hostedMcp({ registry: r, version: 'test', browser: async () => browser, allowPrivate: true }) });
  site = await startMockSite({ registry: registry.url, register: async (o) => (await registerSite(registry, o)).site_key });
  await seed(registry.registry, 'mock-site', site.url);
  if (shots) await mkdir(shots, { recursive: true });
});
after(async () => {
  for (const c of open) await c.close().catch(() => undefined);
  await registry.close();
  await site.stop();
  await browser.close();
  await rm(dir, { recursive: true });
});

async function connect(name = 'test-client'): Promise<Client> {
  const client = new Client({ name, version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${registry.url}/mcp`)));
  open.push(client);
  return client;
}

const HOST = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#eee;font-family:sans-serif}iframe{width:520px;border:0;display:block;margin:12px;background:transparent}</style></head><body>
<iframe id="v" sandbox="allow-scripts"></iframe>
<script>
var f = document.getElementById('v');
window.msgs = []; window.ready = false;
window.addEventListener('message', function (e) {
  var m = e.data;
  if (!m || m.jsonrpc !== '2.0') return;
  window.msgs.push(m);
  if (m.method === 'ui/initialize') f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'harness', version: '0' }, hostCapabilities: {}, hostContext: { theme: 'light' } } }, '*');
  else if (m.method === 'ui/notifications/initialized') window.ready = true;
  else if (m.method === 'ui/notifications/size-changed') f.style.height = m.params.height + 'px';
  else if (m.id != null && m.method) f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: {} }, '*');
});
window.show = function (r) { f.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: r }, '*'); };
</script></body></html>`;

/** The card in a harness host, showing one tool result. */
async function render(html: string, result: unknown): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 560, height: 900 } })).newPage();
  await page.setContent(HOST);
  await page.evaluate((h) => ((document.getElementById('v') as HTMLIFrameElement).srcdoc = h), html);
  await page.waitForFunction('window.ready === true');
  await page.evaluate((r) => (window as unknown as { show: (r: unknown) => void }).show(r), result);
  await page.frameLocator('#v').locator('.card').waitFor();
  await page.waitForTimeout(150);
  return page;
}
const shot = async (page: Page, name: string) => shots && page.locator('#v').screenshot({ path: join(shots, name) });

test('the card is a ui:// resource of the MCP Apps type, self-contained; knock, usher_fill and usher_confirm render with it', async () => {
  const client = await connect();
  const { resources } = await client.listResources();
  assert.ok(resources.some((r) => r.uri === CARD_URI && r.mimeType === 'text/html;profile=mcp-app'));
  const { contents } = await client.readResource({ uri: CARD_URI });
  const html = (contents[0] as { text: string }).text;
  assert.doesNotMatch(html, /(src|href)=["']https?:|@import|url\(\s*["']?(https?:|\/\/)|<link\b|fetch\(|XMLHttpRequest|WebSocket|sendBeacon/, 'no external resources, no network');
  assert.deepEqual((contents[0] as { _meta?: { ui?: { csp?: object; domain?: string } } })._meta?.ui?.csp, {});
  assert.equal((contents[0] as { _meta?: { ui?: { domain?: string } } })._meta?.ui?.domain, undefined, 'no dedicated origin for a client that isn\'t Claude');
  const { tools } = await client.listTools();
  for (const name of ['knock', 'usher_fill', 'usher_confirm']) {
    const meta = tools.find((t) => t.name === name)!._meta as { ui?: { resourceUri?: string }; 'openai/outputTemplate'?: string };
    assert.equal(meta?.ui?.resourceUri, CARD_URI, name);
    assert.equal(meta?.['openai/outputTemplate'], CARD_URI, name);
  }
  assert.equal(tools.find((t) => t.name === 'usher_cancel')!._meta, undefined);
});

test('Claude gets the dedicated origin for this server: sha256 of its URL, 32 hex characters', async () => {
  const { contents } = await (await connect('claude-ai')).readResource({ uri: CARD_URI });
  const domain = (contents[0] as { _meta?: { ui?: { domain?: string } } })._meta?.ui?.domain;
  assert.equal(domain, claudeDomain(`${registry.url}/mcp`));
  assert.match(domain!, /^[0-9a-f]{32}\.claudemcpcontent\.com$/);
});

test('decision card → answers back to the model → usher_confirm → result card; ticket from a knock', async () => {
  const client = await connect();
  const html = ((await client.readResource({ uri: CARD_URI })).contents[0] as { text: string }).text;
  const filled = await client.callTool({ name: 'usher_fill', arguments: { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values } });
  assert.equal((filled.structuredContent as { status: string }).status, 'needs_decision');

  const decision = await render(html, filled);
  const card = decision.frameLocator('#v');
  assert.equal(await card.locator('text=Usher is asking you, not the agent').count(), 1);
  assert.equal(await card.locator('text=I confirm the information I have given is true and complete').count(), 1, 'the site\'s wording, verbatim');
  assert.equal(await card.locator('text=Get my quote').count() >= 1, true);
  assert.match((await card.locator('.where').textContent()) ?? '', /\/quote\/cover$/);
  assert.equal(await card.locator('input[type=checkbox]').count(), 2, 'the declaration and the submit');
  assert.equal(await card.locator('input[type=radio]').count(), 2, 'marketing as yes/no');
  await shot(decision, 'decision-card.png');
  await card.locator('input[data-key="consent.declaration"]').check();
  await card.locator('input[data-key="form.submit"]').check();
  await card.locator('button#go').click();
  await card.locator('text=Sent to your assistant.').waitFor();
  const msgs = (await decision.evaluate('window.msgs')) as { method?: string; params?: { content?: { text?: string } | { text: string }[]; structuredContent?: { usher_confirm: { id: string; answers: Record<string, unknown> } } } }[];
  const message = msgs.find((m) => m.method === 'ui/message')!;
  const context = msgs.find((m) => m.method === 'ui/update-model-context')!;
  assert.ok(message && context, 'answers handed back to the model; no tools/call from the card');
  assert.ok(!msgs.some((m) => m.method === 'tools/call'));
  const { id, answers } = context.params!.structuredContent!.usher_confirm;
  assert.deepEqual(answers, { 'consent.declaration': true, 'consent.marketing': false, 'form.submit': true });
  assert.match((message.params!.content as { text: string }[])[0]!.text, /usher_confirm/);

  // The model passes them on, as the card asked.
  const done = await client.callTool({ name: 'usher_confirm', arguments: { id, answers } });
  assert.equal((done.structuredContent as { status: string }).status, 'completed');
  const result = await render(html, done);
  const rc = result.frameLocator('#v');
  assert.equal(await rc.locator('h1').textContent(), 'Your quote');
  assert.match((await rc.locator('.facts').textContent()) ?? '', /£[\d,]+\.\d\d a year[\s\S]*Quote reference BW-/);
  assert.equal(await rc.locator('img.thumb').count(), 1);
  assert.equal(await rc.locator('text=Taylor').count(), 0, 'no values the user didn\'t ask to see');
  await shot(result, 'result-card.png');

  const knock = await client.callTool({ name: 'knock', arguments: { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance' } });
  const ticket = await render(html, knock);
  const tc = ticket.frameLocator('#v');
  assert.equal(await tc.locator('text=Admit one agent').count(), 1);
  assert.match((await tc.locator('dl').textContent()) ?? '', /Agenthosted [\w-]{4}…[\w-]{3}, signed[\s\S]*\/quote\/driver: 13 fields by meaning[\s\S]*Validuntil/);
  assert.equal(await tc.locator(`text=${(knock.structuredContent as { token: string }).token.slice(0, 20)}`).count(), 0, 'never the token itself');
  await shot(ticket, 'ticket.png');
});
