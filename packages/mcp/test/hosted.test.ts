// Hosted MCP at /mcp, over the streamable HTTP transport: the same tools as the local server
// except submit_map; each connection its own key, minted on first use and never stored; sessions
// and tokens marked hosted; only sites that have joined; a site can block hosted agents as a class;
// limits per connection and per address.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium, type Browser } from 'playwright';
import { seed, startRegistry, type RunningRegistry } from '@usher/registry';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { registerSite, type SiteKeys } from '../../registry/test/sites.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';
import { hostedMcp, type HostedLimits } from '../src/hosted.ts';

const profile = JSON.parse(await readFile(new URL('../../agent/profiles/test-driver.json', import.meta.url), 'utf8')) as Record<string, string | boolean>;
const { _comment: _, 'consent.declaration': _d, 'consent.marketing': _m, ...values } = profile;

let dir: string;
let registry: RunningRegistry;
let tight: RunningRegistry;
let guarded: RunningRegistry;
let site: MockSite;
let keys: SiteKeys;
let unjoined: MockSite;
let browser: Browser;
const open: Client[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-hosted-'));
  browser = await chromium.launch();
  const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
  registry = await startRegistry({ storage: await testStorage(join(dir, 'a')), siteScript, web: { allowPrivate: true }, mcp: (r) => hostedMcp({ registry: r, version: 'test', browser: async () => browser, allowPrivate: true }) });
  // Joined: registered, with its origin proved (the development way, for a local origin).
  site = await startMockSite({ registry: registry.url, register: async (o) => (keys = await registerSite(registry, o)).site_key });
  await seed(registry.registry, 'mock-site', site.url);
  // Registered, but it hasn't proved its origin: it hasn't joined.
  unjoined = await startMockSite({ registry: registry.url, register: async (o) => (await registerSite(registry, o, { claim: false })).site_key });
  await seed(registry.registry, 'mock-site', unjoined.url);
  const limits: Partial<HostedLimits> = { requestsPerConnectionMinute: 4, connectionsPerAddressHour: 2 };
  // As in production: fills reach public addresses only, so a joined site on a private address can't be opened.
  guarded = await startRegistry({ storage: await testStorage(join(dir, 'c')), mcp: (r) => hostedMcp({ registry: r, version: 'test', browser: async () => browser }) });
  await registerSite(guarded, site.url);
  await seed(guarded.registry, 'mock-site', site.url);
  tight = await startRegistry({ storage: await testStorage(join(dir, 'b')), mcp: (r) => hostedMcp({ registry: r, version: 'test', browser: async () => browser, limits }) });
});
after(async () => {
  for (const c of open) await c.close().catch(() => undefined);
  await registry.close();
  await tight.close();
  await guarded.close();
  await site.stop();
  await unjoined.stop();
  await browser.close();
  await rm(dir, { recursive: true });
});

async function connect(r = registry): Promise<Client> {
  const client = new Client({ name: 'hosted-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${r.url}/mcp`)));
  open.push(client);
  return client;
}
type Reply = { status: string; id: string; session?: string; decisions?: { kind: string; key: string }[] };
const call = async (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
const text = (result: Awaited<ReturnType<typeof call>>) => (result.content as { text?: string }[])[0]?.text ?? '';
const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;

test('the same tools as the local server, less submit_map', async () => {
  const names = (await (await connect()).listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_map', 'get_plan', 'knock', 'report_run', 'usher_cancel', 'usher_confirm', 'usher_fill']);
});

test('usher_fill on a joined site: decisions for the user, then a session marked hosted, signed as hosted, key never stored', async () => {
  const client = await connect();
  let reply = (await call(client, 'usher_fill', { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values })).structuredContent as Reply;
  const decisions: string[] = [];
  while (reply.status === 'needs_decision') {
    decisions.push(reply.decisions!.map((d) => `${d.kind}:${d.key}`).join(' '));
    reply = (await call(client, 'usher_confirm', { id: reply.id, answers: Object.fromEntries(reply.decisions!.map((d) => [d.key, d.key !== 'consent.marketing'])) })).structuredContent as Reply;
  }
  assert.equal(reply.status, 'completed', JSON.stringify(reply));
  assert.deepEqual(decisions, ['required_consent:consent.declaration optional_consent:consent.marketing submit:form.submit'], 'one pause, three decisions');
  const session = (await registry.registry.storage.getSession(reply.session!))!;
  assert.deepEqual(session.identity, { method: 'hosted' });
  assert.match(session.agent, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await registry.registry.storage.agentKey(session.agent), undefined, 'the connection\'s key is not kept');
  assert.ok(session.events.some((e) => e.source === 'site' && e.action === 'confirm' && e.key === 'form.submit'));
  // The same connection knocks with the same key; its token says the registry acted for a hosted connection.
  const knock = (await call(client, 'knock', { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance' })).structuredContent as { token: string };
  assert.equal(claims(knock.token).sub, session.agent);
  assert.deepEqual(claims(knock.token).act, { sub: 'hosted' });
  // The site sees it as hosted:<thumbprint>.
  const login = await fetch(`${registry.url}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: site.url, secret: keys.secret_key }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const board = await (await fetch(`${registry.url}/dashboard/sessions/${reply.session}`, { headers: { Cookie: cookie } })).text();
  assert.ok(board.includes(`hosted:${session.agent}`));
});

test('each connection has its own key', async () => {
  const knock = async () => claims(((await call(await connect(), 'knock', { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance' })).structuredContent as { token: string }).token).sub;
  assert.notEqual(await knock(), await knock());
});

test('a site that hasn\'t joined: refused, pointing at the local server and why', async () => {
  const client = await connect();
  for (const result of [
    await call(client, 'knock', { url: `${unjoined.url}/quote/driver`, intent: 'quote.car_insurance' }),
    await call(client, 'usher_fill', { url: `${unjoined.url}/quote/driver`, intent: 'quote.car_insurance', values }),
  ]) {
    assert.equal(result.isError, true);
    assert.match(text(result), /Hosted Usher only acts where a site has said yes/);
    assert.match(text(result), /npx -y @usher-run\/mcp/);
  }
  assert.equal(await registry.registry.joined(site.url), true);
  assert.equal(await registry.registry.joined(unjoined.url), false);
});

test('a site can block hosted agents as a class; agents with their own key still get in', async () => {
  const storage = registry.registry.storage;
  const before = await storage.getPolicy(site.url);
  await storage.putPolicy({ policy: { usher_policy: '0.1', origin: site.url, default: {}, agents: { hosted: 'block' } }, confirmed_at: new Date().toISOString() });
  try {
    const result = await call(await connect(), 'knock', { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance' });
    assert.equal(result.isError, true);
    assert.match(text(result), /does not allow hosted agents/);
    const { RegistryClient } = await import('@usher/registry');
    const { generateAgentIdentity } = await import('@usher/core');
    await new RegistryClient(registry.url, (await generateAgentIdentity()).identity).knock({ url: `${site.url}/quote/driver`, intent: 'quote.car_insurance' });
  } finally {
    if (before) await storage.putPolicy(before);
    else await storage.putPolicy({ policy: { usher_policy: '0.1', origin: site.url, default: {} }, confirmed_at: new Date().toISOString() });
  }
});

test('a fill\'s browser reaches public addresses only, even on a joined site', async () => {
  const result = (await call(await connect(guarded), 'usher_fill', { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values })).structuredContent as Reply & { reason?: string };
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /ERR_BLOCKED_BY_CLIENT/);
});

test('limits per connection and per address', async () => {
  const client = await connect(tight);
  const results: string[] = [];
  for (let i = 0; i < 4; i++) results.push(await client.listTools().then(() => 'ok', (e: Error) => e.message));
  assert.ok(results.some((r) => /Too many requests on this connection/.test(r)), results.join(' | '));
  await connect(tight);
  await assert.rejects(connect(tight), /Too many new connections from this address/);
});

test('opening /mcp in a browser explains what it is', async () => {
  const res = await fetch(`${registry.url}/mcp`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /remote MCP server[\s\S]*npx -y @usher-run\/mcp/);
});

test('the front page shows what the customer sees (Brightwater, natively) beside the Usher rails, the decision card picked out, nothing consequential pre-ticked', async () => {
  const home = await (await fetch(`${registry.url}/`)).text();
  const section = /<section class="between" id="how"[\s\S]*?<\/section>/.exec(home)?.[0] ?? '';
  assert.ok(section.includes(`Add ${registry.url}/mcp to any assistant that speaks MCP.`));
  assert.match(section, /<div class="view" id="assistant">/, 'the old #assistant links still land here');
  const figure = /<figure class="assistant uc"[^>]* inert>[\s\S]*?<\/figure>/.exec(section)?.[0] ?? '';
  assert.ok(figure, 'a drawn, inert illustration');
  // The customer's side, in order: their message, the assistant working, the card, the quote.
  const order = [...figure.matchAll(/class="(step person|step said s-working|step said s-decision|step said s-result)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['step person', 'step said s-working', 'step said s-decision', 'step said s-result']);
  for (const text of ['Get me a health insurance quote from Brightwater. I&#39;m Sam Taylor, born 2 April 1988, WR14 1AA, just me, non-smoker, comprehensive cover with a £250 excess.', 'Brightwater Insurance app connected', 'Getting your quote from Brightwater Insurance', 'Before we get your quote', 'Brightwater is asking you, not your assistant', 'Have you smoked or used nicotine products in the last 12 months?', 'You said: <b>No</b>', 'I confirm the information I have given is true and complete, and I understand that my medical history will be asked about after the quote', '“Get my quote”', '>Confirm</span>', 'a month', 'Quote reference', 'This quote is valid for']) assert.ok(figure.includes(text), text);
  for (const cls of ['class="card decision"', 'class="asking"', 'class="tag req"', 'class="yesno"', 'class="facts"', 'class="callout"']) assert.ok(figure.includes(cls), cls);
  // Native: Brightwater's, with Usher named only in the reader's annotation on the decision card.
  assert.doesNotMatch(figure.replace(/<p class="callout">[\s\S]*?<\/p>/, ''), /Usher/);
  // Drawn boxes, not inputs; no third party's product or logo.
  assert.doesNotMatch(figure, /<input|<button|Claude|ChatGPT|OpenAI|Anthropic|Gemini|Copilot|Cursor|Meta AI|<img|<svg/);
  // Before it plays: boxes empty, Confirm greyed, the card waiting (site.js marks the steps reached).
  assert.match(home, /\.seq\.seq-on:not\(\.r4\) \.check \.box \{ background:transparent;/);
  assert.match(home, /\.seq\.seq-on:not\(\.r5\) \.confirm \{ opacity:\.45; \}/);
  assert.match(home, /\.seq\.seq-on\.r4:not\(\.r5\) \.card\.decision \{ animation:glow/);
  assert.match(await (await fetch(`${registry.url}/site.js`)).text(), /seq\.classList\.toggle\('r' \+ k/);
});

test('For agents leads with the hosted URL; the local server is one click away; the hero buttons go where they say', async () => {
  const home = await (await fetch(`${registry.url}/`)).text();
  const card = /<div class="card" id="agents">[\s\S]*?<\/details>/.exec(home)?.[0] ?? '';
  const fold = card.split('<details')[0]!;
  assert.ok(fold.includes('No signup. Your agent&#39;s key is its identity.') || fold.includes("No signup. Your agent's key is its identity."));
  assert.ok(fold.includes(`<pre class="wrap">${registry.url}/mcp</pre>`));
  assert.ok(fold.includes('<p>Hosted Usher acts on sites that have joined.</p>'));
  assert.doesNotMatch(fold, /npx|mcpServers/, 'nothing local above the fold');
  assert.match(card, /<details class="local"><summary>Running your own agent or framework\?<\/summary>[\s\S]*mcpServers[\s\S]*The local server acts on any site, with your own key\./);
  assert.match(home, /<a class="button" href="\/sites\/new">Get your keys<\/a><a class="button ghost" href="#agents">Connect an agent<\/a>/);
  assert.match(home, /<a href="#assistant">See it inside an assistant<\/a>/);
});
