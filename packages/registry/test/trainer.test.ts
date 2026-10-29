// Automatic retraining (trainer.ts), against a stand-in for Baseten: when a run starts and when it
// waits, what the job is given and what it may fetch with its token, the eval gate, the monthly
// cap and the hard stop, and the routes the job and the student's deployment call.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleId, withCandidates, type CorrectionRecord, type TrainingExample } from '@usher/core';
import { startRegistry, type Storage } from '../src/index.ts';
import type { CheckpointFile, JobSpec, TrainingApi, TrainingJob } from '../src/baseten.ts';
import { Trainer, type TrainerOptions } from '../src/trainer.ts';
import { testStorage } from './storage-helper.ts';

class FakeBaseten implements TrainingApi {
  jobs: (TrainingJob & { spec: JobSpec })[] = [];
  restarts: string[] = [];
  stopped: string[] = [];
  async ensureProject(): Promise<string> {
    return 'proj1';
  }
  async createJob(_project: string, spec: JobSpec): Promise<TrainingJob> {
    const job = { id: `job${this.jobs.length + 1}`, current_status: 'TRAINING_JOB_CREATED', created_at: '', updated_at: '', spec };
    this.jobs.push(job);
    return job;
  }
  async getJob(_project: string, id: string): Promise<TrainingJob> {
    return this.jobs.find((j) => j.id === id)!;
  }
  async stopJob(_project: string, id: string): Promise<void> {
    this.stopped.push(id);
  }
  async checkpointFiles(_project: string, id: string): Promise<CheckpointFile[]> {
    return [
      { url: `https://bucket.example/${id}/adapter/adapter_model.safetensors`, relative_file_name: 'adapter/adapter_model.safetensors' },
      { url: `https://bucket.example/${id}/checkpoints/x`, relative_file_name: 'checkpoints/x' },
    ];
  }
  async restartDeployment(model: string): Promise<void> {
    this.restarts.push(model);
  }
  finish(status: string, minutes: number, startedAt: Date) {
    const job = this.jobs.at(-1)!;
    job.current_status = status;
    job.updated_at = new Date(startedAt.getTime() + minutes * 60_000).toISOString();
  }
}

function example(form: number, i: number): TrainingExample {
  const input = withCandidates({ label: `Question ${i} on form ${form}`, kind: 'field', control: 'text', required: true, options: null, constraints: null, form_purpose: 'a quote', page_title: `Form ${form}`, neighbours: { before: [], after: [] } });
  return { id: exampleId(input), input, output: { key: 'person.first_name', risk: 'safe' }, meta: { source: `site${form}.example`, path: '/', form: `site${form}.example/`, model: 'muse-spark-1.3' } };
}
const base = Array.from({ length: 10 }, (_, f) => Array.from({ length: 10 }, (_, i) => example(f, i))).flat();

function correction(ts: string, n: number): CorrectionRecord & { origin: string } {
  return {
    ts,
    task: 'correction',
    owner_verified: true,
    origin: 'https://owner.example',
    url: 'https://owner.example/quote',
    path: '/quote',
    page_title: 'Quote',
    form_purpose: 'a quote',
    element: { kind: 'field', control: 'radio', label: `Do you smoke? (${n})`, required: true, options: '2 options: Yes, No', constraints: null, neighbours: { before: ['text: Name'], after: [] } },
    owner: { key: 'health.smoker', risk: 'needs_user' },
  };
}

let dir: string;
let storage: Storage;
let api: FakeBaseten;
let clock: Date;
const files = async () => ({ train: '# train.py\n', requirements: 'torch==2.15.0\n' });
const trainer = (extra: Partial<TrainerOptions> = {}) => new Trainer({ storage, api, url: 'https://registry.example', files, studentModelId: 'model9', now: () => clock, ...extra });
const token = () => api.jobs.at(-1)!.spec.env.USHER_RUN_TOKEN!;
const runId = () => /\/training\/runs\/([^/]+)$/.exec(api.jobs.at(-1)!.spec.env.USHER_RUN_URL!)![1]!;
async function addCorrections(n: number, from = 0) {
  for (let i = 0; i < n; i++) await storage.appendLog('corrections', correction(new Date(clock.getTime() - 60_000 + i).toISOString(), from + i));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-trainer-'));
  storage = await testStorage(dir);
  api = new FakeBaseten();
  clock = new Date('2026-11-02T10:00:00Z');
});
afterEach(async () => {
  await storage.close?.().catch(() => undefined);
  await rm(dir, { recursive: true });
});

test('waits for enough new corrections, then for a base set', async () => {
  const t = trainer();
  await addCorrections(4);
  assert.match(await t.tick(), /waiting: 4 of 10 new owner corrections/);
  await addCorrections(6, 4);
  assert.match(await t.tick(), /no base set/);
  assert.equal(api.jobs.length, 0);
});

test('starts one H100 job with the base weights, a run URL and a token it keeps only hashed', async () => {
  const t = trainer();
  assert.equal(await t.setBase(base), 100);
  await addCorrections(10);
  assert.match(await t.tick(), /started run .* \(job job1\)/);
  const spec = api.jobs[0]!.spec;
  assert.deepEqual(spec.accelerator, { accelerator: 'H100', count: 1 });
  assert.deepEqual(spec.weights, [{ source: 'hf://meta-models/Muse-Glimmer-30B@main', mount: '/app/models/base' }]);
  assert.match(spec.env.USHER_RUN_URL!, /^https:\/\/registry\.example\/training\/runs\/\w+$/);
  assert.match(spec.env.USHER_BOOT!, /train\.py", "--baseten"/);
  const status = await t.status();
  assert.equal(status.runs[0]!.status, 'running');
  assert.equal(status.runs[0]!.data.corrections, 10);
  assert.ok(!JSON.stringify(await storage.getCached('training', 'state')).includes(token()), 'the token is stored hashed');
  // One at a time: the next check follows the running job.
  assert.match(await t.tick(), /TRAINING_JOB_CREATED/);
  assert.equal(api.jobs.length, 1);
});

test('the job fetches its files with its token only; the data has owners\' answers and no values', async () => {
  const t = trainer();
  await t.setBase(base);
  await addCorrections(10);
  await t.tick();
  assert.equal(await t.file(runId(), 'wrong', 'train.py'), null);
  assert.equal(await t.file(runId(), token(), 'train.py'), '# train.py\n');
  assert.equal(await t.file(runId(), token(), '../etc/passwd'), null);
  const rows = [(await t.file(runId(), token(), 'train.chat.jsonl'))!, (await t.file(runId(), token(), 'eval.chat.jsonl'))!].join('').trim().split('\n').map((l) => JSON.parse(l) as { messages: { role: string; content: string }[] });
  assert.equal(rows.length, 110);
  const owner = rows.filter((r) => r.messages[2]!.content.includes('health.smoker'));
  assert.equal(owner.length, 10);
  assert.deepEqual(JSON.parse(owner[0]!.messages[2]!.content), { key: 'health.smoker', risk: 'needs_user' });
  assert.equal(await t.previousAdapter(runId(), token()).then((f) => f?.length), 0, 'no adapter serving yet');
});

test('a first run that clears the bar is promoted, the deployment restarted, its files withdrawn', async () => {
  const t = trainer();
  await t.setBase(base);
  await addCorrections(10);
  const started = clock;
  await t.tick();
  const id = runId();
  const tok = token();
  assert.equal(await t.report(id, 'wrong', { new: { examples: 20, key: 0.8, risk: 0.9, valid: 1 }, previous: null }), false);
  assert.equal(await t.report(id, tok, { new: { examples: 20, key: 2, risk: 0.9, valid: 1 }, previous: null }), false, 'shares are 0 to 1');
  assert.equal(await t.report(id, tok, { new: { examples: 20, key: 0.8, risk: 0.9, valid: 1 }, previous: null, train_loss: 0.4 }), true);
  assert.equal(t.hasStudent(), false);
  api.finish('TRAINING_JOB_COMPLETED', 30, started);
  clock = new Date(started.getTime() + 40 * 60_000);
  assert.match(await t.tick(), /promoted: key 80%, risk 90%/);
  assert.equal(t.hasStudent(), true);
  assert.deepEqual(api.restarts, ['model9']);
  const status = await t.status();
  assert.equal(status.promoted, id);
  assert.equal(status.runs[0]!.cost_usd, 3.25, '30 minutes at $0.10833');
  assert.equal(await t.file(id, tok, 'train.py'), null, 'a finished run\'s token no longer works');
  const promoted = await t.promotedAdapter();
  assert.deepEqual(promoted.files.map((f) => f.relative_file_name), ['adapter/adapter_model.safetensors']);
});

test('a later run worse than the adapter serving is rejected and the student stays; cooldown and the cap hold', async () => {
  const t = trainer({ monthlyCapUsd: 8 });
  await t.setBase(base);
  await addCorrections(10);
  let started = clock;
  await t.tick();
  const first = runId();
  await t.report(first, token(), { new: { examples: 20, key: 0.8, risk: 0.9, valid: 1 }, previous: null });
  api.finish('TRAINING_JOB_COMPLETED', 30, started);
  await t.tick();

  clock = new Date(clock.getTime() + 3600_000);
  await addCorrections(10, 100);
  assert.match(await t.tick(), /under 24 hours ago/);
  clock = new Date(clock.getTime() + 24 * 3600_000);
  started = clock;
  assert.match(await t.tick(), /started run/);
  const second = runId();
  const previous = await t.previousAdapter(second, token());
  assert.equal(previous?.[0]?.url, 'https://bucket.example/job1/adapter/adapter_model.safetensors', 'scored against the serving adapter');
  await t.report(second, token(), { new: { examples: 22, key: 0.85, risk: 0.88, valid: 1 }, previous: { examples: 22, key: 0.8, risk: 0.9, valid: 1 } });
  api.finish('TRAINING_JOB_COMPLETED', 30, started);
  assert.match(await t.tick(), /rejected: worse than the adapter serving/);
  assert.equal((await t.status()).promoted, first);
  assert.deepEqual(api.restarts, ['model9']);

  // $6.50 spent of $8: another run (estimated at the last one's $3.25) would pass the cap.
  clock = new Date(clock.getTime() + 25 * 3600_000);
  await addCorrections(10, 200);
  assert.match(await t.tick(), /a run would pass the \$8 cap/);
});

test('a job still going after the limit is stopped; a failed job\'s corrections count again', async () => {
  const t = trainer({ maxRunMinutes: 90 });
  await t.setBase(base);
  await addCorrections(10);
  await t.tick();
  api.jobs[0]!.current_status = 'TRAINING_JOB_RUNNING';
  clock = new Date(clock.getTime() + 60 * 60_000);
  assert.match(await t.tick(), /TRAINING_JOB_RUNNING/);
  clock = new Date(clock.getTime() + 31 * 60_000);
  assert.match(await t.tick(), /failed: stopped after 90 minutes/);
  assert.deepEqual(api.stopped, ['job1']);
  assert.equal((await t.status()).pending_corrections, 10);
});

test('routes: the job\'s calls need its token, the deployment\'s the secret, the base set the admin key', async () => {
  const t = trainer();
  const running = await startRegistry({ storage, siteScript: fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url)), web: { allowPrivate: true, adminKey: 'admin-key-for-tests', training: { trainer: t, secret: 'deploy-secret' } } });
  try {
    const admin = { Authorization: 'Bearer admin-key-for-tests', 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${running.url}/admin/training/base`, { method: 'POST', body: JSON.stringify({ examples: base }) })).status, 401);
    const upload = await fetch(`${running.url}/admin/training/base`, { method: 'POST', headers: admin, body: JSON.stringify({ examples: base }) });
    assert.deepEqual(await upload.json(), { stored: 100 });
    await addCorrections(10);
    const check = (await (await fetch(`${running.url}/admin/training/check`, { method: 'POST', headers: admin })).json()) as { what: string };
    assert.match(check.what, /started run/);
    const runUrl = `${running.url}/training/runs/${runId()}`;
    assert.equal((await fetch(`${runUrl}/files/train.py`)).status, 404);
    const got = await fetch(`${runUrl}/files/train.py`, { headers: { Authorization: `Bearer ${token()}` } });
    assert.equal(await got.text(), '# train.py\n');
    const posted = await fetch(`${runUrl}/result`, { method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: JSON.stringify({ new: { examples: 20, key: 0.7, risk: 0.9, valid: 0.95 }, previous: null }) });
    assert.equal(posted.status, 200);
    assert.equal((await fetch(`${running.url}/training/student`)).status, 404);
    const student = await fetch(`${running.url}/training/student`, { headers: { Authorization: 'Bearer deploy-secret' } });
    assert.deepEqual(await student.json(), { run: null, files: [] });
    const status = (await (await fetch(`${running.url}/admin/training`, { headers: admin })).json()) as { runs: { status: string; token?: string }[] };
    assert.equal(status.runs[0]!.status, 'running');
    assert.equal(status.runs[0]!.token, undefined, 'the status never shows the token hash');
  } finally {
    await running.close();
  }
});

test('/learning says the student is serving once a run is promoted, with its held-out scores', async () => {
  const t = trainer();
  await t.setBase(base);
  await addCorrections(10);
  const started = clock;
  await t.tick();
  await t.report(runId(), token(), { new: { examples: 20, key: 0.82, risk: 0.91, valid: 1 }, previous: null });
  api.finish('TRAINING_JOB_COMPLETED', 30, started);
  await t.tick();
  const running = await startRegistry({ storage, siteScript: fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url)), web: { allowPrivate: true } });
  try {
    const text = await (await fetch(`${running.url}/learning`)).text();
    assert.match(text, /<b>Serving<\/b>/);
    assert.match(text, /agrees on 82% of keys and 91% of risks/);
  } finally {
    await running.close();
  }
});
