// The public demo dashboard (/demo/dashboard): the demo site's dashboard for anyone, read-only.
// Sessions appear by agent and by meaning, never values; nothing that changes state is offered;
// the rules sandbox previews a policy without storing or applying it; and other people's agents'
// sessions are pruned after a day while ours are kept.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAgentIdentity, type ChatFn } from '@usher/core';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { RegistryClient, seed, startRegistry, type RunningRegistry } from '../src/index.ts';
import { registerSite } from './sites.ts';
import { testStorage } from './storage-helper.ts';

const fixture = JSON.parse(await readFile(new URL('./fixtures/rules/1.json', import.meta.url), 'utf8')) as { text: string; attempts: { content: string; usage: Record<string, number> }[] };
// The recorded reply to "Agents can fill in quotes, but a human confirms the submit. Max five an hour."
const chat: ChatFn = async () => ({ content: fixture.attempts.at(-1)!.content, usage: fixture.attempts.at(-1)!.usage as never, latency_ms: 1, response: {} });

let dir: string;
let registry: RunningRegistry;
let bare: RunningRegistry;
let site: MockSite;
let ours: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-demo-board-'));
  site = await startMockSite({ register: async () => 'usp_unused' });
  ours = (await generateAgentIdentity()).identity.id;
  registry = await startRegistry({ storage: await testStorage(join(dir, 'a')), chat, model: 'muse-spark-1.3', web: {}, publicDemo: { origin: site.url, keepAgents: [ours] } });
  await registerSite(registry, site.url);
  await seed(registry.registry, 'mock-site', site.url);
  bare = await startRegistry({ storage: await testStorage(join(dir, 'b')), web: {} });
});
after(async () => {
  await registry.close();
  await bare.close();
  await site.stop();
  await rm(dir, { recursive: true });
});

const get = async (path: string, r = registry) => {
  const res = await fetch(`${r.url}${path}`);
  return { status: res.status, text: await res.text(), csp: res.headers.get('content-security-policy') ?? '' };
};
const post = (path: string, form: Record<string, string>) => fetch(`${registry.url}${path}`, { method: 'POST', body: new URLSearchParams(form), redirect: 'manual' });

test('anyone can read it, with no sign-in: the banner, the forms and their maps, live refresh', async () => {
  const { status, text, csp } = await get('/demo/dashboard');
  assert.equal(status, 200);
  assert.ok(text.includes('<b>This is the demo site&#39;s live dashboard.</b>') || text.includes("<b>This is the demo site's live dashboard.</b>"));
  assert.match(text, /and your agent&#39;s session appears here|and your agent's session appears here/);
  for (const path of ['/quote/driver', '/quote/vehicle', '/quote/cover']) assert.ok(text.includes(`<code>${path}</code>`), path);
  assert.ok(text.includes('<script src="/demo.js" defer></script>'));
  assert.match(csp, /script-src 'self'; connect-src 'self'/);
  assert.ok(text.includes('data-live="top"') && text.includes('data-live="bottom"'));
  const js = await get('/demo.js');
  assert.equal(js.status, 200);
  assert.match(js.text, /setInterval\(refresh, 4000\)/);
});

test('nothing that changes state is offered, and the signed-in dashboard stays signed-in', async () => {
  const { text } = await get('/demo/dashboard');
  for (const banned of ['/dashboard/logout', 'action="/dashboard/rules"', 'Confirm and apply', 'Explain recent sessions', '/dashboard/explain', 'secret', 'uss_', 'usp_']) assert.ok(!text.includes(banned), banned);
  assert.equal((await post('/demo/dashboard/explain', {})).status, 405);
  assert.equal((await post('/demo/dashboard/rules/r_x/confirm', {})).status, 405);
  assert.equal((await get('/demo/dashboard/maps/sha256:00')).status, 404);
  assert.match((await get('/dashboard')).text, /Sign in/, 'the real dashboard still asks for keys');
});

test('a fresh agent\'s session appears, by agent and by meaning, never values', async () => {
  const client = new RegistryClient(registry.url, (await generateAgentIdentity()).identity);
  const knock = await client.knock({ url: `${site.url}/quote/driver`, intent: 'quote.car_insurance' });
  await fetch(`${registry.url}/sessions/${knock.session}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Usher ${knock.token}` },
    body: JSON.stringify({ events: [{ ts: new Date().toISOString(), source: 'site', action: 'fill', path: '/quote/driver', key: 'person.first_name' }] }),
  });
  const board = await get('/demo/dashboard');
  assert.ok(board.text.includes(`href="/demo/dashboard/sessions/${knock.session}"`), 'listed');
  const page = await get(`/demo/dashboard/sessions/${knock.session}`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('<b>fill</b> <code>person.first_name</code>'));
  assert.ok(page.text.includes('data-live="timeline"'));
  assert.ok(!page.text.includes('Explain this session'));
  assert.equal((await get('/demo/dashboard/sessions/s_nonexistent')).status, 404);
});

test('the rules sandbox shows the policy Muse Spark makes, marked preview only, and applies nothing', async () => {
  const before = await registry.registry.storage.getPolicy(site.url);
  const res = await post('/demo/dashboard/rules', { text: fixture.text });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(text.includes('preview only, not applied'));
  assert.match(text, /form\.submit/);
  assert.match(text, /at most 5 <code>/);
  assert.deepEqual(await registry.registry.storage.getPolicy(site.url), before, 'the policy is unchanged');
  assert.deepEqual(await registry.registry.storage.listDrafts(site.url), [], 'no draft stored');
  // A few previews per visitor an hour: the model costs money.
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) statuses.push((await post('/demo/dashboard/rules', { text: fixture.text })).status);
  assert.equal(statuses.at(-1), 429);
});

test('other people\'s agents\' sessions go after a day; ours stay', async () => {
  const storage = registry.registry.storage;
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const session = (id: string, agent: string, created_at: string) => ({ id, origin: site.url, agent, intent: 'quote.car_insurance', created_at, events: [], identity: { method: 'usher-signature' as const } });
  await storage.putSession(session('s_oldtheirs000', 'someone-else', ago(25)));
  await storage.putSession(session('s_newtheirs000', 'someone-else', ago(2)));
  await storage.putSession(session('s_oldours00000', ours, ago(25)));
  await registry.registry.pruneSessions(site.url);
  const left = (await storage.listSessions(site.url)).map((s) => s.id);
  assert.ok(!left.includes('s_oldtheirs000'), 'pruned');
  assert.ok(left.includes('s_newtheirs000') && left.includes('s_oldours00000'));
});

test('the front page links it; a registry with no demo site has neither', async () => {
  assert.match((await get('/')).text, /<a class="button ghost" href="\/demo\/dashboard">See the site&#39;s view<\/a>|<a class="button ghost" href="\/demo\/dashboard">See the site's view<\/a>/);
  assert.ok(!(await get('/', bare)).text.includes('/demo/dashboard'));
  assert.ok(!(await get('/', bare)).text.includes('id="assistant"'), 'no hosted MCP, no assistant section');
  assert.equal((await get('/demo/dashboard', bare)).status, 404);
});

test('on the demo, each agent confirms at most five quotes an hour, whatever the site\'s rules say', async () => {
  // The site's own rules carry the same limit: it still counts once, so five get through, not two.
  await registry.registry.storage.putPolicy({ policy: { usher_policy: '0.1', origin: site.url, default: { rate_limits: [{ action: 'form.submit', per: 'agent', max: 5, window: 'hour' }] } }, confirmed_at: new Date().toISOString() });
  const cover = { url: `${site.url}/quote/cover`, intent: 'quote.car_insurance', confirmed: ['form.submit'] };
  const agent = new RegistryClient(registry.url, (await generateAgentIdentity()).identity);
  for (let i = 0; i < 5; i++) await agent.knock(cover);
  await assert.rejects(agent.knock(cover), (e: { status: number; message: string }) => e.status === 429 && /At most 5 form\.submit per agent per hour/.test(e.message));
  await agent.knock({ url: cover.url, intent: cover.intent }); // filling in is still fine
  await new RegistryClient(registry.url, (await generateAgentIdentity()).identity).knock(cover); // another agent has its own five
  assert.match((await get('/demo/dashboard')).text, /at most 5 confirmed quotes \(<code>form\.submit<\/code>\) an hour/);
});
