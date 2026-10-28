// Vote mode: the first run labels the whole page; later runs ask only about contested elements
// (several strong short-list candidates, or labelled risky) and those the runs disagree on. Majority
// per element for key and risk; ties take the stricter risk and, for keys, the short list's top
// candidate. The map carries per-element agreement counts, nothing else.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { compilePage, type ChatFn, type ChatRequest } from '../src/index.ts';
import { mapSchemaErrors } from '../src/schemas.ts';
import { strongCandidates } from '../src/compile/vote.ts';

const FORM = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Contact | Test</title></head><body>
<form action="/sent" method="post">
<label for="first">First name</label><input id="first" name="first" autocomplete="given-name">
<label for="tel">Phone or mobile number</label><input id="tel" name="tel" type="tel">
<label><input type="checkbox" name="terms" required> I agree to the terms</label>
<button type="submit">Send</button>
</form></body></html>`;

let browser: Browser;
before(async () => (browser = await chromium.launch()));
after(() => browser.close());

/** The form at an address of its own (every request answered here). */
async function formPage() {
  const context = await browser.newContext();
  await context.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FORM }));
  const page = await context.newPage();
  await page.goto('https://forms.example/contact');
  return page;
}

/** A model that answers by run: each run's labels for the ids it is asked about. */
function scripted(byRun: Record<string, { key: string; risk: string }>[]) {
  const asked: string[][] = [];
  const chat: ChatFn = async (request: ChatRequest) => {
    const text = JSON.stringify(request.messages.at(-1)?.content);
    const ids = [...new Set([...text.matchAll(/\\"id\\":\\"(e\d+)\\"/g)].map((m) => m[1]!))];
    const run = byRun[asked.length]!;
    asked.push(ids);
    const content = { form: { purpose: 'Contact', intent: 'contact.message' }, elements: ids.map((id) => ({ id, ...run[id]!, shown_if: null })), advance_action_id: ids.includes('e4') ? 'e4' : null };
    return { content: JSON.stringify(content), usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cached_tokens: 0 }, latency_ms: 5, response: {} };
  };
  return { chat, asked };
}

const base = { e1: { key: 'person.first_name', risk: 'safe' }, e2: { key: 'contact.phone', risk: 'safe' }, e3: { key: 'consent.terms', risk: 'needs_user' }, e4: { key: 'form.submit', risk: 'consequential' } };

test('only contested elements are asked again; the majority decides; the map carries the counts', async () => {
  const page = await formPage();
  const model = scripted([
    base,
    { ...base, e2: { key: 'contact.mobile', risk: 'safe' } },
    { ...base, e2: { key: 'contact.mobile', risk: 'safe' }, e4: { key: 'form.submit', risk: 'consequential' } },
  ]);
  const { map, votes, attempts } = await compilePage(page, { chat: model.chat, model: 'muse-spark-1.3', logDir: null, vote: true });
  await page.close();
  assert.equal(mapSchemaErrors(map), null);
  // "First name" has one strong candidate and is safe: never asked again.
  assert.ok(strongCandidates({ id: 'e2', kind: 'field', control: 'tel', label: 'Phone or mobile number' } as never).length > 1, 'phone or mobile is contested');
  assert.deepEqual(model.asked[0], ['e1', 'e2', 'e3', 'e4']);
  assert.ok(!model.asked[1]!.includes('e1') && model.asked[1]!.includes('e2') && model.asked[1]!.includes('e3'));
  assert.ok(!model.asked[2]!.includes('e1'));
  assert.equal(attempts.length, 3);
  // Two runs of three said mobile.
  assert.equal(map.fields.find((f) => f.id === 'e2')?.key, 'contact.mobile');
  assert.deepEqual(map.provenance.votes?.agreement.e2, { runs: 3, key: 2, risk: 3 });
  assert.deepEqual(map.provenance.votes?.agreement.e1, { runs: 1, key: 1, risk: 1 });
  assert.equal(votes?.runs, 3);
  assert.ok(votes!.disagreements >= 1);
});

test('ties: the stricter risk, and the short list\'s top candidate for the key', async () => {
  const page = await formPage();
  const model = scripted([
    { ...base, e2: { key: 'contact.mobile', risk: 'safe' } },
    { ...base, e2: { key: 'contact.phone', risk: 'consequential' } },
    // A third run that doesn't validate (a key on the wrong kind) doesn't vote.
    { ...base, e2: { key: 'form.submit', risk: 'safe' } },
  ]);
  const { map } = await compilePage(page, { chat: model.chat, model: 'muse-spark-1.3', logDir: null, vote: true });
  await page.close();
  const phone = map.fields.find((f) => f.id === 'e2')!;
  assert.equal(phone.risk, 'consequential', 'a risk tie takes the stricter');
  assert.equal(phone.key, strongCandidates({ id: 'e2', kind: 'field', control: 'tel', label: 'Phone or mobile number' } as never)[0], 'a key tie takes the short list\'s top candidate');
});

test('without vote mode: one run, no counts', async () => {
  const page = await formPage();
  const model = scripted([base]);
  const { map, votes } = await compilePage(page, { chat: model.chat, model: 'muse-spark-1.3', logDir: null });
  await page.close();
  assert.equal(model.asked.length, 1);
  assert.equal(votes, undefined);
  assert.equal(map.provenance.votes, undefined);
});
