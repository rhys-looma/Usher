import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_URL, OPEN_MODEL, compilerModel, costUsd, labelsSchema, modelApi, openModel, parseJsonContent, redactRequest, requestHash, type ChatRequest, type ExtractedForm } from '../src/index.ts';

const request: ChatRequest = {
  model: 'muse-spark-1.3',
  temperature: 0,
  messages: [
    { role: 'system', content: 'system' },
    { role: 'user', content: [{ type: 'text', text: 'label this' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('fake png').toString('base64')}` } }] },
  ],
  response_format: { type: 'json_schema', json_schema: { name: 'usher_labels', strict: true, schema: { type: 'object' } } },
};

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, statusText: status === 200 ? 'OK' : 'Bad Request' });
  }) as typeof fetch;
}

test('model API: bearer key from the environment, request as given, usage parsed', async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  const chat = modelApi({
    apiKey: 'sk-test-123',
    fetch: fakeFetch(200, { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } } }, seen),
  });
  const result = await chat(request);
  assert.equal(result.content, '{"ok":true}');
  assert.deepEqual(result.usage, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 40 });
  assert.equal(seen[0]!.url, API_URL);
  assert.equal((seen[0]!.init!.headers as Record<string, string>).Authorization, 'Bearer sk-test-123');
  assert.deepEqual(JSON.parse(seen[0]!.init!.body as string), request);
});

test('model API: missing key fails clearly; errors never include the key', async () => {
  const saved = process.env.MODEL_API_KEY;
  delete process.env.MODEL_API_KEY;
  try {
    assert.throws(() => modelApi(), /MODEL_API_KEY is not set/);
  } finally {
    if (saved !== undefined) process.env.MODEL_API_KEY = saved;
  }
  const chat = modelApi({ apiKey: 'sk-secret-456', fetch: fakeFetch(400, { error: { message: 'bad schema' } }) });
  await assert.rejects(() => chat(request), (err: Error) => /400/.test(err.message) && /bad schema/.test(err.message) && !err.message.includes('sk-secret-456'));
  const empty = modelApi({ apiKey: 'k', fetch: fakeFetch(200, { choices: [] }) });
  await assert.rejects(() => empty(request), /no message content/);
});

test('contributor variants are refused', async () => {
  assert.equal(compilerModel({}), 'muse-spark-1.3');
  assert.equal(compilerModel({ USHER_COMPILER_MODEL: 'muse-spark-1.2' }), 'muse-spark-1.2');
  assert.throws(() => compilerModel({ USHER_COMPILER_MODEL: 'muse-spark-1.3-contributor' }), /train on our content/);
  const chat = modelApi({ apiKey: 'k', fetch: fakeFetch(200, {}) });
  await assert.rejects(() => chat({ ...request, model: 'muse-spark-1.3-contributor' }), /train on our content/);
});

test('cost from the published per-million-token prices', () => {
  assert.equal(costUsd('muse-spark-1.3', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000, cached_tokens: 0 }), 1.25 + 4.25);
  assert.equal(costUsd('muse-spark-1.3', { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000, cached_tokens: 1_000_000 }), 0.15);
  assert.equal(costUsd('some-other-model', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_tokens: 0 }), null);
});

test('log redaction drops image bytes; the fixture hash ignores the screenshot', () => {
  const redacted = JSON.stringify(redactRequest(request));
  assert.ok(!redacted.includes(Buffer.from('fake png').toString('base64')));
  assert.match(redacted, /\[image omitted: image\/png, 8 bytes, sha256:[0-9a-f]{64}\]/);
  const otherImage = structuredClone(request);
  (otherImage.messages[1]!.content as { image_url?: { url: string } }[])[1]!.image_url!.url = 'data:image/png;base64,AAAA';
  assert.equal(requestHash(otherImage), requestHash(request));
  assert.notEqual(requestHash({ ...request, temperature: 1 }), requestHash(request));
});

// Checks the strict structured-output subset: object root without combinators, every object
// closed with all properties required, no oneOf/allOf anywhere.
function assertStrictSubset(schema: Record<string, unknown>): void {
  assert.equal(schema.type, 'object');
  for (const k of ['anyOf', 'oneOf', 'allOf', 'enum', 'not']) assert.ok(!(k in schema), `root has ${k}`);
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
    if (typeof node !== 'object' || node === null) return;
    const n = node as Record<string, unknown>;
    assert.ok(!('oneOf' in n) && !('allOf' in n), `${path} uses oneOf/allOf`);
    if (n.type === 'object') {
      assert.equal(n.additionalProperties, false, `${path} is not closed`);
      assert.deepEqual([...(n.required as string[])].sort(), Object.keys(n.properties as object).sort(), `${path} does not require every property`);
    }
    if (Array.isArray(n.enum)) assert.ok(n.enum.length > 0, `${path} has an empty enum`);
    for (const [k, v] of Object.entries(n)) walk(v, `${path}.${k}`);
  };
  walk(schema, '$');
}

const box = { x: 0, y: 0, width: 10, height: 10 };
const form: ExtractedForm = {
  index: 0,
  pseudo: false,
  banner: false,
  groups: [],
  elements: [
    { id: 'e1', kind: 'field', tag: 'input', control: 'text', required: true, label: 'Name', labelSource: 'label-for', box, visible: true },
    { id: 'e2', kind: 'field', tag: 'select', control: 'select', required: true, label: 'Size', labelSource: 'label-for', box, visible: true, options: { items: [{ value: 's', label: 'Small' }], total: 1, truncated: false } },
    { id: 'e3', kind: 'action', tag: 'button', control: 'submit', required: false, label: 'Send', labelSource: 'content', box, visible: true },
  ],
};

test('labels schema follows the strict subset, with enums from this page', () => {
  const schema = labelsSchema(form) as any;
  assertStrictSubset(schema);
  assert.deepEqual(schema.properties.elements.items.properties.id.enum, ['e1', 'e2', 'e3']);
  assert.deepEqual(schema.properties.elements.items.properties.risk.enum, ['safe', 'consequential', 'needs_user']);
  assert.equal(schema.properties.elements.items.properties.key.type, 'string');
  const condition = schema.properties.elements.items.properties.shown_if.anyOf[0];
  assert.deepEqual(condition.properties.field_id.enum, ['e1', 'e2']);
  assert.deepEqual(condition.properties.op.enum, ['equals', 'not_equals', 'in', 'checked', 'filled']);
  assert.deepEqual(schema.properties.advance_action_id.anyOf[0].enum, ['e3']);

  // No actions or fields: the nullable parts collapse to null rather than an empty enum.
  const actionsOnly = labelsSchema({ ...form, elements: [form.elements[2]!] }) as any;
  assertStrictSubset(actionsOnly);
  assert.deepEqual(actionsOnly.properties.elements.items.properties.shown_if, { type: 'null' });
  const fieldsOnly = labelsSchema({ ...form, elements: form.elements.slice(0, 2) }) as any;
  assertStrictSubset(fieldsOnly);
  assert.deepEqual(fieldsOnly.properties.advance_action_id, { type: 'null' });
});

test('Baseten (Muse Spark Open): no structured output, so the schema goes in the system prompt', async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  const chat = modelApi({ provider: 'baseten', apiKey: 'bt-test', fetch: fakeFetch(200, { choices: [{ message: { content: '```json\n{"ok":true}\n```' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }, seen) });
  const result = await chat({ ...request, model: OPEN_MODEL });
  assert.equal(seen[0]!.url, 'https://inference.baseten.co/v1/chat/completions');
  assert.equal((seen[0]!.init!.headers as Record<string, string>).Authorization, 'Bearer bt-test');
  const sent = JSON.parse(seen[0]!.init!.body as string);
  assert.deepEqual(sent.response_format, { type: 'json_object' }, 'JSON mode, no json_schema');
  assert.equal(sent.model, 'meta-models/muse-spark-open-1026');
  assert.match(sent.messages[0].content, /^system\n\n## Output format\nReply with one JSON object and nothing else/);
  assert.match(sent.messages[0].content, /"type":"object"/);
  assert.deepEqual(sent.messages[1], request.messages[1], 'the user message and screenshot are unchanged');
  assert.deepEqual(parseJsonContent(result.content), { ok: true });

  const saved = process.env.BASETEN_API_KEY;
  delete process.env.BASETEN_API_KEY;
  try {
    assert.throws(() => modelApi({ provider: 'baseten' }), /BASETEN_API_KEY is not set/);
  } finally {
    if (saved !== undefined) process.env.BASETEN_API_KEY = saved;
  }
  assert.equal(openModel({}), 'meta-models/muse-spark-open-1026', 'the hackathon id');
  assert.equal(openModel({ USHER_OPEN_MODEL: 'meta-models/muse-spark-open' }), 'meta-models/muse-spark-open');
  const missing = modelApi({ provider: 'baseten', apiKey: 'k', fetch: fakeFetch(404, { error: 'please check the model you provided' }) });
  await assert.rejects(() => missing({ ...request, model: OPEN_MODEL }), /set USHER_OPEN_MODEL=meta-models\/muse-spark-open\)/);
  assert.throws(() => openModel({ USHER_OPEN_MODEL: 'muse-spark-1.3-contributor' }), /train on our content/);
});

test('model replies are parsed leniently: fences and prose around one JSON object', () => {
  assert.deepEqual(parseJsonContent('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonContent('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonContent('Here are the labels:\n{"a":{"b":2}}\nDone.'), { a: { b: 2 } });
  assert.throws(() => parseJsonContent('no json here'), SyntaxError);
});
