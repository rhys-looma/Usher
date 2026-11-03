// When a task finishes, by the site owner's choice: no way out, with what they chose to return and
// their own words; the reference and a link to the site's own page; or a one-time link the site's
// server turns into a session of its own, in the person's own browser. The link can't be spent by a
// preview, can't be used twice, and an agent's ordinary token opens nothing.

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
import { registerSite } from '../../registry/test/sites.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';
import { hostedMcp } from '../src/hosted.ts';

const profile = JSON.parse(await readFile(new URL('../../agent/profiles/test-driver.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const { _comment: _, 'consent.declaration': _d, 'consent.marketing': _m, ...values } = profile;
const INTENT = 'quote.car_insurance';
const RETRIEVE = { url: '/retrieve', label: 'Find your quote', asks: ['your quote reference', 'your date of birth'], reference_param: 'reference' };

let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let browser: Browser;
let client: Client;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-handoff-'));
  browser = await chromium.launch();
  registry = await startRegistry({ storage: await testStorage(dir), siteScript: fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url)), mcp: (r) => hostedMcp({ registry: r, version: 'test', browser: async () => browser, allowPrivate: true }) });
  site = await startMockSite({ registry: registry.url, register: async (o) => (await registerSite(registry, o)).site_key });
  await seed(registry.registry, 'mock-site', site.url);
  client = new Client({ name: 'test-client', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${registry.url}/mcp`)));
});
after(async () => {
  await client.close().catch(() => undefined);
  await registry.close();
  await site.stop();
  await browser.close();
  await rm(dir, { recursive: true });
});

interface Finished {
  status: string;
  session: string;
  result: { facts: string[]; reference?: string; message?: string; continue?: { url: string; label: string; asks: string[] } };
}

/** A car quote through the hosted tools, with the owner's setting for it; the person says yes to all but marketing. */
async function finish(setting: unknown): Promise<{ done: Finished; text: string; hasImage: boolean }> {
  const saved = await registry.registry.setSiteHandoff(site.url, INTENT, setting);
  assert.ok(!('problems' in saved), JSON.stringify(saved));
  type Reply = { structuredContent: Finished & { id: string; decisions?: { key: string }[] }; content: { type: string; text?: string }[] };
  let reply = (await client.callTool({ name: 'usher_fill', arguments: { url: `${site.url}/quote/driver`, intent: INTENT, values } })) as unknown as Reply;
  while ((reply.structuredContent.status as string) === 'needs_decision') {
    const answers = Object.fromEntries(reply.structuredContent.decisions!.map((d) => [d.key, d.key !== 'consent.marketing']));
    reply = (await client.callTool({ name: 'usher_confirm', arguments: { id: reply.structuredContent.id, answers } })) as unknown as Reply;
  }
  assert.equal(reply.structuredContent.status, 'completed', JSON.stringify(reply.structuredContent).slice(0, 500));
  return { done: reply.structuredContent, text: reply.content.map((c) => c.text ?? '').join('\n'), hasImage: reply.content.some((c) => c.type === 'image') };
}

test('stay in the assistant: no link, what the owner chose to return, and their own words', async () => {
  const message = "We'll email your documents within a day.";
  const { done, text, hasImage } = await finish({ mode: 'none', show: 'all', message });
  assert.equal(done.result.continue, undefined);
  assert.match(done.result.facts.join(' '), /£[\d,]+\.\d\d a year/);
  assert.equal(done.result.message, message);
  assert.ok(text.includes(message));
  assert.doesNotMatch(text, /your user opens/);
  assert.ok(hasImage);

  const reference = await finish({ mode: 'none', show: 'reference' });
  assert.deepEqual(reference.done.result.facts.length, 1);
  assert.match(reference.done.result.facts[0]!, /Quote reference BW-/);
  assert.match(reference.done.result.reference!, /^BW-/);
  assert.doesNotMatch(reference.text, /£/);
  assert.ok(!reference.hasImage, 'a picture of the page would show the rest');

  const nothing = await finish({ mode: 'none', show: 'nothing', message });
  assert.deepEqual(nothing.done.result.facts, []);
  assert.equal(nothing.done.result.reference, undefined);
  assert.equal(nothing.done.result.message, message);
  assert.ok(!nothing.hasImage);
});

test('tell them how: the reference and the site\'s own page, even when nothing else is returned', async () => {
  const { done } = await finish({ mode: 'instructions', show: 'nothing', resume: RETRIEVE });
  assert.match(done.result.reference!, /^BW-/);
  assert.equal(done.result.continue!.url, `${site.url}/retrieve?reference=${done.result.reference}`);
  assert.deepEqual(done.result.continue!.asks, RETRIEVE.asks);
});

test('open it on the site: in the person\'s own browser, once; a preview spends nothing', async () => {
  const { done } = await finish({ mode: 'redirect', show: 'all', redirect: { url: '/handoff', label: 'Open your quote' }, resume: RETRIEVE });
  const link = done.result.continue!;
  assert.deepEqual([link.label, link.asks], ['Open your quote', []]);
  assert.match(link.url, new RegExp(`^${site.url}/handoff\\?token=`));

  // A chat app fetching the link for a preview: it gets the page, and the token still works.
  const preview = await fetch(link.url);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('referrer-policy'), 'no-referrer');

  const own = await (await browser.newContext()).newPage();
  await own.goto(link.url);
  await own.waitForURL(/\/quote\/result$/);
  assert.match(await own.locator('.ref').innerText(), new RegExp(done.result.reference!));
  const cookie = (await own.context().cookies()).find((c) => c.name === 'bw_sid');
  assert.equal(cookie?.httpOnly, true, 'the site\'s own session, in its own kind of cookie');

  // The same link again, in another browser: the site's own page instead, and no quote.
  const again = await (await browser.newContext()).newPage();
  await again.goto(link.url);
  await again.waitForURL(/\/retrieve$/);
  assert.equal(await again.locator('.ref').count(), 0);
  await own.context().close();
  await again.context().close();
});

test('an agent\'s ordinary token opens nothing, even for the session that made the quote', async () => {
  const { done } = await finish({ mode: 'redirect', show: 'all', redirect: { url: '/handoff', label: 'Open your quote' }, resume: RETRIEVE });
  const knock = (await client.callTool({ name: 'knock', arguments: { url: `${site.url}/quote/driver`, intent: INTENT, session: done.session } })).structuredContent as { token?: string };
  assert.ok(knock.token, 'an agent token');
  const res = await fetch(`${site.url}/handoff`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: knock.token }) });
  assert.deepEqual([res.status, res.headers.get('location')], [303, '/retrieve']);
});

test('a handoff token submits nothing: it is refused where an agent\'s token is needed', async () => {
  const { done } = await finish({ mode: 'redirect', show: 'all', redirect: { url: '/handoff', label: 'Open your quote' }, resume: RETRIEVE });
  const token = new URL(done.result.continue!.url).searchParams.get('token')!;
  const res = await fetch(`${site.url}/api/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Usher ${token}` }, body: '{}' });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { reason?: string }).reason, 'wrong_scope');
  // Nor can it write to the session's log at the registry.
  const events = await fetch(`${registry.url}/sessions/${done.session}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Usher ${token}` }, body: JSON.stringify({ events: [{ ts: new Date().toISOString(), source: 'agent', action: 'click' }] }) });
  assert.ok(events.status >= 400, `refused, got ${events.status}`);
});

test('a site that hasn\'t finished the setup: no link is signed without a redirect route, and the setting is checked', async () => {
  const refused = await registry.registry.setSiteHandoff(site.url, INTENT, { mode: 'redirect', redirect: { url: 'https://evil.example/x' } });
  assert.ok('problems' in refused);
  assert.ok('problems' in (await registry.registry.setSiteHandoff(site.url, INTENT, { mode: 'instructions' })), 'instructions need a page');
  assert.ok('problems' in (await registry.registry.setSiteHandoff(site.url, INTENT, { mode: 'none', message: 'x'.repeat(301) })));
  assert.ok('problems' in (await registry.registry.setSiteHandoff(site.url, INTENT, { mode: 'sideways' })));
  assert.equal((await registry.registry.finishedRun(site.url, INTENT, 's_nobody'))?.link, undefined, 'no session, no link');
});

test('the seeded route isn\'t under /usher/, which the CDN treats as static and GET-only', async () => {
  const seeded = JSON.parse(await readFile(new URL('../../registry/seed/mock-site/handoff.json', import.meta.url), 'utf8')) as Record<string, { redirect?: { url: string } }>;
  const cdn = await readFile(new URL('../../../deploy/terraform/usher/cloudfront.tf', import.meta.url), 'utf8');
  assert.ok(/"\/usher\/\*"/.test(cdn), 'what this guards against');
  for (const entry of Object.values(seeded)) assert.doesNotMatch(entry.redirect?.url ?? '', /^\/usher\//);
});

test('a question the owner wants confirmed stays a question: the person\'s answer goes in, "no" included', async () => {
  const before = await registry.registry.storage.getPolicy(site.url);
  await registry.registry.storage.putPolicy({ ...before!, policy: { ...before!.policy, default: { ...before!.policy.default, actions: { ...before!.policy.default.actions, 'person.employment_status': 'confirm' } } } });
  await registry.registry.setSiteHandoff(site.url, INTENT, { mode: 'none' });
  type Reply = { structuredContent: { status: string; id: string; reason?: string; decisions?: { key: string; kind: string; value?: string; options?: string[] }[] } };
  try {
    const run = async (given: Record<string, unknown>, answer: (d: { key: string; kind: string; options?: string[] }) => unknown) => {
      const seen: { key: string; kind: string; value?: string; options?: string[] }[] = [];
      let reply = (await client.callTool({ name: 'usher_fill', arguments: { url: `${site.url}/quote/driver`, intent: INTENT, values: given } })) as unknown as Reply;
      while (reply.structuredContent.status === 'needs_decision') {
        seen.push(...reply.structuredContent.decisions!);
        const answers = Object.fromEntries(reply.structuredContent.decisions!.map((d) => [d.key, answer(d)]));
        reply = (await client.callTool({ name: 'usher_confirm', arguments: { id: reply.structuredContent.id, answers } })) as unknown as Reply;
      }
      return { status: reply.structuredContent.status, reason: reply.structuredContent.reason, asked: seen.find((d) => d.key === 'person.employment_status') };
    };
    const yes = (d: { key: string }) => d.key !== 'consent.marketing';
    // Not told yet: asked, with the site's options; not a tick box to skip.
    const { 'person.employment_status': said, ...rest } = values as Record<string, unknown>;
    const asked = await run(rest, (d) => (d.key === 'person.employment_status' ? d.options!.at(-1) : yes(d)));
    assert.equal(asked.asked?.kind, 'missing_value');
    assert.ok(asked.asked?.options?.length, 'with its options');
    assert.equal(asked.status, 'completed', asked.reason);
    // Already told: put back to them as they said it, then entered.
    const checked = await run({ ...rest, 'person.employment_status': said }, yes);
    assert.equal(checked.asked?.kind, 'confirm_value');
    assert.ok(checked.asked?.value);
    assert.equal(checked.status, 'completed', checked.reason);
  } finally {
    await registry.registry.storage.putPolicy(before!);
  }
});
