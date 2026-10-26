import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WINDOW_MS, effectiveRules, generateAgentIdentity, policySchemaErrors, requestHash, type ChatFn, type UsherPolicy } from '@usher/core';
import type { RecordedAttempt } from '../../core/test/replay.ts';
import { FileStorage, RegistryClient, RegistryError, compileRules, seed, seedMaps, startRegistry, toPolicy, type RulesDraftOutput } from '../src/index.ts';
import { PHRASINGS, RULES_ORIGIN } from './phrasings.ts';
import { registerSite } from './sites.ts';

interface RulesFixture {
  model: string;
  text: string;
  attempts: RecordedAttempt[];
}
const fixtures: RulesFixture[] = await Promise.all(PHRASINGS.map(async (_, i) => JSON.parse(await readFile(new URL(`./fixtures/rules/${i + 1}.json`, import.meta.url), 'utf8'))));
const maps = (await seedMaps('mock-site')).map((m) => ({ ...m, origin: RULES_ORIGIN }));

/** Answers each request with the recorded reply for it, from any of the fixtures. */
function replay(): ChatFn {
  const byHash = new Map(fixtures.flatMap((f) => f.attempts.map((a) => [a.request_sha256, a] as const)));
  return async (request) => {
    const a = byHash.get(requestHash(request));
    if (!a) throw new Error('No recorded reply for this request: run packages/registry/scripts/record-rules.ts.');
    return { content: a.content, usage: a.usage, latency_ms: a.latency_ms, response: {} };
  };
}

// What a policy means for the site's forms, so differently built policies compare by effect.
function meaning(policy: UsherPolicy) {
  return {
    forms: Object.fromEntries(maps.map((m) => [m.path, effectiveRules(policy, m, m.path)])),
    agents: policy.agents ?? { allow: '*' },
    limits: (policy.default.rate_limits ?? []).map((l) => `${l.action} ${l.max} per ${l.per} per ${WINDOW_MS[l.window] / 1000}s`).sort(),
  };
}

test('three phrasings of "agents can fill quotes, a human confirms submit, max five an hour" give equivalent policies', async () => {
  const results = [];
  for (const f of fixtures) results.push(await compileRules(replay(), f.model, f.text, RULES_ORIGIN, maps));
  for (const r of results) assert.equal(policySchemaErrors(r.policy), null);
  const [first, ...rest] = results.map((r) => meaning(r.policy));
  for (const m of rest) assert.deepEqual(m, first);
  // And it is the meaning intended.
  assert.equal(first!.forms['/quote/cover']!.actions['form.submit'], 'confirm');
  assert.equal(first!.forms['/quote/driver']!.actions['person.first_name'], 'allow');
  assert.ok(Object.values(first!.forms).every((f) => f.agent_lane));
  assert.deepEqual(first!.limits, ['form.submit 5 per agent per 3600s']);
  console.log(results.map((r, i) => `  ${i + 1}. ${PHRASINGS[i]}\n     → ${r.summary}`).join('\n'));
});

test('the model output becomes a policy: per-form rules, agents, retention', () => {
  const out: RulesDraftOutput = {
    summary: 's',
    agent_lane: true,
    forms_without_agents: ['/account/**'],
    actions: [
      { key: 'form.submit', rule: 'confirm', path: null },
      { key: 'consent.marketing', rule: 'forbid', path: '/quote/*' },
    ],
    rate_limits: [{ action: 'knock', per: 'origin', max: 100, window: 'day', path: '/quote/*' }],
    allowed_agents: null,
    blocked_agents: ['Xq3vT0p2bN8mLr6sYwK1dE5gHj9uZc4aFo7iPe2Rk0Q'],
    retention_days: 14,
  };
  const policy = toPolicy(RULES_ORIGIN, out);
  assert.equal(policySchemaErrors(policy), null);
  assert.deepEqual(policy, {
    usher_policy: '0.1',
    origin: RULES_ORIGIN,
    default: { agent_lane: true, actions: { 'form.submit': 'confirm' } },
    forms: [
      { match: { path: '/account/**' }, agent_lane: false },
      { match: { path: '/quote/*' }, actions: { 'consent.marketing': 'forbid' }, rate_limits: [{ action: 'knock', per: 'origin', max: 100, window: 'day' }] },
    ],
    agents: { allow: '*', block: ['Xq3vT0p2bN8mLr6sYwK1dE5gHj9uZc4aFo7iPe2Rk0Q'] },
    retention: { session_days: 14 },
  });
});

test('a rule looser than the map is sent back once, then refused', async () => {
  const loose = JSON.stringify({ summary: 's', agent_lane: true, forms_without_agents: [], actions: [{ key: 'form.submit', rule: 'allow', path: null }], rate_limits: [], allowed_agents: null, blocked_agents: [], retention_days: null });
  const seen: string[] = [];
  const chat: ChatFn = async (request) => {
    seen.push(String(request.messages.at(-1)!.content));
    return { content: loose, usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cached_tokens: 0 }, latency_ms: 1, response: {} };
  };
  await assert.rejects(() => compileRules(chat, 'muse-spark-1.3', 'anything goes', RULES_ORIGIN, maps), /at least "confirm", not "allow"/);
  assert.equal(seen.length, 2);
  assert.match(seen[1]!, /looser_than_map/);
});

test('rules endpoints: propose from English, nothing applies until the owner confirms', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usher-rules-'));
  const running = await startRegistry({ storage: new FileStorage(dir), chat: replay(), model: fixtures[0]!.model });
  try {
    await seed(running.registry, 'mock-site', RULES_ORIGIN);
    const keys = await registerSite(running, RULES_ORIGIN);
    const url = `${running.url}/sites/${encodeURIComponent(RULES_ORIGIN)}/rules`;
    const auth = { Authorization: `Bearer ${keys.secret_key}`, 'Content-Type': 'application/json' };

    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: PHRASINGS[0] }) })).status, 401);
    const proposed = await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify({ text: PHRASINGS[0] }) });
    assert.equal(proposed.status, 201);
    const draft = await proposed.json();
    assert.equal(draft.status, 'pending');
    assert.equal(draft.text, PHRASINGS[0]);

    // Not applied yet: no rate limit.
    const agent = new RegistryClient(running.url, (await generateAgentIdentity()).identity);
    const cover = { url: `${RULES_ORIGIN}/quote/cover`, fingerprint: maps[2]!.fingerprint, confirmed: ['form.submit'] };
    for (let i = 0; i < 6; i++) await agent.knock(cover);

    const confirmed = await fetch(`${url}/${draft.id}/confirm`, { method: 'POST', headers: auth });
    assert.equal(confirmed.status, 200);
    const listed = await (await fetch(url, { headers: auth })).json();
    assert.equal(listed.current.text, PHRASINGS[0], 'the English is kept with the policy');
    assert.deepEqual(listed.current.policy, draft.policy);
    assert.equal(listed.drafts[0].status, 'confirmed');

    // Now it governs: a new agent gets five confirmed quote requests an hour.
    const fresh = new RegistryClient(running.url, (await generateAgentIdentity()).identity);
    for (let i = 0; i < 5; i++) await fresh.knock(cover);
    await assert.rejects(() => fresh.knock(cover), (e: RegistryError) => e.status === 429);
    assert.equal((await fetch(`${url}/${draft.id}/confirm`, { method: 'POST', headers: auth })).status, 404, 'a draft is confirmed once');
  } finally {
    await running.close();
    await rm(dir, { recursive: true });
  }
});
