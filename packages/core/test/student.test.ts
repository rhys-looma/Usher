// The student (the tuned labeller) as the classifier's second opinion: its prompt is the one it was
// trained on, it is asked one element at a time, the stricter risk is kept, and its provider reads
// its endpoint from the environment. Offline: the student is a stand-in.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright';
import { classifyWithStudent, compilePage, modelApi, studentInput, studentModel, studentSystemPrompt, type ChatFn, type ChatRequest, type ExtractedElement } from '../src/index.ts';
import { systemPrompt } from '../scripts/finetune-shared.ts';
import { launch, openStep } from './helpers.ts';
import { readFixture, replayChat } from './replay.ts';

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser.close();
});

const box = { x: 0, y: 0, width: 1, height: 1 };
const els: ExtractedElement[] = [
  { id: 'e1', kind: 'field', tag: 'input', control: 'text', required: true, label: 'First name', labelSource: 'label-for', box, visible: true },
  { id: 'e2', kind: 'field', tag: 'select', control: 'select', required: true, label: 'Title', labelSource: 'label-for', box, visible: true, options: { items: [{ value: 'mr', label: 'Mr' }, { value: 'ms', label: 'Ms' }], total: 2, truncated: false } },
  { id: 'e3', kind: 'action', tag: 'button', control: 'submit', required: false, label: 'Send', labelSource: 'content', box, visible: true },
];
const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cached_tokens: 0 };

test('the served prompt is the trained prompt, and the input is the exported example\'s', async () => {
  assert.equal(studentSystemPrompt({ shortlist: true }), await systemPrompt({ shortlist: true }));
  const input = studentInput(els, 1, { purpose: 'Contact us', title: 'Contact' });
  assert.equal(input.options, '2 options: Mr, Ms');
  assert.deepEqual(input.neighbours, { before: ['text: First name'], after: ['submit: Send'] });
  assert.ok(input.candidates?.some((c) => c.startsWith('person.title:')));
});

test('one request per element; a reply without a valid risk is refused', async () => {
  const seen: ChatRequest[] = [];
  const student: ChatFn = async (r) => {
    seen.push(r);
    const input = JSON.parse(r.messages[1]!.content as string) as { label: string };
    return { content: JSON.stringify({ key: 'x.y', risk: input.label === 'Send' ? 'consequential' : 'safe' }), usage, latency_ms: 5, response: {} };
  };
  const c = await classifyWithStudent(student, 'usher-labeller', { purpose: 'Contact us', title: 'Contact' }, els);
  assert.equal(seen.length, 3);
  assert.ok(seen.every((r) => r.messages[0]!.content === studentSystemPrompt({ shortlist: true })));
  assert.deepEqual(c.opinions.map((o) => [o.id, o.risk]), [['e1', 'safe'], ['e2', 'safe'], ['e3', 'consequential']]);
  assert.equal(c.usage.total_tokens, 36);
  await assert.rejects(() => classifyWithStudent(async () => ({ content: '{"key":"a.b","risk":"low"}', usage, latency_ms: 1, response: {} }), 'm', { purpose: '', title: '' }, els), /no valid risk/);
});

test('in a compile, the student can only make a risk stricter', async () => {
  const labels = await readFixture('a', 'driver');
  const { context, page } = await openStep(browser, 'a', 'driver');
  // A student that calls every element needs_user, and one that calls everything safe.
  const strict: ChatFn = async () => ({ content: '{"key":"x.y","risk":"needs_user"}', usage, latency_ms: 1, response: {} });
  const lax: ChatFn = async () => ({ content: '{"key":"x.y","risk":"safe"}', usage, latency_ms: 1, response: {} });
  try {
    const base = await compilePage(page, { chat: replayChat(labels), model: labels.model, logDir: null });
    const raised = await compilePage(page, { chat: replayChat(labels), model: labels.model, logDir: null, classifier: { chat: strict, model: 'usher-labeller', student: true } });
    const lowered = await compilePage(page, { chat: replayChat(labels), model: labels.model, logDir: null, classifier: { chat: lax, model: 'usher-labeller', student: true } });
    const risks = (m: typeof base.map) => [...m.fields, ...m.actions].map((e) => e.risk);
    assert.ok(risks(raised.map).every((r) => r === 'needs_user'));
    assert.deepEqual(risks(lowered.map), risks(base.map), 'a lax student changes nothing');
    assert.ok(raised.classifier && !('error' in raised.classifier) && raised.classifier.flags.length > 0);
  } finally {
    await context.close();
  }
});

test('the student is off unless USHER_STUDENT_MODEL and its endpoint are set; its provider calls that endpoint', async () => {
  assert.equal(studentModel({}), null);
  assert.equal(studentModel({ USHER_STUDENT_MODEL: 'usher-labeller' }), null);
  assert.equal(studentModel({ USHER_STUDENT_MODEL: 'usher-labeller', USHER_STUDENT_URL: 'https://student.example' }), 'usher-labeller');
  const before = process.env.USHER_STUDENT_URL;
  process.env.USHER_STUDENT_URL = 'https://student.example/';
  try {
    let called = '';
    const chat = modelApi({ provider: 'student', apiKey: 'k', fetch: (async (url: string) => ((called = url), new Response(JSON.stringify({ choices: [{ message: { content: '{"key":"a.b","risk":"safe"}' } }] })))) as unknown as typeof fetch });
    await chat({ model: 'usher-labeller', temperature: 0, messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_schema', json_schema: { name: 'x', strict: true, schema: {} } } });
    assert.equal(called, 'https://student.example/v1/chat/completions');
  } finally {
    if (before === undefined) delete process.env.USHER_STUDENT_URL;
    else process.env.USHER_STUDENT_URL = before;
  }
});
