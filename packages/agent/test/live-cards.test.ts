// The live demo runner's own screens: the diagram labels each Meta model by its job, the ticket
// shows structure only (and escapes what it shows), and the race replays the recorded runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { diagramCard, raceCard, ticketCard } from '../scripts/live/cards.ts';

test('the diagram names map, knock and log, and each model by its job', () => {
  const svg = diagramCard();
  for (const s of ['Map', 'Knock', 'Log', 'labels each field by meaning', 'second opinion on risk', 'turns plain-English rules into policy', 'explains sessions to the site owner', 'Spark Open triages a change, Spark rebuilds']) assert.ok(svg.includes(s), s);
});

test('the ticket shows keys and counts, escaped, and the pass lifetime it is given', () => {
  const html = ticketCard({ purpose: 'Quote <b>', session: 's_x', agent: 'hosted:abc', identity: 'hosted', knocks: [{ path: '/quote/driver', match: 'exact' }], byMeaning: 3, confirm: ['form.submit'], userOnly: ['consent.declaration'], fields: 13, digest: 'sha256:00' }, 10);
  assert.ok(html.includes('Quote &lt;b&gt;'));
  assert.ok(html.includes('form.submit') && html.includes('consent.declaration'));
  assert.match(html, /lasts 10 minutes/);
});

test('the race replays the recorded runs: 124.5 s reading the form, 40.3 s with usher_fill', async () => {
  const runs = (await readFile(new URL('../../../examples/browser-use/results.jsonl', import.meta.url), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { mode: string; seconds: number });
  assert.equal(runs.find((r) => r.mode === 'without')?.seconds, 124.5);
  assert.equal(runs.find((r) => r.mode === 'fill')?.seconds, 40.3);
  const html = raceCard({ title: 'a', seconds: 124.5, steps: [{ at: 1, what: 'input' }] }, { title: 'b', seconds: 40.3, steps: [{ at: 1, what: 'usher_fill' }] }, 'note', 1);
  assert.match(html, /window\.startRace/);
  assert.match(html, /"seconds":124\.5/);
});
