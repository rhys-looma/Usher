// The site decides whether an agent may enter a medical answer. A one-page form asks "Any medical
// conditions we should know about?" (health.condition, needs_user and sensitive). With no rule from
// the site, hosted usher_fill never fills it: the fill stops and leaves it to the person. Once the
// site's rules permit it ("confirm"), the person's own answer is read and put back to them on the
// decision card with the submit, entered as they said it, and the form is sent with it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium, type Browser } from 'playwright';
import { compilePage, type ChatFn } from '@usher/core';
import { startRegistry, type RunningRegistry } from '@usher/registry';
import { registerSite } from '../../registry/test/sites.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';
import { hostedMcp } from '../src/hosted.ts';

// The site has joined: it carries Usher's tag, which marks the form for agents to knock.
const FORM = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Your health | Test Insurer</title>
<script src="${registry.url}/usher.js" data-usher-registry="${registry.url}" data-usher-site-key="${siteKey}" defer></script></head><body>
<h1>Your health</h1>
<form method="post" action="/health/sent">
<label for="conditions">Any medical conditions we should know about?</label>
<input id="conditions" name="conditions" required>
<button type="submit">Send my answers</button>
</form></body></html>`;

let dir: string;
let registry: RunningRegistry;
let browser: Browser;
let site: Server;
let origin: string;
let siteKey = '';
const received: string[] = [];
const open: Client[] = [];

// The labels a model would give the page: meaning only, never a selector.
const labeller: ChatFn = async () => ({
  content: JSON.stringify({ form: { purpose: 'Health questions', intent: 'quote.health_insurance' }, elements: [{ id: 'e1', key: 'health.condition', risk: 'needs_user', shown_if: null }, { id: 'e2', key: 'form.submit', risk: 'consequential', shown_if: null }], advance_action_id: 'e2' }),
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 },
  latency_ms: 0,
  response: {},
});

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-permitted-'));
  browser = await chromium.launch();
  site = createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(new URLSearchParams(body).get('conditions') ?? '');
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Thank you</title><h1>Thank you</h1><p>We have your answers.</p>');
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(FORM());
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  registry = await startRegistry({ storage: await testStorage(join(dir, 'registry')), siteScript: fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url)), claims: { allowPrivate: true }, mcp: (r) => hostedMcp({ registry: r, version: 'test', browser: async () => browser, allowPrivate: true }) });
  siteKey = (await registerSite(registry, origin)).site_key;
  const page = await browser.newPage();
  await page.goto(`${origin}/health`);
  const { map } = await compilePage(page, { chat: labeller, model: 'muse-spark-1.3', logDir: null });
  await page.close();
  await registry.registry.addMap(map);
  // Verified, as the keeper would, so every agent sees it.
  for (const r of await registry.registry.storage.mapsForOrigin(origin)) await registry.registry.verifyMap(origin, r.digest, 'keeper');
});
after(async () => {
  for (const c of open) await c.close().catch(() => undefined);
  await registry.close();
  await browser.close();
  site.close();
  await rm(dir, { recursive: true });
});

async function fill(values: Record<string, string>) {
  const client = new Client({ name: 'permitted-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${registry.url}/mcp`)));
  open.push(client);
  const result = await client.callTool({ name: 'usher_fill', arguments: { url: `${origin}/health`, intent: 'quote.health_insurance', values } });
  return { client, reply: result.structuredContent as { status: string; id: string; reason?: string; decisions?: { kind: string; key: string; value?: string; short: string }[]; actions?: { action: string; key: string }[] } };
}

test('by default the medical question is the person\'s alone: the fill stops before it, nothing is entered or sent', async () => {
  const plan = (await (await fetch(`${registry.url}/plans?url=${encodeURIComponent(`${origin}/health`)}`)).json()) as { inputs: { key: string; rule?: string }[] };
  assert.equal(plan.inputs.find((i) => i.key === 'health.condition')?.rule, 'forbid', 'the plan says so before any knock');
  const { reply } = await fill({ 'health.condition': 'Asthma' });
  assert.equal(reply.status, 'stopped', JSON.stringify(reply).slice(0, 300));
  assert.match(reply.reason ?? '', /medical questions .*that this site leaves to the person/);
  assert.deepEqual(received, [], 'nothing sent');
});

test('the site permits it: the person\'s answer is put back to them with the submit, entered as said, and sent', async () => {
  await registry.registry.storage.putPolicy({ policy: { usher_policy: '0.1', origin, default: { actions: { 'health.condition': 'confirm' } } }, confirmed_at: new Date().toISOString() });
  const plan = (await (await fetch(`${registry.url}/plans?url=${encodeURIComponent(`${origin}/health`)}`)).json()) as { inputs: { key: string; rule?: string }[] };
  assert.equal(plan.inputs.find((i) => i.key === 'health.condition')?.rule, 'confirm');
  const { client, reply } = await fill({ 'health.condition': 'Asthma' });
  assert.equal(reply.status, 'needs_decision', JSON.stringify(reply).slice(0, 300));
  const condition = reply.decisions!.find((d) => d.key === 'health.condition')!;
  assert.deepEqual([condition.kind, condition.value], ['confirm_value', 'Asthma'], 'their own answer, back to them');
  assert.ok(reply.decisions!.some((d) => d.kind === 'submit'));
  const answers = Object.fromEntries(reply.decisions!.map((d) => [d.key, true]));
  const done = (await client.callTool({ name: 'usher_confirm', arguments: { id: reply.id, answers } })).structuredContent as { status: string; reason?: string; actions: { action: string; key: string }[] };
  assert.equal(done.status, 'completed', done.reason);
  assert.deepEqual(received, ['Asthma'], 'sent as they said it');
});

test('permitted, but the person says it isn\'t right: nothing is sent', async () => {
  const { client, reply } = await fill({ 'health.condition': 'None' });
  const answers = Object.fromEntries(reply.decisions!.map((d) => [d.key, d.key !== 'health.condition']));
  const done = (await client.callTool({ name: 'usher_confirm', arguments: { id: reply.id, answers } })).structuredContent as { status: string; reason?: string };
  assert.equal(done.status, 'stopped');
  assert.match(done.reason ?? '', /isn't their answer/);
  assert.deepEqual(received, ['Asthma'], 'nothing more sent');
});
