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
import { drawsCards, hostedMcp } from '../src/hosted.ts';

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

async function connect(name = 'test-client', capabilities: Record<string, unknown> = {}): Promise<Client> {
  const client = new Client({ name, version: '0' }, { capabilities });
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
  // The car quote, picked up on the site and taken on to its next step: a demo wall, nothing bought.
  const car = (done.structuredContent as { result: { reference: string; continue: { url: string } } }).result;
  assert.match(car.reference, /^BW-[0-9A-F]{8}$/);
  const own = await (await browser.newContext()).newPage();
  await own.goto(car.continue.url);
  assert.equal(await own.inputValue('#reference'), car.reference);
  await own.fill('#dob', String(profile['person.dob']));
  await own.click('button[type=submit]');
  await own.waitForURL(/\/quote\/result$/);
  await own.click('text=Continue to buy');
  await own.waitForURL(/\/quote\/proceed$/);
  assert.match(await own.locator('.demo-wall').innerText(), /nothing can be bought here/);

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

test('a plan card left open while the person answers in the chat closes itself once the run is prepared there', async () => {
  const healthValues = { 'person.title': 'Mr', 'person.first_name': 'Sam', 'person.last_name': 'Lee', 'person.dob': '14/03/1988', 'address.postcode': 'WR14 1AA', 'contact.email': 'sam@example.org', 'cover.who': 'Just me', 'cover.level': 'Standard', 'cover.excess': '£250', 'cover.hospital_list': 'Standard list', 'cover.outpatient_limit': 'Unlimited', 'policy.start_date': '01/11/2026', 'policy.payment_frequency': 'Monthly' };
  for (const byId of [true, false]) {
    const chat = await connect();
    const html = ((await chat.readResource({ uri: CARD_URI })).contents[0] as { text: string }).text;
    const planned = await chat.callTool({ name: 'get_plan', arguments: { url: `${site.url}/health/about` } });
    const planId = (planned.structuredContent as { plan_id: string }).plan_id;
    assert.match(planId, /^p_/);
    // The card's own calls come in on another connection, as they may in a host.
    const page = await render(html, planned, { caps: { serverTools: {}, message: { text: {} } }, client: await connect() });
    const card = page.frameLocator('#v');
    await card.locator('h1:text("Before your assistant starts")').waitFor();
    // The person answers in the chat; the assistant prepares the run, with the plan_id or, on the
    // same connection as get_plan, without it.
    await chat.callTool({ name: 'prepare_run', arguments: { url: `${site.url}/health/about`, values: healthValues, ...(byId && { plan_id: planId }) } });
    await card.locator('h1:text("Answered in the chat")').waitFor({ timeout: 10_000 });
    assert.equal(await card.locator('button#go').count(), 0, 'no questions left to answer');
    await page.context().close();
  }
  // plan_status is for the card: hidden from the model, and a made-up id is unknown.
  const tools = (await (await connect()).listTools()).tools;
  assert.deepEqual((tools.find((t) => t.name === 'plan_status')!._meta as { ui: { visibility: string[] } }).ui.visibility, ['app']);
  const unknown = await (await connect()).callTool({ name: 'plan_status', arguments: { plan_id: 'p_nothing' } });
  assert.equal((unknown.structuredContent as { status: string }).status, 'unknown');
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
  await card.locator('text=Sent as your message: Confirm: smoker yes, declaration yes, get my quote yes').waitFor();
  const done = await client.callTool({ name: 'usher_confirm', arguments: { id: (filled.structuredContent as { id: string }).id, confirmation: 'Confirm: smoker yes, declaration yes, get my quote yes' } });
  assert.equal((done.structuredContent as { status: string }).status, 'completed');
  const result = await render(html, done);
  assert.match((await result.frameLocator('#v').locator('.facts').textContent()) ?? '', /£[\d,]+\.\d\d a month[\s\S]*Quote reference BWH-/);
  await shot(result, 'result-card-health.png');

  // Finishable: Brightwater's owner chose a one-time link, which opens the quote in the person's own browser.
  const finished = (done.structuredContent as { result: { reference: string; continue: { url: string; label: string; asks: string[] } } }).result;
  assert.match(finished.reference, /^BWH-[0-9A-F]{8}$/);
  assert.match(finished.continue.url, new RegExp(`^${site.url}/handoff\\?token=`));
  assert.deepEqual(finished.continue.asks, []);
  assert.match((done.content as { text?: string }[])[0]!.text ?? '', new RegExp(`Reference: ${finished.reference}\\.\\nTo continue on .*, your user opens ${finished.continue.url.replace(/[.?]/g, '\\$&')}\\.`));
  assert.equal(await result.frameLocator('#v').locator('a.button', { hasText: /^Continue on / }).count(), 1);
  const own = await (await browser.newContext()).newPage();
  await own.goto(finished.continue.url);
  await own.waitForURL(/\/health\/result$/);
  assert.match(await own.locator('.ref').innerText(), new RegExp(finished.reference));
});

test('a client that draws cards isn\'t told to repeat them; anyone else still gets the site\'s words as text', async () => {
  assert.equal(drawsCards({ extensions: { 'io.modelcontextprotocol/ui': {} } }, 'anything'), true, 'it declares them');
  assert.equal(drawsCards({}, 'openai-mcp'), true, 'known to draw them');
  assert.equal(drawsCards({}, 'claude-code'), false, 'unsure: the words go in the text');
  assert.equal(drawsCards(undefined, undefined), false);
  const args = { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values };
  const text = async (client: Client) => {
    const result = await client.callTool({ name: 'usher_fill', arguments: args });
    return { lead: (result.content as { text: string }[])[0]!.text, data: result.structuredContent as { decisions: { label: string }[]; instructions: string } };
  };
  const card = await text(await connect('some-host', { extensions: { 'io.modelcontextprotocol/ui': {} } }));
  assert.match(card.lead, /Don't list or repeat them/);
  assert.match(card.lead, /Nothing is sent until you do/);
  assert.doesNotMatch(card.lead, /Required: “/);
  assert.match(card.lead, /show each question word for word first/, 'the wording if they ask to answer in the chat');
  assert.ok(card.data.decisions.length, 'the card still gets every decision');
  const plain = await text(await connect('plain-client'));
  assert.match(plain.lead, /1\. Required: “I confirm the information/);
  assert.doesNotMatch(plain.lead, /Don't list or repeat/);
});

test('a long form\'s card: its pages fold, it says how far you are, and a folded page can\'t hide a missed question', async () => {
  const client = await connect();
  const html = ((await client.readResource({ uri: CARD_URI })).contents[0] as { text: string }).text;
  const filled = await client.callTool({ name: 'usher_fill', arguments: { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values: {} } });
  const asked = (filled.structuredContent as { status: string; decisions: { kind: string; section?: string; key: string }[] });
  assert.equal(asked.status, 'needs_decision');
  const details = asked.decisions.filter((d) => d.kind === 'missing_value');
  assert.ok(details.length >= 6, String(details.length));
  assert.ok(details.every((d) => d.section), 'each by its page');
  const page = await render(html, filled, { caps: { message: { text: {} } } });
  const card = page.frameLocator('#v');
  assert.equal(await card.locator('h1').textContent(), 'A few details first');
  assert.equal(await card.locator('#progress').textContent(), `0 of ${details.length} filled in`);
  const sections = card.locator('details.section');
  const many = await sections.count();
  assert.equal(new Set(details.map((d) => d.section)).size, many);
  assert.equal(await card.locator('details.section[open]').count(), 1, 'one open to start');
  await shot(page, 'long-form-card.png');
  assert.equal(await card.locator('.yours-head').textContent(), 'Your decisions');
  assert.ok((await card.locator('.yours [data-kind="consent"]').count()) > 0, 'the decisions stand apart');
  // Typing moves the count on; what's typed isn't shown anywhere else.
  await card.locator('details.section[open] input[type=text]').first().fill('Sam');
  assert.equal(await card.locator('#progress').textContent(), `1 of ${details.length} filled in`);
  assert.doesNotMatch((await card.locator('details.section[open] .count').textContent()) ?? '', /Sam/);
  // Confirm with blanks: every folded page with a blank opens, and nothing is sent.
  await card.locator('button#go').click();
  assert.equal(await card.locator('#msg').textContent(), 'Please answer every question first.');
  assert.equal(await card.locator('details.section[open]').count(), many);
  assert.equal(await page.evaluate(() => (window as unknown as { msgs: { method?: string }[] }).msgs.filter((m) => m.method === 'ui/message').length), 0);
  await page.close();
});
