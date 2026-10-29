// Baseten Training over its REST API (https://docs.baseten.co/reference/training-api/overview):
// a project, jobs in it, a job's status and its checkpoint files, and restarting the student's
// deployment so it loads a newly promoted adapter. The key is BASETEN_TRAINING_API_KEY, which is
// for training and the student's deployment only; Muse Spark Open's key (BASETEN_API_KEY) is never
// used here. Neither is ever logged.

const API = 'https://api.baseten.co/v1';

/** Job states (https://docs.baseten.co/training/lifecycle). */
export type JobStatus =
  | 'TRAINING_JOB_CREATED'
  | 'TRAINING_JOB_PENDING'
  | 'TRAINING_JOB_DEPLOYING'
  | 'TRAINING_JOB_RUNNING'
  | 'TRAINING_JOB_COMPLETED'
  | 'TRAINING_JOB_FAILED'
  | 'TRAINING_JOB_DEPLOY_FAILED'
  | 'TRAINING_JOB_STOPPED'
  | 'TRAINING_JOB_PREEMPTED';

export const FINISHED: ReadonlySet<string> = new Set(['TRAINING_JOB_COMPLETED', 'TRAINING_JOB_FAILED', 'TRAINING_JOB_DEPLOY_FAILED', 'TRAINING_JOB_STOPPED', 'TRAINING_JOB_PREEMPTED']);

export interface TrainingJob {
  id: string;
  current_status: JobStatus | string;
  created_at: string;
  updated_at: string;
  error_message?: string | null;
}

export interface CheckpointFile {
  url: string;
  relative_file_name: string;
  node_rank?: number;
}

/** The parts of a job definition we use (CreateTrainingJobV1). */
export interface JobSpec {
  name: string;
  image: string;
  accelerator: { accelerator: string; count: number };
  startCommands: string[];
  env: Record<string, string>;
  /** Weights mounted read-only, mirrored and cached by Baseten: hf://org/model@revision. */
  weights: { source: string; mount: string }[];
}

/** What the trainer needs from Baseten; tests pass a double. */
export interface TrainingApi {
  ensureProject(name: string): Promise<string>;
  createJob(project: string, spec: JobSpec): Promise<TrainingJob>;
  getJob(project: string, job: string): Promise<TrainingJob>;
  stopJob(project: string, job: string): Promise<void>;
  checkpointFiles(project: string, job: string): Promise<CheckpointFile[]>;
  /** Deactivate and reactivate a model's production deployment, so its next start loads the promoted adapter. */
  restartDeployment(model: string): Promise<void>;
}

export class BasetenTraining implements TrainingApi {
  constructor(
    private readonly apiKey: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    // The response, never the request: the request carries the key.
    if (!res.ok) throw new Error(`Baseten ${method} ${path.replace(/\?.*/, '')}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async ensureProject(name: string): Promise<string> {
    const { training_projects } = await this.call<{ training_projects: { id: string; name: string }[] }>('GET', '/training_projects');
    const found = training_projects.find((p) => p.name === name);
    if (found) return found.id;
    const { training_project } = await this.call<{ training_project: { id: string } }>('POST', '/training_projects', { training_project: { name } });
    return training_project.id;
  }

  async createJob(project: string, spec: JobSpec): Promise<TrainingJob> {
    const { training_job } = await this.call<{ training_job: TrainingJob }>('POST', `/training_projects/${encodeURIComponent(project)}/jobs`, {
      training_job: {
        name: spec.name,
        image: { base_image: spec.image },
        // On-demand capacity: a spot job could be preempted part way and start over.
        compute: { node_count: 1, accelerator: spec.accelerator, availability_model: 'dedicated' },
        runtime: {
          start_commands: spec.startCommands,
          environment_variables: spec.env,
          checkpointing_config: { enabled: true },
        },
        weights: spec.weights.map((w) => ({ source: w.source, mount_location: w.mount })),
      },
    });
    return training_job;
  }

  async getJob(project: string, job: string): Promise<TrainingJob> {
    const { training_job } = await this.call<{ training_job: TrainingJob }>('GET', `/training_projects/${encodeURIComponent(project)}/jobs/${encodeURIComponent(job)}`);
    return training_job;
  }

  async stopJob(project: string, job: string): Promise<void> {
    await this.call('POST', `/training_projects/${encodeURIComponent(project)}/jobs/${encodeURIComponent(job)}/stop`, {});
  }

  async checkpointFiles(project: string, job: string): Promise<CheckpointFile[]> {
    const files: CheckpointFile[] = [];
    let token: string | null | undefined = '0';
    while (token !== null && token !== undefined) {
      const page: { presigned_urls: CheckpointFile[]; next_page_token?: string | null } = await this.call('GET', `/training_projects/${encodeURIComponent(project)}/jobs/${encodeURIComponent(job)}/checkpoint_files?page_size=1000&page_token=${encodeURIComponent(token)}`);
      files.push(...page.presigned_urls);
      token = page.next_page_token;
    }
    return files;
  }

  async restartDeployment(model: string): Promise<void> {
    await this.call('POST', `/models/${encodeURIComponent(model)}/deployments/production/deactivate`, {});
    await this.call('POST', `/models/${encodeURIComponent(model)}/deployments/production/activate`, {});
  }
}
