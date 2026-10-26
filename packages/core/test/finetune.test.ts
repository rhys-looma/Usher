import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const script = (name: string) => fileURLToPath(new URL(`../scripts/${name}.ts`, import.meta.url));
const node = (name: string, args: string[]) => run(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', script(name), ...args]);

/** One logged labelling call, as the compiler writes it. */
function record(url: string, elements: object[], labels: object[], validation: object, model = 'muse-spark-1.3') {
  const extraction = { page: { path: new URL(url).pathname, title: 'Quote' }, groups: [], elements };
  return JSON.stringify({
    ts: '2026-10-26T10:00:00Z',
    model,
    url,
    request: { model, messages: [{ role: 'system', content: '…' }, { role: 'user', content: [{ type: 'text', text: `Label this form.\n\nExtraction:\n${JSON.stringify(extraction)}` }] }] },
    response: { choices: [{ message: { content: JSON.stringify({ form: { purpose: 'A quote', intent: 'quote.x' }, elements: labels, advance_action_id: null }) } }] },
    validation,
  });
}

test('finetune export: per element, risk floors applied, excluded skipped, de-duplicated, split by form; eval scores predictions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usher-finetune-'));
  try {
    const elements = [
      { id: 'e1', kind: 'field', control: 'text', label: 'First name', required: true, visible: true },
      { id: 'e2', kind: 'field', control: 'text', label: 'Hidden thing', required: false, visible: false },
      { id: 'e3', kind: 'action', control: 'submit', label: 'Get my quote', visible: true },
    ];
    const labels = [
      { id: 'e1', key: 'person.first_name', risk: 'safe', shown_if: null },
      { id: 'e2', key: 'custom.hidden', risk: 'safe', shown_if: null },
      { id: 'e3', key: 'form.submit', risk: 'safe', shown_if: null },
    ];
    const ok = { ok: true, errors: [], clamps: [{ id: 'e3', key: 'form.submit', labelled: 'safe', final: 'consequential', reason: 'key_default' }], excluded: [{ id: 'e2' }] };
    const log = [
      record('http://localhost:5001/quote/a', elements, labels, ok),
      // The same form on another port and run: duplicates.
      record('http://localhost:5002/quote/a', elements, labels, ok),
      record('https://shop.example/b', [{ id: 'e1', kind: 'field', control: 'email', label: 'Email', required: true, visible: true }], [{ id: 'e1', key: 'contact.email', risk: 'safe', shown_if: null }], { ok: true, errors: [], clamps: [], excluded: [] }),
      record('https://shop.example/c', elements, labels, { ok: false, errors: [{}], clamps: [], excluded: [] }),
      record('https://shop.example/d', elements, labels, ok, 'meta-models/muse-spark-open'),
      JSON.stringify({ task: 'classify', model: 'muse-spark-1.3', url: 'https://shop.example/e' }),
    ];
    await writeFile(join(dir, '2026-10-26.jsonl'), `${log.join('\n')}\n`);
    const out = join(dir, 'out');
    await node('finetune-export', ['--log', dir, '--out', out, '--eval-share', '0.3']);
    const stats = JSON.parse(await readFile(join(out, 'stats.json'), 'utf8'));
    assert.equal(stats.log_records, 4, 'labelling calls by the teacher only');
    assert.equal(stats.failed_validation, 1);
    assert.equal(stats.examples_before_dedup, 5);
    assert.equal(stats.unique, 3);
    assert.deepEqual([stats.train + stats.eval, stats.forms.train + stats.forms.eval], [3, 2]);

    const all = [...(await readFile(join(out, 'train.jsonl'), 'utf8')).split('\n'), ...(await readFile(join(out, 'eval.jsonl'), 'utf8')).split('\n')].filter(Boolean).map((l) => JSON.parse(l));
    const submit = all.find((e) => e.input.label === 'Get my quote');
    assert.deepEqual(submit.output, { key: 'form.submit', risk: 'consequential' }, 'the risk floor is applied');
    assert.deepEqual(submit.input.neighbours, { before: ['text: First name', 'text: Hidden thing'], after: [] });
    assert.ok(!all.some((e) => e.input.label === 'Hidden thing'), 'excluded elements are skipped');
    assert.equal(new Set(all.filter((e) => e.meta.source === 'mock-quote-site').map((e) => e.meta.form)).size, 1, 'ports don\'t split a form');
    const chat = JSON.parse((await readFile(join(out, 'train.chat.jsonl'), 'utf8')).split('\n')[0]!);
    assert.deepEqual(chat.messages.map((m: { role: string }) => m.role), ['system', 'user', 'assistant']);

    // Scoring: write predictions for the eval set, one of them under-calling risk.
    const evalSet = (await readFile(join(out, 'eval.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const preds = evalSet.map((e, i) => ({ id: e.id, key: e.output.key, risk: i === 0 && e.output.risk !== 'safe' ? 'safe' : e.output.risk }));
    await writeFile(join(dir, 'preds.jsonl'), preds.map((p) => JSON.stringify(p)).join('\n'));
    const { stdout } = await node('finetune-eval', ['--data', out, '--predictions', join(dir, 'preds.jsonl')]);
    assert.match(stdout, new RegExp(`Key correct \\| ${evalSet.length}/${evalSet.length}`));
    const underCalled = evalSet[0].output.risk !== 'safe' ? 1 : 0;
    assert.match(stdout, new RegExp(`Risk under-called \\(unsafe\\) \\| ${underCalled}`));
  } finally {
    await rm(dir, { recursive: true });
  }
});
