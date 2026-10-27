// Usher's own front page is agent-ready: the reference agent, asked to register interest, knocks,
// reads the page with a (scripted) model, goes past the map viewer's picker to the interest form, asks its
// user before sending, and the server-side check lets it through. The admin list says an agent sent it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import type { ChatFn, ChatRequest } from '@usher/core';
import { startRegistry, type RunningRegistry } from '@usher/registry';
import { httpTransport, runAgent, scriptedUser, type Profile } from '../src/index.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';
import { pickerForms } from '../../registry/src/web/picker.ts';

const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
const profile: Profile = { 'custom.website': 'https://shop.example', 'contact.email': 'owner@shop.example', 'message.body': 'Sent by my agent' };

// A scripted model: chooses the form with an email box, then labels it. Never a selector.
const asked: string[] = [];
const scripted: ChatFn = async (request: ChatRequest) => {
  const name = (request.response_format as { json_schema?: { name: string } } | undefined)?.json_schema?.name ?? '';
  asked.push(name);
  const user = JSON.stringify(request.messages.at(-1)?.content);
  const content =
    name === 'form_choice'
      ? JSON.stringify({ form: /(F\d+): [^\\]*\(email\)/.exec(user)![1], reason: 'the interest form' })
      : JSON.stringify({
          form: { purpose: 'Register interest in Usher', intent: 'contact.interest' },
          elements: [
            { id: 'e1', key: 'custom.website', risk: 'safe', shown_if: null },
            { id: 'e2', key: 'contact.email', risk: 'safe', shown_if: null },
            { id: 'e3', key: 'message.body', risk: 'safe', shown_if: null },
            { id: 'e4', key: 'form.submit', risk: 'consequential', shown_if: null },
          ],
          advance_action_id: 'e4',
        });
  return { content, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 }, latency_ms: 0, response: {} };
};

let dir: string;
let registry: RunningRegistry;
let browser: Browser;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-landing-agent-'));
  registry = await startRegistry({ storage: await testStorage(join(dir, 'registry')), siteScript, web: { adminKey: 'admin-test-key', viewer: 'open', forms: pickerForms() } });
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await registry.close();
  await rm(dir, { recursive: true });
});

test("an agent registers interest on Usher's own front page: knocks, asks its user, gets through the check", async () => {
  const user = scriptedUser(profile);
  const run = await runAgent({ browser, url: `${registry.url}/`, profile, intent: 'contact.interest', registry: await httpTransport(registry.url, join(dir, 'agent.json')), user, fallback: { chat: scripted, model: 'muse-spark-1.3', logDir: null } });
  assert.equal(run.outcome, 'completed', run.reason);
  // The picker has buttons and no fields, so it is never a candidate: the interest form is the only one.
  assert.deepEqual(asked, ['usher_labels'], 'went straight to the interest form, past the picker, and labelled it');
  assert.deepEqual(user.confirmations, ['form.submit'], 'asked its user before sending');
  const stored = (await registry.registry.storage.readLog('interest')) as { email: string; via: string }[];
  assert.deepEqual(stored.map((s) => [s.email, s.via]), [['owner@shop.example', 'agent']]);
});
