import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagPage } from '../src/web/signup.ts';

const page = (origin?: string) => tagPage({ url: 'https://registry.example', siteKey: 'usp_key', ...(origin && { origin }) });

test('the tag page links a local demo site to its settings, and no other site', () => {
  assert.match(page('http://localhost:4301'), /href="http:\/\/localhost:4301\/__settings"/);
  assert.doesNotMatch(page('https://quote.example'), /__settings/);
  assert.doesNotMatch(page(), /__settings/);
});

test('the live walkthrough script parses: it is written inside a template string', async () => {
  const { WALKTHROUGH_JS } = await import('../src/web/walkthrough.ts');
  assert.doesNotThrow(() => new Function(WALKTHROUGH_JS));
  assert.match(WALKTHROUGH_JS, /visible element/);
});

test('Map my site explains the process on a local site only', async () => {
  const { startForm } = await import('../src/web/walkthrough.ts');
  assert.match(startForm('http://localhost:4301'), /You do:[\s\S]*You get:/);
  assert.doesNotMatch(startForm('https://quote.example'), /You get:/);
});

test('the publish page offers the chat tester on a local run, and the assistants everywhere else', async () => {
  const { appPage } = await import('../src/web/app.ts');
  const input = { origin: 'http://localhost:4301', name: 'Larchmont', endpoint: 'http://r/mcp/x', app: { enabled: true, enabled_at: '2026-11-04T00:00:00Z' }, setup: { steps: [{ key: 'joined', label: 'Joined', done_at: '2026-11-04T00:00:00Z' }] }, usage: { connections: 0, fills: 0 }, tools: [], look: '', now: new Date() } as never as Parameters<typeof appPage>[0];
  const local = appPage({ ...input, tester: 'http://chat/?site=x' });
  assert.match(local, /href="http:\/\/chat\/\?site=x"/);
  assert.doesNotMatch(local, /Add custom connector/);
  const live = appPage(input);
  assert.match(live, /Add custom connector/);
  assert.doesNotMatch(live, /chat tester/i);
});
