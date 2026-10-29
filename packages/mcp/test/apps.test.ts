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
  if (m.method === 'ui/initialize') f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'harness', version: '0' }, hostCapabilities: window.caps || {}, hostContext: { theme: 'light' } } }, '*');
  else if (m.method === 'tools/call') window.callTool(m.params).then(function (r) { f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: r }, '*'); });
  else if (m.method === 'ui/notifications/initialized') window.ready = true;
  else if (m.method === 'ui/notifications/size-changed') f.style.height = m.params.height + 'px';
  else if (m.id != null && m.method) f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: {} }, '*');
});
window.show = function (r) { f.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: r }, '*'); };
</script></body></html>`;

/** The card in a harness host, showing one tool result. `caps`: what the host declares; `client` passes the card's tool calls to the server. */
async function render(html: string, result: unknown, host: { caps?: object; client?: Client } = {}): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 560, height: 900 } })).newPage();
  if (host.client) await page.exposeFunction('callTool', (params: { name: string; arguments: Record<string, unknown> }) => host.client!.callTool(params));
  await page.setContent(HOST);
  await page.evaluate((caps) => ((window as unknown as { caps: object }).caps = caps), host.caps ?? {});
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

type Msg = { method?: string; params?: { name?: string; arguments?: { answers?: Record<string, unknown>; confirmation?: string }; content?: { text: string }[] } };
const sent = async (page: Page) => (await page.evaluate('window.msgs')) as Msg[];

test('a host that can\'t take a card\'s tool calls: Confirm sends the person\'s own short confirmation, and the agent submits from it', async () => {
  const client = await connect();
  const html = ((await client.readResource({ uri: CARD_URI })).contents[0] as { text: string }).text;
  const filled = await client.callTool({ name: 'usher_fill', arguments: { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values } });
  assert.equal((filled.structuredContent as { status: string }).status, 'needs_decision');
  // The text result lists every decision with its exact wording, for clients with no cards.
  const lead = (filled.content as { type: string; text: string }[])[0]!.text;
  assert.match(lead, /Usher is asking the person, not the agent/);
  assert.match(lead, /1\. Required: “I confirm the information I have given is true and complete”/);
  assert.match(lead, /2\. Optional: “Send me offers by email \(optional\)”/);
  assert.match(lead, /3\. Action: press “Get my quote”\n   The site says \(.*\/quote\/cover\): “By selecting Get my quote you agree/);
  assert.match(lead, /Confirm: declaration yes\/no, marketing yes\/no, get my quote yes\/no/);

  const decision = await render(html, filled, { caps: { message: { text: {} } } });
  const card = decision.frameLocator('#v');
  assert.equal(await card.locator('text=Usher is asking you, not the agent').count(), 1);
  assert.equal(await card.locator('text=I confirm the information I have given is true and complete').count(), 1, 'the site\'s wording, verbatim');
  assert.match((await card.locator('.where').textContent()) ?? '', /\/quote\/cover$/);
  assert.equal(await card.locator('input[type=checkbox]').count(), 2, 'the declaration and the submit');
  assert.equal(await card.locator('input[type=radio]').count(), 2, 'marketing as yes/no');
  await shot(decision, 'decision-card.png');
  await card.locator('input[data-key="consent.declaration"]').check();
  await card.locator('input[data-key="form.submit"]').check();
  await card.locator('button#go').click();
  await card.locator('text=Sent as your message: Confirm: declaration yes, marketing no, get my quote yes').waitFor();
  const msgs = await sent(decision);
  assert.ok(!msgs.some((m) => m.method === 'tools/call'), 'no tool call from the card');
  const message = msgs.find((m) => m.method === 'ui/message')!;
  assert.deepEqual(message.params!.content, [{ type: 'text', text: 'Confirm: declaration yes, marketing no, get my quote yes' }], 'the person\'s words, nothing else');

  // The agent passes the person's reply on, word for word.
  const done = await client.callTool({ name: 'usher_confirm', arguments: { id: (filled.structuredContent as { id: string }).id, confirmation: message.params!.content![0]!.text } });
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

test('a host that passes a card\'s tool calls on (serverTools): Confirm calls usher_confirm and shows the result', async () => {
  const client = await connect();
  const html = ((await client.readResource({ uri: CARD_URI })).contents[0] as { text: string }).text;
  const filled = await client.callTool({ name: 'usher_fill', arguments: { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values } });
  const page = await render(html, filled, { caps: { serverTools: {}, message: { text: {} } }, client });
  const card = page.frameLocator('#v');
  await card.locator('input[data-key="consent.declaration"]').check();
  await card.locator('input[data-key="form.submit"]').check();
  await card.locator('button#go').click();
  await card.locator('h1:text("Your quote")').waitFor();
  const msgs = await sent(page);
  const call = msgs.find((m) => m.method === 'tools/call')!;
  assert.equal(call.params!.name, 'usher_confirm');
  assert.deepEqual(call.params!.arguments!.answers, { 'consent.declaration': true, 'consent.marketing': false, 'form.submit': true });
  assert.equal(call.params!.arguments!.confirmation, 'Confirm: declaration yes, marketing no, get my quote yes');
  assert.ok(msgs.some((m) => m.method === 'ui/update-model-context'), 'the agent is told what happened');
  // The chat carries on with one message after the result, which isn't a confirmation of its own.
  const follow = msgs.filter((m) => m.method === 'ui/message');
  assert.equal(follow.length, 1);
  assert.ok(msgs.indexOf(follow[0]!) > msgs.indexOf(call), 'after usher_confirm, not instead of it');
  const said = (follow[0]!.params as { content: { text: string }[] }).content[0]!.text;
  assert.equal(said, 'I confirmed in the Usher card: declaration yes, marketing no, get my quote yes. What happened?');
  assert.doesNotMatch(said, /^Confirm:/, 'the agent won\'t call usher_confirm again from it');
});

test('usher_confirm says what it does: it submits on the person\'s behalf', async () => {
  const tools = (await (await connect()).listTools()).tools;
  assert.deepEqual(tools.find((t) => t.name === 'usher_confirm')!.annotations, { title: 'Submit with the person\'s answers', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.equal(tools.find((t) => t.name === 'usher_fill')!.annotations?.readOnlyHint, false);
});

test('Brightwater Health\'s card: the smoker answer as the person said it, nothing chosen for them; the declaration word for word', async () => {
  const health = JSON.parse(await readFile(new URL('../../agent/profiles/test-health.json', import.meta.url), 'utf8')) as Record<string, string | boolean>;
  const { _comment: _h, 'consent.declaration': _hd, ...keyed } = health;
  const client = await connect();
  const html = ((await client.readResource({ uri: CARD_URI })).contents[0] as { text: string }).text;
  const filled = await client.callTool({ name: 'usher_fill', arguments: { url: `${site.url}/health/about`, intent: 'quote.health_insurance', values: keyed } });
  assert.equal((filled.structuredContent as { status: string }).status, 'needs_decision');
  const decision = await render(html, filled, { caps: { message: { text: {} } } });
  const card = decision.frameLocator('#v');
  assert.equal(await card.locator('text=Have you smoked or used nicotine products in the last 12 months?').count(), 1);
  assert.match((await card.locator('.said').textContent()) ?? '', /You said: No/);
  assert.equal(await card.locator('input[data-key="person.smoker"]:checked').count(), 0, 'nothing chosen for them');
  assert.equal(await card.locator('text=I confirm the information I have given is true and complete, and I understand that my medical history will be asked about after the quote').count(), 1);
  await shot(decision, 'decision-card-health.png');
  // Unanswered, Confirm asks again; answered, it sends the person's own words.
  await card.locator('input[data-key="consent.declaration"]').check();
  await card.locator('input[data-key="form.submit"]').check();
  await card.locator('button#go').click();
  await card.locator('text=Please answer every question first.').waitFor();
  await card.locator('input[data-key="person.smoker"][value="yes"]').check();
  await card.locator('button#go').click();
  // The answer is the person's own, so the confirmation repeats it: "yes" means "No is right".
  await card.locator('text=Sent as your message: Confirm: smoker "No" yes, declaration yes, get my quote yes').waitFor();
  const done = await client.callTool({ name: 'usher_confirm', arguments: { id: (filled.structuredContent as { id: string }).id, confirmation: 'Confirm: smoker "No" yes, declaration yes, get my quote yes' } });
  assert.equal((done.structuredContent as { status: string }).status, 'completed');
  const result = await render(html, done);
  assert.match((await result.frameLocator('#v').locator('.facts').textContent()) ?? '', /£[\d,]+\.\d\d a month[\s\S]*Quote reference BWH-/);
  await shot(result, 'result-card-health.png');
});

test('a result read with its result view: each fact by the site\'s label, the price large, documents as links that open', async () => {
  const client = await connect();
  const html = ((await client.readResource({ uri: CARD_URI })).contents[0] as { text: string }).text;
  const result = {
    structuredContent: {
      status: 'completed',
      id: 'f_1',
      final_url: 'https://life.example/your-quick-quote',
      result: {
        title: 'Quick quote results',
        final_url: 'https://life.example/your-quick-quote',
        facts: ['You pay each month: £15.67', 'Life insurance cover: £250,000'],
        items: [
          { key: 'result.price', label: 'You pay each month', kind: 'fact', text: '£15.67' },
          { key: 'result.amount', label: 'Life insurance cover', kind: 'fact', text: '£250,000' },
          { key: 'result.reference', label: 'Quote reference', kind: 'fact', text: 'Quote reference: Q-99881' },
          { key: 'result.document', label: 'Policy summary (PDF)', kind: 'link', href: 'https://life.example/docs/summary.pdf' },
          { key: 'result.document', label: 'Bad link', kind: 'link', href: 'javascript:alert(1)' },
        ],
      },
    },
    content: [{ type: 'text', text: '{}' }],
  };
  const page = await render(html, result, { caps: { openLinks: {} } });
  const card = page.frameLocator('#v');
  const rows = await card.locator('.view .row').evaluateAll((els) => els.map((e) => [e.querySelector('span')!.textContent, e.querySelector('b')!.textContent, e.classList.contains('big')]));
  assert.deepEqual(rows, [['You pay each month', '£15.67', true], ['Life insurance cover', '£250,000', true], ['Quote reference', 'Q-99881', false]]);
  assert.deepEqual(await card.locator('.docs a').allTextContents(), ['Policy summary (PDF)'], 'only http(s) links');
  assert.equal(await card.locator('img.thumb').count(), 0, 'no screenshot when the view has the facts');
  await card.locator('.docs a').click();
  await page.waitForTimeout(200);
  const opened = (await sent(page)).filter((m) => m.method === 'ui/open-link').map((m) => (m.params as { url: string }).url);
  assert.deepEqual(opened, ['https://life.example/docs/summary.pdf']);
  await page.close();
});
