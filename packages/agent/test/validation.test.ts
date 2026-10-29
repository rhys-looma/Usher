// Validation for agents: pre-flight checks by key before anything touches the page, and the site's
// own errors mapped back to keys when a step is rejected anyway.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { seed, startRegistry, type RunningRegistry, type Session } from '@usher/registry';
import { startMockSite, type MockSite } from '../../site-middleware/test/mock-site.ts';
import { registerSite, type SiteKeys } from '../../registry/test/sites.ts';
import { testStorage } from '../../registry/test/storage-helper.ts';
import { httpTransport, runAgent, scriptedUser, type Profile, type UserChannel } from '../src/index.ts';

const profile = JSON.parse(await readFile(new URL('../profiles/test-driver.json', import.meta.url), 'utf8')) as Profile;
let dir: string;
let registry: RunningRegistry;
let site: MockSite;
let keys: SiteKeys;
let browser: Browser;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-validation-'));
  registry = await startRegistry({ storage: await testStorage(join(dir, 'registry')), siteScript: fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url)) });
  site = await startMockSite({ registry: registry.url, register: async (o) => (keys = await registerSite(registry, o)).site_key });
  await seed(registry.registry, 'mock-site', site.url);
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await site.stop();
  await registry.close();
  await rm(dir, { recursive: true });
});

const go = async (p: Profile, options: { usePlan?: boolean; preflight?: boolean; user?: UserChannel } = {}) => {
  const transport = await httpTransport(registry.url, join(dir, 'agent.json'));
  const run = await runAgent({ browser, url: `${site.url}/quote/driver`, profile: p, intent: 'quote.car_insurance', registry: transport, user: options.user ?? scriptedUser(p), ...options });
  await transport.close();
  return run;
};
const session = async (sid: string): Promise<Session> => (await fetch(`${registry.url}/sessions/${sid}`, { headers: { Authorization: `Bearer ${keys.secret_key}` } })).json() as Promise<Session>;

test('with a plan, a wrong date format is caught before any page is opened', async () => {
  const run = await go({ ...profile, 'person.dob': '31/02/1988' });
  assert.equal(run.outcome, 'failed');
  assert.equal(run.plan_used, true);
  assert.deepEqual(run.problems?.map((p) => [p.key, p.problem]), [['person.dob', 'format']]);
  assert.equal(run.pages.length, 0);
  assert.equal(run.session, null, 'not even a knock');
});

test('a non-existent occupation is caught before the page is touched, against the full option list', async () => {
  const run = await go({ ...profile, 'person.occupation': 'astronaut-of-the-year' });
  assert.equal(run.outcome, 'failed');
  assert.deepEqual(run.problems?.map((p) => [p.key, p.problem]), [['person.occupation', 'not_an_option']]);
  assert.match(run.problems![0]!.expected!, /Accountant/);
  const log = await session(run.session!);
  assert.deepEqual(log.events.map((e) => e.action).filter((a) => a !== 'run'), ['knock'], 'knocked, then nothing filled');
});

test('options given by label are accepted and entered by value', async () => {
  const run = await go({ ...profile, 'person.occupation': 'Teacher', 'person.title': 'Mr' });
  assert.equal(run.outcome, 'completed', run.reason);
});

test('a server-side rejection comes back as { key, message } for the right field', async () => {
  // Skip pre-flight, so the site itself rejects the postcode.
  const run = await go({ ...profile, 'address.postcode': 'NOT A POSTCODE' }, { preflight: false, usePlan: false });
  assert.equal(run.outcome, 'failed');
  assert.deepEqual(run.errors, [{ key: 'address.postcode', message: 'Please complete this field' }]);
  // The site script logged which key, not the message or the value.
  let log = await session(run.session!);
  for (let i = 0; i < 20 && !log.events.some((e) => e.action === 'invalid'); i++) {
    await new Promise((r) => setTimeout(r, 100));
    log = await session(run.session!);
  }
  assert.ok(log.events.some((e) => e.action === 'invalid' && e.key === 'address.postcode'));
  assert.ok(!JSON.stringify(log).includes('NOT A POSTCODE'));
});

test('with a correction from the user, the agent fixes the named field and retries once', async () => {
  const corrections: string[] = [];
  const user: UserChannel = {
    ...scriptedUser(profile),
    async correct(problem) {
      corrections.push(problem.key);
      return problem.key === 'address.postcode' ? 'WR14 1AA' : null;
    },
  };
  const run = await go({ ...profile, 'address.postcode': 'NOT A POSTCODE' }, { preflight: false, usePlan: false, user });
  assert.equal(run.outcome, 'completed', run.reason);
  assert.deepEqual(corrections, ['address.postcode']);
});
