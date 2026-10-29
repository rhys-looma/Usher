// Automatic retraining of the student (docs/finetune.md, "Automatic retraining"), on when
// USHER_AUTO_TRAIN=1. Once an hour the registry counts owners' corrections made since the last
// run. When there are enough, the last run was long enough ago and the month's GPU spend leaves
// room, it builds the training set (the base set plus every correction, owners' answers winning),
// and starts a LoRA job on one Baseten H100. The job fetches train.py and its data from this
// registry with a token that is good for that run only, trains, scores the new adapter and the one
// serving now on the same held-out examples, and posts the scores back. The new adapter is promoted
// only if it is no worse; the student's deployment is then restarted so it loads it.
//
// Structure only goes to Baseten: labels, options and neighbouring labels, never anything typed.
// One run at a time, a hard stop on run length, and a monthly cap on GPU spend.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chatRow, correctionExample, dedupeExamples, isOwnerVerified, splitByForm, type CorrectionRecord, type TrainingExample } from '@usher/core';
import { FINISHED, type CheckpointFile, type TrainingApi } from './baseten.ts';
import type { Storage } from './storage.ts';

export interface Scores {
  examples: number;
  key: number;
  risk: number;
  valid: number;
}

export interface RunResult {
  new: Scores;
  /** The adapter serving when the run started, on the same examples; null for the first run. */
  previous: Scores | null;
  train_loss?: number;
  steps?: number;
}

export interface TrainingRun {
  id: string;
  job?: string;
  started_at: string;
  finished_at?: string;
  status: 'running' | 'promoted' | 'rejected' | 'failed';
  /** The newest correction in this run's set: later ones count towards the next run. */
  through: string | null;
  data: { train: number; eval: number; owner_verified: number; corrections: number };
  /** The run's token, hashed. The job sends it to fetch its files and post its scores. */
  token: string;
  /** The adapter serving when this run started, which the job scores against. */
  previous: string | null;
  result?: RunResult;
  cost_usd?: number;
  reason?: string;
}

interface TrainingState {
  runs: TrainingRun[];
  /** The run whose adapter the student serves. */
  promoted: string | null;
}

export interface TrainerOptions {
  storage: Storage;
  api: TrainingApi;
  /** This registry's public URL: the job calls back to it. */
  url: string;
  /** deploy/finetune/train.py and requirements.txt, sent to the job. */
  files: () => Promise<{ train: string; requirements: string }>;
  /** The Baseten model serving the student (deploy/baseten/student), restarted on promotion. */
  studentModelId?: string;
  project?: string;
  now?: () => Date;
  intervalMinutes?: number;
  /** New owner corrections needed before a run (default 10). */
  minCorrections?: number;
  /** Hours between run starts (default 24). */
  cooldownHours?: number;
  /** GPU spend allowed per UTC month, in dollars (default 40). */
  monthlyCapUsd?: number;
  /** Baseten's H100 rate (default $0.10833 a minute). */
  usdPerMinute?: number;
  /** A run still going after this is stopped (default 120). */
  maxRunMinutes?: number;
  evalShare?: number;
  /** The first run has nothing to beat, so it must reach these shares of the held-out examples. */
  firstRun?: { key: number; risk: number };
  /** Every run must give valid JSON this often (default 0.9). */
  minValid?: number;
  image?: string;
  baseWeights?: string;
}

const STATE = ['training', 'state'] as const;
const BASE = ['training', 'base'] as const;
const sha256 = (s: string) => createHash('sha256').update(s).digest();
// The job's first step: fetch train.py, its requirements and the data, install, run. Sent as an
// environment variable so the start command needs no quoting of its own.
const BOOT = `import os, subprocess, sys, urllib.request
os.makedirs("/tmp/usher", exist_ok=True)
os.chdir("/tmp/usher")
for name in ["train.py", "requirements.txt", "train.chat.jsonl", "eval.chat.jsonl"]:
    request = urllib.request.Request(os.environ["USHER_RUN_URL"] + "/files/" + name, headers={"Authorization": "Bearer " + os.environ["USHER_RUN_TOKEN"]})
    with urllib.request.urlopen(request, timeout=300) as response, open(name, "wb") as out:
        out.write(response.read())
subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "-r", "requirements.txt"])
os.execv(sys.executable, [sys.executable, "train.py", "--baseten"])
`;

export class Trainer {
  private busy?: Promise<string>;
  private timer?: NodeJS.Timeout;
  private promotedCache: string | null = null;
  private projectId?: string;
  private readonly o: Required<Omit<TrainerOptions, 'studentModelId'>> & Pick<TrainerOptions, 'studentModelId'>;

  constructor(options: TrainerOptions) {
    this.o = {
      project: 'usher-student',
      now: () => new Date(),
      intervalMinutes: 60,
      minCorrections: 10,
      cooldownHours: 24,
      monthlyCapUsd: 40,
      usdPerMinute: 0.10833,
      maxRunMinutes: 120,
      evalShare: 0.2,
      firstRun: { key: 0.6, risk: 0.8 },
      minValid: 0.9,
      image: 'python:3.11-slim',
      baseWeights: 'hf://meta-models/Muse-Glimmer-30B@main',
      ...options,
    };
  }

  /** Checks once an hour (the first a minute after start). */
  start(): void {
    void this.refresh().catch(() => undefined);
    const tick = () => void this.tick().then((what) => console.log(JSON.stringify({ event: 'training_check', what })), (err: unknown) => console.error(JSON.stringify({ event: 'training_check', error: err instanceof Error ? err.message : String(err) })));
    setTimeout(tick, 60_000).unref();
    this.timer = setInterval(tick, this.o.intervalMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Whether a promoted adapter is serving: until one is, the student isn't asked. */
  hasStudent(): boolean {
    return this.promotedCache !== null;
  }

  private async state(): Promise<TrainingState> {
    return (await this.o.storage.getCached<TrainingState>(...STATE)) ?? { runs: [], promoted: null };
  }

  private async save(state: TrainingState): Promise<void> {
    await this.o.storage.putCached(...STATE, state);
    this.promotedCache = state.promoted;
  }

  private async refresh(): Promise<void> {
    this.promotedCache = (await this.state()).promoted;
  }

  /** The base set (the export's examples from the compiler log), replaced whole. */
  async setBase(examples: TrainingExample[]): Promise<number> {
    const valid = examples.filter((ex) => typeof ex?.id === 'string' && ex.input && typeof ex.output?.key === 'string' && typeof ex.output?.risk === 'string' && typeof ex.meta?.form === 'string');
    await this.o.storage.putCached(...BASE, valid);
    return valid.length;
  }

  private month(at: Date): string {
    return at.toISOString().slice(0, 7);
  }

  private spentThisMonth(state: TrainingState): number {
    const month = this.month(this.o.now());
    return state.runs.filter((r) => r.started_at.startsWith(month)).reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  }

  /** Corrections after the last run that used its set (a failed run's corrections count again). */
  private async pending(state: TrainingState): Promise<{ all: CorrectionRecord[]; fresh: number; latest: string | null }> {
    const all = (await this.o.storage.readLog('corrections')) as CorrectionRecord[];
    const used = state.runs.filter((r) => r.status === 'promoted' || r.status === 'rejected').at(-1)?.through ?? null;
    const fresh = all.filter((c) => typeof c.ts === 'string' && (used === null || c.ts > used));
    const latest = all.reduce<string | null>((m, c) => (typeof c.ts === 'string' && (m === null || c.ts > m) ? c.ts : m), null);
    return { all, fresh: fresh.length, latest };
  }

  /** What /admin/training shows. */
  async status(): Promise<{ runs: Omit<TrainingRun, 'token'>[]; promoted: string | null; pending_corrections: number; spent_this_month_usd: number; cap_usd: number; base_examples: number }> {
    const state = await this.state();
    const base = (await this.o.storage.getCached<TrainingExample[]>(...BASE)) ?? [];
    return {
      runs: state.runs.map(({ token: _t, ...r }) => r).reverse(),
      promoted: state.promoted,
      pending_corrections: (await this.pending(state)).fresh,
      spent_this_month_usd: Math.round(this.spentThisMonth(state) * 100) / 100,
      cap_usd: this.o.monthlyCapUsd,
      base_examples: base.length,
    };
  }

  /** One check: follow a running job, or start one if it is time. One at a time. Says what it did. */
  tick(): Promise<string> {
    this.busy ??= this.check().finally(() => (this.busy = undefined));
    return this.busy;
  }

  private async check(): Promise<string> {
    const state = await this.state();
    const active = state.runs.find((r) => r.status === 'running');
    if (active) return this.follow(state, active);

    const now = this.o.now();
    const { all, fresh, latest } = await this.pending(state);
    if (fresh < this.o.minCorrections) return `waiting: ${fresh} of ${this.o.minCorrections} new owner corrections`;
    const last = state.runs.at(-1);
    if (last && now.getTime() - Date.parse(last.started_at) < this.o.cooldownHours * 3600_000) return `waiting: the last run started under ${this.o.cooldownHours} hours ago`;
    // The next run is budgeted at the last finished run's cost, or 45 minutes before there is one.
    const estimate = state.runs.filter((r) => r.cost_usd).at(-1)?.cost_usd ?? 45 * this.o.usdPerMinute;
    const spent = this.spentThisMonth(state);
    if (spent + estimate > this.o.monthlyCapUsd) return `waiting: $${spent.toFixed(2)} spent this month, a run would pass the $${this.o.monthlyCapUsd} cap`;
    const base = (await this.o.storage.getCached<TrainingExample[]>(...BASE)) ?? [];
    if (!base.length) return 'waiting: no base set (npm run training:upload-base)';

    const corrections = all.map(correctionExample).filter((ex): ex is TrainingExample => ex !== null);
    const { unique } = dedupeExamples([...base, ...corrections]);
    const split = splitByForm(unique, this.o.evalShare);
    if (split.train.length < 50 || split.eval.length < 10) return `waiting: too few examples (${split.train.length} train, ${split.eval.length} eval)`;

    const id = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const token = randomBytes(32).toString('base64url');
    const run: TrainingRun = {
      id,
      started_at: now.toISOString(),
      status: 'running',
      through: latest,
      data: { train: split.train.length, eval: split.eval.length, owner_verified: unique.filter(isOwnerVerified).length, corrections: corrections.length },
      token: sha256(token).toString('hex'),
      previous: state.promoted,
    };
    await this.o.storage.putCached('training-data', id, { train: split.train.map((ex) => chatRow(ex)).join('\n') + '\n', eval: split.eval.map((ex) => chatRow(ex)).join('\n') + '\n' });
    try {
      this.projectId ??= await this.o.api.ensureProject(this.o.project);
      const job = await this.o.api.createJob(this.projectId, {
        name: `usher-student-${id}`,
        image: this.o.image,
        accelerator: { accelerator: 'H100', count: 1 },
        startCommands: [`/bin/sh -c 'printf "%s" "$USHER_BOOT" > /tmp/boot.py && python3 /tmp/boot.py'`],
        env: { USHER_RUN_URL: `${this.o.url.replace(/\/$/, '')}/training/runs/${id}`, USHER_RUN_TOKEN: token, USHER_BOOT: BOOT, USHER_BASE_DIR: '/app/models/base' },
        weights: [{ source: this.o.baseWeights, mount: '/app/models/base' }],
      });
      run.job = job.id;
    } catch (err) {
      Object.assign(run, { status: 'failed', finished_at: now.toISOString(), reason: `could not start: ${err instanceof Error ? err.message : String(err)}` });
    }
    state.runs.push(run);
    await this.save(state);
    return run.status === 'running' ? `started run ${id} (job ${run.job}): ${run.data.train} train, ${run.data.eval} eval, ${run.data.owner_verified} owner-verified` : `run ${id} ${run.reason}`;
  }

  private async follow(state: TrainingState, run: TrainingRun): Promise<string> {
    const now = this.o.now();
    const finish = async (status: TrainingRun['status'], reason: string, cost?: number) => {
      Object.assign(run, { status, reason, finished_at: now.toISOString(), ...(cost !== undefined && { cost_usd: Math.round(cost * 100) / 100 }) });
      await this.o.storage.putCached('training-data', run.id, null);
      await this.save(state);
      return `run ${run.id} ${status}: ${reason}`;
    };
    if (!run.job) return finish('failed', 'no job was started');
    this.projectId ??= await this.o.api.ensureProject(this.o.project);
    const job = await this.o.api.getJob(this.projectId, run.job);
    const minutes = (to: number) => Math.max(0, (to - Date.parse(run.started_at)) / 60_000);
    if (!FINISHED.has(job.current_status)) {
      if (minutes(now.getTime()) <= this.o.maxRunMinutes) return `run ${run.id}: ${job.current_status}`;
      await this.o.api.stopJob(this.projectId, run.job);
      return finish('failed', `stopped after ${this.o.maxRunMinutes} minutes`, minutes(now.getTime()) * this.o.usdPerMinute);
    }
    // Billed from start to finish; the job's own clock, so a late check costs nothing extra.
    const cost = minutes(Date.parse(job.updated_at)) * this.o.usdPerMinute;
    if (job.current_status !== 'TRAINING_JOB_COMPLETED') return finish('failed', `${job.current_status}${job.error_message ? `: ${job.error_message}` : ''}`, cost);
    if (!run.result) return finish('failed', 'the job finished without reporting its scores', cost);
    const { new: n, previous: p } = run.result;
    const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
    const verdict =
      n.valid < this.o.minValid
        ? `valid JSON ${pct(n.valid)}, under ${pct(this.o.minValid)}`
        : p
          ? n.key < p.key || n.risk < p.risk
            ? `worse than the adapter serving (key ${pct(n.key)} vs ${pct(p.key)}, risk ${pct(n.risk)} vs ${pct(p.risk)})`
            : null
          : n.key < this.o.firstRun.key || n.risk < this.o.firstRun.risk
            ? `under the first run's bar (key ${pct(n.key)} of ${pct(this.o.firstRun.key)}, risk ${pct(n.risk)} of ${pct(this.o.firstRun.risk)})`
            : null;
    if (verdict) return finish('rejected', verdict, cost);
    state.promoted = run.id;
    let note = '';
    if (this.o.studentModelId) {
      try {
        await this.o.api.restartDeployment(this.o.studentModelId);
      } catch (err) {
        note = `; the deployment restart failed (${err instanceof Error ? err.message : String(err)}), so it loads on its next cold start`;
      }
    }
    return finish('promoted', `key ${pct(n.key)}, risk ${pct(n.risk)}${p ? ` (was ${pct(p.key)}, ${pct(p.risk)})` : ''}${note}`, cost);
  }

  /** The running run with this id, if the token is its own. */
  private async authorised(id: string, token: string): Promise<{ state: TrainingState; run: TrainingRun } | null> {
    const state = await this.state();
    const run = state.runs.find((r) => r.id === id && r.status === 'running');
    if (!run || !token) return null;
    return timingSafeEqual(sha256(token), Buffer.from(run.token, 'hex')) ? { state, run } : null;
  }

  /** A file for the job: train.py, requirements.txt, or the run's data. */
  async file(id: string, token: string, name: string): Promise<string | null> {
    if (!(await this.authorised(id, token))) return null;
    if (name === 'train.py') return (await this.o.files()).train;
    if (name === 'requirements.txt') return (await this.o.files()).requirements;
    const data = await this.o.storage.getCached<{ train: string; eval: string } | null>('training-data', id);
    if (name === 'train.chat.jsonl') return data?.train ?? null;
    if (name === 'eval.chat.jsonl') return data?.eval ?? null;
    return null;
  }

  /** The adapter's files of a promoted run, as presigned URLs (relative names under adapter/). */
  private async adapterFiles(runId: string | null, state: TrainingState): Promise<CheckpointFile[]> {
    const job = state.runs.find((r) => r.id === runId)?.job;
    if (!job) return [];
    this.projectId ??= await this.o.api.ensureProject(this.o.project);
    return (await this.o.api.checkpointFiles(this.projectId, job)).filter((f) => f.relative_file_name.startsWith('adapter/'));
  }

  /** For the job: the adapter serving when it started, to score against. Null when not authorised. */
  async previousAdapter(id: string, token: string): Promise<CheckpointFile[] | null> {
    const ok = await this.authorised(id, token);
    return ok ? this.adapterFiles(ok.run.previous, ok.state) : null;
  }

  /** For the student's deployment at start: the promoted adapter. */
  async promotedAdapter(): Promise<{ run: string | null; files: CheckpointFile[] }> {
    const state = await this.state();
    return { run: state.promoted, files: await this.adapterFiles(state.promoted, state) };
  }

  /** The job's scores. False when not authorised or malformed. */
  async report(id: string, token: string, body: unknown): Promise<boolean> {
    const ok = await this.authorised(id, token);
    const share = (x: unknown) => typeof x === 'number' && x >= 0 && x <= 1;
    const scores = (s: unknown): s is Scores => typeof s === 'object' && s !== null && share((s as Scores).key) && share((s as Scores).risk) && share((s as Scores).valid) && Number.isInteger((s as Scores).examples);
    const b = body as Partial<RunResult> | null;
    if (!ok || !b || !scores(b.new) || !(b.previous === null || scores(b.previous))) return false;
    ok.run.result = { new: b.new, previous: b.previous, ...(typeof b.train_loss === 'number' && { train_loss: b.train_loss }), ...(typeof b.steps === 'number' && { steps: b.steps }) };
    await this.save(ok.state);
    return true;
  }
}
