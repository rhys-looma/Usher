import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatFn } from '@usher/core';
import { replayAny, type LabelFixture } from '../../core/test/replay.ts';
import { explainFacts, formFacts, startRegistry } from '../src/index.ts';
import { ORIGIN, blocked, maps, sessions } from './explain-data.ts';
import { registerSite } from './sites.ts';
import { testStorage } from './storage-helper.ts';

const recorded = async (name: 'spark' | 'open') => JSON.parse(await readFile(new URL(`./fixtures/explanations/${name}.json`, import.meta.url), 'utf8')) as LabelFixture;
const spark = await recorded('spark');
const open = await recorded('open');
const all = await maps();
const byPath = (p: string) => all.find((m) => m.path === p)!;

test('facts: counts and stalls from the log, never values', () => {
  const driver = formFacts(byPath('/quote/driver'), sessions(), blocked);
  assert.equal(driver.sessions, 5);
  assert.equal(driver.agents, 5);
  assert.equal(driver.reached_way_forward, 5);
  assert.deepEqual(driver.stalls_over_10_seconds, [{ key: 'person.occupation', label: 'Occupation', control: 'select', options: 173, median_seconds: 44, agents: 5 }]);
  const cover = formFacts(byPath('/quote/cover'), sessions(), blocked);
  assert.deepEqual([cover.sessions, cover.paused_for_user_confirmation, cover.confirmed_by_user, cover.reached_way_forward], [3, 3, 3, 3]);
  assert.deepEqual(cover.handed_to_the_user, { 'consent.declaration': 3 });
  assert.deepEqual(cover.refused_attempts, { rate_limited: 1 });
  assert.equal(cover.read_the_page_themselves_no_exact_map, 0);
  assert.equal(formFacts(byPath('/quote/vehicle'), sessions(), blocked).sessions, 0);
});

for (const [name, fixture] of [['Muse Spark', spark], ['Muse Spark Open', open]] as const) {
  test(`${name}: one to three plain sentences that name the stall and the confirmations`, async () => {
    const chat = replayAny([fixture]);
    const driver = await explainFacts(chat, fixture.model, formFacts(byPath('/quote/driver'), sessions(), blocked));
    assert.match(driver.text, /Occupation/);
    assert.match(driver.text, /173/);
    assert.match(driver.text, /44 seconds/);
    const cover = await explainFacts(chat, fixture.model, formFacts(byPath('/quote/cover'), sessions(), blocked));
    assert.match(cover.text, /confirm/i);
    assert.match(cover.text, /rate.limit/i);
    for (const text of [driver.text, cover.text]) {
      const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
      assert.ok(sentences.length >= 1 && sentences.length <= 3, text);
      assert.ok(!/session id|json|\bevent\b/i.test(text), text);
    }
    console.log(`  ${name}:\n    driver: ${driver.text}\n    cover: ${cover.text}`);
  });
}

test('the dashboard shows explanations, regenerated on demand, cached when nothing changed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usher-explain-'));
  let calls = 0;
  const replay = replayAny([spark]);
  const counting: ChatFn = async (r) => (calls++, replay(r));
  const running = await startRegistry({ storage: await testStorage(dir), explainer: { chat: counting, model: spark.model }, web: { allowPrivate: true }, now: () => new Date('2026-10-27T12:00:00Z') });
  try {
    for (const m of all) await running.registry.addMap(m);
    for (const s of sessions()) await running.registry.storage.putSession(s);
    await running.registry.storage.appendLog('blocked', { ts: '2026-10-27T09:30:00Z', origin: ORIGIN, path: '/quote/cover', reason: 'rate_limited', source: 'registry' });
    const keys = await registerSite(running, ORIGIN);
    const login = await fetch(`${running.url}/dashboard/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ origin: ORIGIN, secret: keys.secret_key }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const get = async (path: string, post = false) => (await fetch(`${running.url}${path}`, { headers: { Cookie: cookie }, ...(post && { method: 'POST' }) })).text();

    assert.match(await get('/dashboard'), /No explanations yet/);
    const explained = await get('/dashboard/explain', true);
    assert.match(explained, /Explanations updated/);
    assert.match(explained, /stalled on Occupation/);
    assert.match(explained, /<code>\/quote\/cover<\/code>/);
    assert.equal(calls, 2, 'driver and cover; the unused vehicle form is skipped');
    await get('/dashboard/explain', true);
    assert.equal(calls, 2, 'nothing changed, nothing regenerated');

    const sessionPage = await get(`/dashboard/sessions/${sessions()[0]!.id}/explain`, true);
    assert.match(sessionPage, /One agent spent 38 seconds on Occupation/);
    assert.match(sessionPage, /Explain again/);
  } finally {
    await running.close();
    await rm(dir, { recursive: true });
  }
});
