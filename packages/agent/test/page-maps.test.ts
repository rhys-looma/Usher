// The executor on a site that publishes its maps in its pages (the site script's
// <script type="application/usher+json" data-usher-map>): it runs the three-step quote on those
// maps alone, with no model and no lookups, and every knock carries only rules and a token.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { seed, startRegistry, type KnockResponse, type RunningRegistry, type Session } from '@usher/registry';
import { httpTransport, runAgent, scriptedUser, type Profile } from '../src/index.ts';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { registerSite, type SiteKeys } from '../../registry/test/sites.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';

const { _comment, ...profile } = JSON.parse(await readFile(new URL('../profiles/test-driver.json', import.meta.url), 'utf8')) as Profile & { _comment: string };
let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let browser: Browser;
let keys: SiteKeys;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-page-maps-'));
  registry = await startRegistry({ storage: await testStorage(dir), siteScript: fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url)) });
  site = await startMockSite({ registry: registry.url, register: async (origin) => (keys = await registerSite(registry, origin)).site_key });
  await seed(registry.registry, 'mock-site', site.url);
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await site.stop();
  await registry.close();
  await rm(dir, { recursive: true });
});

test('the executor runs the quote on the page\'s maps alone: every knock carries only rules and a token', async () => {
  const transport = await httpTransport(registry.url, join(dir, 'agent-key.json'));
  const knocks: KnockResponse[] = [];
  const lookups: string[] = [];
  const watched = {
    ...transport,
    knock: async (input: Parameters<typeof transport.knock>[0]) => {
      const reply = await transport.knock(input);
      knocks.push(reply);
      return reply;
    },
    lookup: async (url: string, fp: Parameters<typeof transport.lookup>[1]) => (lookups.push(url), transport.lookup(url, fp)),
  };
  // No model: if any page needed reading, the run would stop.
  const run = await runAgent({ browser, url: `${site.url}/quote/driver`, profile, intent: 'quote.car_insurance', registry: watched, user: scriptedUser(profile) });
  await transport.close();
  assert.equal(run.outcome, 'completed', run.reason);
  assert.match(run.final_url, /\/quote\/result$/);
  assert.deepEqual(run.pages.map((p) => p.map_source), ['embedded', 'embedded', 'embedded']);
  assert.ok(knocks.length >= 3);
  assert.ok(knocks.every((k) => k.map === null), 'no map in any knock reply');
  assert.ok(knocks.every((k) => typeof k.token === 'string' && k.rules), 'rules and a token');
  assert.deepEqual(lookups, [], 'no map lookups');
  const session = (await (await fetch(`${registry.url}/sessions/${run.session}`, { headers: { Authorization: `Bearer ${keys.secret_key}` } })).json()) as Session;
  const knocked = session.events.filter((e) => e.action === 'knock');
  assert.ok(knocked.every((e) => typeof e.detail?.page_map === 'string'), 'the log records that the agent used the page\'s map');
  assert.ok(session.events.some((e) => e.source === 'site' && e.action === 'submit' && e.key === 'form.submit'));
});
