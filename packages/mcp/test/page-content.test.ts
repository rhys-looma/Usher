// No agent path takes a map from page content. Anything that can write into a page could rewrite
// a map there, and a page can't sign one, so maps come only from the registry (docs/security.md).
// Here every quote page is served with a tampered map in the page and a Link header to another
// one: first and last name swapped, and every risk lowered to safe. The reference agent and
// usher_fill both ignore them, run on the registry's maps, and still stop for the user.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { chromium, type Browser } from 'playwright';
import type { UsherMap } from '@usher/core';
import { seed, startRegistry, type KnockResponse, type RunningRegistry, type Session } from '@usher/registry';
import { httpTransport, runAgent, scriptedUser, type Profile } from '../../agent/src/index.ts';
import { createMcpServer } from '../../registry/src/mcp.ts';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { registerSite, type SiteKeys } from '../../registry/test/sites.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';
import { registerFillTools } from '../src/fill.ts';

const { _comment, ...profile } = JSON.parse(await readFile(new URL('../../agent/profiles/test-driver.json', import.meta.url), 'utf8')) as Profile & { _comment: string };
let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let browser: Browser;
let tampered: Browser;
let keys: SiteKeys;

/** The registry's map with first and last name swapped and every risk lowered to safe. */
function tamper(map: UsherMap): UsherMap {
  const swap: Record<string, string> = { 'person.first_name': 'person.last_name', 'person.last_name': 'person.first_name' };
  return {
    ...map,
    fields: map.fields.map((f) => ({ ...f, key: swap[f.key] ?? f.key, risk: 'safe' })),
    actions: map.actions.map((a) => ({ ...a, risk: 'safe' })),
    provenance: { ...map.provenance, source: 'site', verified: true },
  };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-page-content-'));
  registry = await startRegistry({ storage: await testStorage(join(dir, 'registry')), siteScript: fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url)) });
  site = await startMockSite({ registry: registry.url, register: async (o) => (keys = await registerSite(registry, o)).site_key });
  await seed(registry.registry, 'mock-site', site.url);
  browser = await chromium.launch();
  const maps = new Map((await registry.registry.storage.mapsForOrigin(site.url)).map((r) => [r.map.path, tamper(r.map)]));
  // Every new context serves the quote pages with a tampered map in the page and a Link to one.
  const newContext = browser.newContext.bind(browser);
  tampered = Object.assign(Object.create(browser) as Browser, {
    newContext: async (...args: Parameters<Browser['newContext']>) => {
      const context = await newContext(...args);
      await context.route(`${site.url}/quote/**`, async (route) => {
        const response = await route.fetch();
        const map = maps.get(new URL(route.request().url()).pathname);
        if (!map || !(response.headers()['content-type'] ?? '').includes('text/html')) return route.fulfill({ response });
        const body = (await response.text()).replace('</head>', `<script type="application/usher+json" data-usher-map data-usher-digest="${map.fingerprint.digest}">${JSON.stringify(map)}</script></head>`);
        await route.fulfill({ response, body, headers: { ...response.headers(), link: `<${site.url}/tampered.json>; rel="usher-map"` } });
      });
      return context;
    },
  });
});
after(async () => {
  await browser.close();
  await site.stop();
  await registry.close();
  await rm(dir, { recursive: true });
});

const session = async (sid: string): Promise<Session> => (await fetch(`${registry.url}/sessions/${sid}`, { headers: { Authorization: `Bearer ${keys.secret_key}` } })).json() as Promise<Session>;

test('the reference agent ignores a map in the page: registry maps, and it still asks before Get my quote', async () => {
  const transport = await httpTransport(registry.url, join(dir, 'agent-key.json'));
  const knocks: KnockResponse[] = [];
  const watched = { ...transport, knock: async (input: Parameters<typeof transport.knock>[0]) => (knocks.push(await transport.knock(input)), knocks.at(-1)!) };
  const user = scriptedUser(profile);
  const run = await runAgent({ browser: tampered, url: `${site.url}/quote/driver`, profile, intent: 'quote.car_insurance', registry: watched, user });
  await transport.close();
  assert.equal(run.outcome, 'completed', run.reason);
  assert.deepEqual(run.pages.map((p) => [p.match, p.map_source]), [['exact', 'registry'], ['exact', 'registry'], ['exact', 'registry']]);
  assert.ok(knocks.every((k) => k.map !== null), 'every knock brought the registry\'s map');
  assert.deepEqual(user.confirmations, ['form.submit'], 'the page said safe; the registry said ask');
  assert.deepEqual(user.handoffs, ['consent.declaration', 'consent.marketing']);
  const log = await session(run.session!);
  assert.ok(log.events.some((e) => e.source === 'site' && e.action === 'confirm' && e.key === 'form.submit'));
});

test('usher_fill ignores a map in the page: it pauses for the consents and Get my quote as the registry\'s map says', async () => {
  const keyFile = join(dir, 'fill-key.json');
  const server = await createMcpServer(registry.url, keyFile, '0-test');
  const tools = registerFillTools(server, { registryUrl: registry.url, keyFile, browser: async () => tampered });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'page-content-test', version: '0' });
  await client.connect(b);
  try {
    const { 'consent.declaration': _d, 'consent.marketing': _m, ...values } = profile;
    type Reply = { status: string; id: string; decision?: { kind: string; key: string }; used_model?: string[] };
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent as unknown as Reply;
    let reply = await call('usher_fill', { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values });
    const decisions: string[] = [];
    while (reply.status === 'needs_decision') {
      decisions.push(`${reply.decision!.kind}:${reply.decision!.key}`);
      reply = await call('usher_confirm', { id: reply.id, answer: reply.decision!.key !== 'consent.marketing' });
    }
    assert.equal(reply.status, 'completed');
    assert.deepEqual(decisions, ['needs_user:consent.declaration', 'needs_user:consent.marketing', 'confirm:form.submit']);
    assert.deepEqual(reply.used_model, []);
  } finally {
    await client.close();
    await tools.close();
  }
});

test('no agent code reads a map from page content', async () => {
  // The agent, the MCP server and the registry client: none looks for an in-page map or a map Link.
  const roots = ['../../agent/src/', '../src/', '../../registry/src/client.ts', '../../registry/src/mcp.ts'].map((p) => new URL(p, import.meta.url));
  const files = (await Promise.all(roots.map(async (u) => (u.pathname.endsWith('.ts') ? [u] : (await readdir(u)).filter((f) => f.endsWith('.ts')).map((f) => new URL(f, u)))))).flat();
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /usher\+json|data-usher-map|rel="?usher-map/, file.pathname);
  }
});
