// Choosing the form by intent, end to end, on the mock site's help page (a site search, a callback
// form, a message form and a newsletter box). Agent C asks for a callback: the model chooses the
// callback form, though the message form has more fields, and C shares the map. Agent D, with no
// model, finds that map by fingerprint, and the page's script logs D's run against it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import type { ChatFn, ChatRequest } from '@usher/core';
import { startRegistry, type RunningRegistry, type Session } from '@usher/registry';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { registerSite, type SiteKeys } from '../../registry/test/sites.ts';
import { httpTransport, runAgent, scriptedUser, type Profile } from '../src/index.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';

const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
const profile: Profile = { 'person.full_name': 'Sam Taylor', 'contact.phone': '07700900123', 'custom.best_time_to_call': 'morning' };

// A scripted model: chooses the callback form, then labels it. Never writes a selector.
const requests: string[] = [];
const scripted: ChatFn = async (request: ChatRequest) => {
  const name = (request.response_format as { json_schema?: { name: string } } | undefined)?.json_schema?.name ?? '';
  requests.push(name);
  const user = JSON.stringify(request.messages.at(-1)?.content);
  const content =
    name === 'form_choice'
      ? JSON.stringify({ form: /F(\d+): purpose guess from its fields: person\.full_name, contact\.phone/.exec(user)![0].split(':')[0], reason: 'Request a callback' })
      : JSON.stringify({
          form: { purpose: 'Request a callback', intent: 'contact.callback' },
          elements: [
            { id: 'e1', key: 'person.full_name', risk: 'safe', shown_if: null },
            { id: 'e2', key: 'contact.phone', risk: 'safe', shown_if: null },
            { id: 'e3', key: 'custom.best_time_to_call', risk: 'safe', shown_if: null },
            { id: 'e4', key: 'form.submit', risk: 'consequential', shown_if: null },
          ],
          advance_action_id: 'e4',
        });
  return { content, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 }, latency_ms: 0, response: {} };
};

let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let browser: Browser;
let keys: SiteKeys;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-forms-'));
  registry = await startRegistry({ storage: await testStorage(join(dir, 'registry')), siteScript });
  site = await startMockSite({
    registry: registry.url,
    register: async (origin) => {
      keys = await registerSite(registry, origin);
      return keys.site_key;
    },
  });
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await site.stop();
  await registry.close();
  await rm(dir, { recursive: true });
});

test('the model chooses the callback form by intent; the next agent finds its map by fingerprint, no model', async () => {
  const transport = (key: string) => httpTransport(registry.url, join(dir, key));
  const c = await runAgent({ browser, url: `${site.url}/help`, profile, intent: 'contact.callback', registry: await transport('c.json'), user: scriptedUser(profile), fallback: { chat: scripted, model: 'muse-spark-1.3', logDir: null } });
  assert.equal(c.outcome, 'completed', c.reason);
  assert.deepEqual(requests, ['form_choice', 'usher_labels'], 'asked which form, then labelled it');
  assert.equal(c.pages[0]!.map_source, 'compiled');
  // Agent C's map is private to C until verified; verify it as the keeper would, so D can use it.
  for (const r of await registry.registry.storage.mapsForOrigin(site.url)) await registry.registry.verifyMap(site.url, r.digest, 'keeper');

  const d = await runAgent({ browser, url: `${site.url}/help`, profile, intent: 'contact.callback', registry: await transport('d.json'), user: scriptedUser(profile) });
  assert.equal(d.outcome, 'completed', d.reason);
  // The site script published the callback form's map (the one whose fingerprint the map has), not the likeliest form's.
  assert.equal(d.pages[0]!.map_source, 'embedded', 'the page publishes the callback form\'s map');
  assert.equal(requests.length, 2, 'no model for agent D');

  const session = (await (await fetch(`${registry.url}/sessions/${d.session}`, { headers: { Authorization: `Bearer ${keys.secret_key}` } })).json()) as Session;
  const filled = session.events.filter((e) => e.source === 'site' && e.action === 'fill').map((e) => e.key);
  assert.ok(filled.includes('contact.phone'), 'the page logged the run against the callback map');
});
