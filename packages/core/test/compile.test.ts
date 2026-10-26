import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { CompileError, compilePage, type ChatFn, type ChatRequest, type UsherMap } from '../src/index.ts';
import { LAYOUTS, STEPS, launch, openStep, type Layout, type Step } from './helpers.ts';
import { mapSchemaErrors } from '../src/schemas.ts';
import { readFixture, replayChat } from './replay.ts';

const expectedKeys: Record<Layout, Record<Step, [string, string][]>> = JSON.parse(
  await readFile(new URL('./fixtures/expected-keys.json', import.meta.url), 'utf8'),
);

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser.close();
});

async function compileStep(layout: Layout, step: Step, chat: ChatFn, logDir: string | null = null, model = 'muse-spark-1.3') {
  const { context, page } = await openStep(browser, layout, step);
  try {
    return await compilePage(page, { chat, model, logDir });
  } finally {
    await context.close();
  }
}

function byLabel(map: UsherMap, label: string) {
  const found = [...map.fields, ...map.actions].find((e) => e.label === label);
  assert.ok(found, `no element labelled "${label}"`);
  return found;
}

for (const [set, model] of [['labels', 'Muse Spark'], ['labels-open', 'Muse Spark Open']] as const) {
for (const layout of LAYOUTS) {
  for (const step of STEPS) {
    test(`${model}, layout ${layout.toUpperCase()} ${step}: compiled map validates and has the expected keys`, async () => {
      const fixture = await readFixture(layout, step, set);
      const { map, attempts } = await compileStep(layout, step, replayChat(fixture), null, fixture.model);
      assert.equal(attempts.length, fixture.attempts.length);
      assert.equal(mapSchemaErrors(map), null);
      assert.equal(map.form.intent, 'quote.car_insurance');
      assert.equal(map.path, `/quote/${step}`);
      assert.equal(map.provenance.compiler, fixture.model);
      assert.deepEqual(
        [...map.fields, ...map.actions].sort((x, y) => Number(x.id.slice(1)) - Number(y.id.slice(1))).map((e) => [e.label, e.key]),
        expectedKeys[layout][step],
      );

      const advance = layout === 'a' ? 'Continue' : 'Next';
      if (step === 'driver') {
        for (const label of ['Date of the claim', 'Type of claim']) {
          assert.deepEqual((byLabel(map, label) as { shown_if?: unknown }).shown_if, { field: 'person.claims.has_any', op: 'equals', value: 'yes' }, label);
        }
      }
      if (step === 'cover') {
        const declaration = byLabel(map, 'I confirm the information I have given is true and complete');
        assert.deepEqual([declaration.key, declaration.risk], ['consent.declaration', 'needs_user']);
        const submit = byLabel(map, 'Get my quote');
        assert.deepEqual([submit.key, submit.risk], ['form.submit', 'consequential']);
      } else {
        const next = byLabel(map, advance);
        assert.deepEqual([next.key, next.risk], ['nav.next', 'safe']);
      }
    });
  }
}
}

// A scripted model: returns the given contents in turn and keeps the requests it saw.
function scripted(contents: string[]): { chat: ChatFn; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const chat: ChatFn = async (request) => {
    requests.push(request);
    const content = contents[requests.length - 1];
    if (content === undefined) throw new Error('scripted model ran out of responses');
    return { content, usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, cached_tokens: 0 }, latency_ms: 50, response: { id: 'scripted' } };
  };
  return { chat, requests };
}

async function goodCover(layout: Layout = 'a') {
  return JSON.parse((await readFixture(layout, 'cover')).attempts.at(-1)!.content);
}

test('validation errors are sent back once; the retry\'s labels are used, clamps reported', async () => {
  const good = await goodCover();
  const bad = structuredClone(good);
  bad.elements[0].key = 'policy.start';
  bad.elements[0].locators = [{ by: 'css', value: '#start-date' }];
  // Risk below the key default is clamped, not an error.
  const softened = structuredClone(good);
  softened.elements.find((e: { key: string }) => e.key === 'form.submit').risk = 'safe';

  const logDir = await mkdtemp(join(tmpdir(), 'usher-log-'));
  const { chat, requests } = scripted([JSON.stringify(bad), JSON.stringify(softened)]);
  const result = await compileStep('a', 'cover', chat, logDir);

  assert.equal(result.attempts.length, 2);
  assert.deepEqual(result.attempts[0]!.errors.map((e) => e.code).sort(), ['unknown_key', 'unknown_property']);
  assert.deepEqual(result.attempts[1]!.errors, []);
  assert.deepEqual(result.clamps.map((c) => [c.key, c.labelled, c.final]), [['form.submit', 'safe', 'consequential']]);
  assert.equal(byLabel(result.map, 'Get my quote').risk, 'consequential');
  assert.equal(result.usage.prompt_tokens, 2000);
  assert.equal(result.cost_usd, (2 * (1000 * 1.25 + 200 * 4.25)) / 1e6);

  // The retry carries the first answer and the errors.
  const retry = requests[1]!.messages;
  assert.equal(retry.length, 4);
  assert.equal(retry[2]!.role, 'assistant');
  assert.equal(retry[2]!.content, JSON.stringify(bad));
  assert.match(retry[3]!.content as string, /unknown_key/);
  assert.match(retry[3]!.content as string, /elements\[0\]\.locators/);

  // Both attempts are logged, without image bytes.
  const files = await readdir(logDir);
  const lines = (await readFile(join(logDir, files[0]!), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  await rm(logDir, { recursive: true });
  assert.deepEqual(lines.map((l) => [l.attempt, l.validation.ok]), [[1, false], [2, true]]);
  for (const line of lines) {
    const text = JSON.stringify(line);
    assert.ok(!text.includes('base64,'), 'no image bytes in the log');
    assert.match(text, /\[image omitted: image\/png, \d+ bytes, sha256:[0-9a-f]{64}\]/);
    assert.deepEqual(Object.keys(line.usage), ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens']);
    assert.equal(typeof line.latency_ms, 'number');
    assert.equal(line.request.temperature, 0);
  }
});

test('labels that still fail after the retry fail loudly', async () => {
  const { chat } = scripted(['{"form":', JSON.stringify({ form: { purpose: 'x', intent: 'x' }, elements: [], advance_action_id: null })]);
  await assert.rejects(
    () => compileStep('a', 'cover', chat),
    (err: unknown) => {
      assert.ok(err instanceof CompileError);
      assert.equal(err.attempts.length, 2);
      assert.equal(err.attempts[0]!.errors[0]!.code, 'invalid_json');
      assert.ok(err.errors.some((e) => e.code === 'missing_label'));
      assert.match(err.message, /failed validation after 2 attempts/);
      return true;
    },
  );
});

test('the request: strict schema built from this page, temperature 0, screenshot as a PNG data URL', async () => {
  const { chat, requests } = scripted([JSON.stringify(await goodCover('b'))]);
  await compileStep('b', 'cover', chat);
  const request = requests[0]!;
  assert.equal(request.model, 'muse-spark-1.3');
  assert.equal(request.temperature, 0);
  assert.equal(request.response_format.type, 'json_schema');
  assert.equal(request.response_format.json_schema.name, 'usher_labels');
  assert.equal(request.response_format.json_schema.strict, true);
  const schema = request.response_format.json_schema.schema as any;
  assert.deepEqual(schema.properties.elements.items.properties.id.enum, ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']);
  assert.deepEqual(schema.properties.advance_action_id.anyOf[0].enum, ['e8', 'e9']);

  const [system, user] = request.messages;
  assert.equal(system!.role, 'system');
  assert.match(system!.content as string, /\| consent\.declaration \| field \| needs_user \|/);
  assert.match(system!.content as string, /never output selectors/i);
  const parts = user!.content as { type: string; text?: string; image_url?: { url: string } }[];
  const png = Buffer.from(parts[1]!.image_url!.url.replace(/^data:image\/png;base64,/, ''), 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1280, 'screenshot is 1280px wide');
  // The model sees labels and structure, never locators or page ids.
  assert.ok(!parts[0]!.text!.includes('locators'));
  assert.ok(!parts[0]!.text!.includes('fld-'));
});
