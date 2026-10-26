// Plain-English site rules to policy (LU-32). Muse Spark reads the owner's text with the site's
// maps for context and returns a structured draft; code turns it into a policy, which must pass
// the policy schema and the never-looser check before the owner can confirm it.

import {
  costUsd,
  looserRules,
  parseJsonContent,
  policySchemaErrors,
  vocabulary,
  type ChatFn,
  type ChatMessage,
  type ChatRequest,
  type PolicyForm,
  type PolicyIssue,
  type RateLimit,
  type Usage,
  type UsherMap,
  type UsherPolicy,
} from '@usher/core';

/** What the model returns: flat lists, as the strict structured-output subset needs. */
export interface RulesDraftOutput {
  summary: string;
  agent_lane: boolean;
  forms_without_agents: string[];
  actions: { key: string; rule: 'allow' | 'confirm' | 'forbid'; path: string | null }[];
  rate_limits: { action: string; per: 'agent' | 'origin'; max: number; window: 'minute' | 'hour' | 'day'; path: string | null }[];
  allowed_agents: string[] | null;
  blocked_agents: string[];
  retention_days: number | null;
}

export function rulesSchema(): Record<string, unknown> {
  const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
  const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  return object({
    summary: { type: 'string' },
    agent_lane: { type: 'boolean' },
    forms_without_agents: { type: 'array', items: { type: 'string' } },
    actions: { type: 'array', items: object({ key: { type: 'string' }, rule: { type: 'string', enum: ['allow', 'confirm', 'forbid'] }, path: nullableString }) },
    rate_limits: {
      type: 'array',
      items: object({
        action: { type: 'string' },
        per: { type: 'string', enum: ['agent', 'origin'] },
        max: { type: 'integer' },
        window: { type: 'string', enum: ['minute', 'hour', 'day'] },
        path: nullableString,
      }),
    },
    allowed_agents: { anyOf: [{ type: 'array', items: { type: 'string', description: 'A 43-character agent id from the text' } }, { type: 'null' }] },
    blocked_agents: { type: 'array', items: { type: 'string', description: 'A 43-character agent id from the text' } },
    retention_days: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
  });
}

export function rulesSystemPrompt(origin: string, maps: UsherMap[]): string {
  // Sorted, so the same site always gives the same prompt.
  const forms = [...maps]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((m) => `- ${m.path}: ${m.form.purpose}\n${[...m.fields, ...m.actions].map((e) => `  - ${e.key} (${e.risk}): "${e.label}"`).join('\n')}`)
    .join('\n');
  const actionKeys = vocabulary.entries.filter((e) => e.kind === 'action').map((e) => `- ${e.key} (${e.default_risk}): ${e.meaning}`).join('\n');
  return `You turn a website owner's rules for AI agents, written in plain English, into a structured policy for Usher. Usher lets sites control what agents do on their forms.

## The site
Origin: ${origin}
Its forms, with each element's semantic key and risk:
${forms || '(no forms mapped yet)'}

Action keys in the vocabulary:
${actionKeys}

## What to output
- summary: one sentence restating the rules as you understood them.
- agent_lane: whether agents may use the site's forms at all (true unless the owner says agents are not welcome anywhere).
- forms_without_agents: paths of forms agents may not use at all.
- actions: a rule per semantic key: "allow" (agents may do it), "confirm" (the agent must get its user's confirmation first) or "forbid" (agents may not do it; the user can). path is null for the whole site, or a form's path.
- rate_limits: "at most max of action per agent (each agent separately) or per origin (all agents together) per minute, hour or day". action is a semantic key, or "knock" for any use of a form. If a limit does not say whether it is per agent or for the whole site, use "agent". path is null for the whole site.
- allowed_agents and blocked_agents: agent ids are 43-character strings such as "Xq3vT0p2bN8mLr6sYwK1dE5gHj9uZc4aFo7iPe2Rk0Q". Only list ids the owner actually writes in the text. If the owner names no agent ids, allowed_agents is null and blocked_agents is an empty list [].
- retention_days: how long to keep logs of agent sessions, if the owner says; otherwise null.

## Rules
- Use the semantic keys above. "Submitting a quote", "getting a price" and "requesting a quote" all mean form.submit; "paying" or "buying" means form.purchase.
- A rule can make an action stricter than its risk but never looser: consequential actions need at least "confirm", needs_user ones are "forbid". Do not output rules for keys the owner did not mention; their risk already applies.
- "Agents can fill in forms" needs no action rules: filling safe fields is allowed by default.
- Do not invent rules the owner did not state.`;
}

export function toPolicy(origin: string, out: RulesDraftOutput): UsherPolicy {
  const forms = new Map<string, PolicyForm>();
  const form = (path: string) => {
    let f = forms.get(path);
    if (!f) forms.set(path, (f = { match: { path } }));
    return f;
  };
  const policy: UsherPolicy = { usher_policy: '0.1', origin, default: { agent_lane: out.agent_lane } };
  for (const path of out.forms_without_agents) form(path).agent_lane = false;
  for (const a of out.actions) {
    const target = a.path ? form(a.path) : policy.default;
    target.actions = { ...target.actions, [a.key]: a.rule };
  }
  for (const r of out.rate_limits) {
    const target = r.path ? form(r.path) : policy.default;
    const limit: RateLimit = { action: r.action, per: r.per, max: r.max, window: r.window };
    target.rate_limits = [...(target.rate_limits ?? []), limit];
  }
  if (forms.size) policy.forms = [...forms.values()];
  if (out.allowed_agents || out.blocked_agents.length) {
    policy.agents = { allow: out.allowed_agents ?? '*', block: out.blocked_agents };
  }
  if (out.retention_days) policy.retention = { session_days: out.retention_days };
  return policy;
}

export interface RulesResult {
  policy: UsherPolicy;
  summary: string;
  attempts: number;
  usage: Usage;
  cost_usd: number | null;
  latency_ms: number;
}

export class RulesError extends Error {
  constructor(
    message: string,
    readonly issues: PolicyIssue[],
  ) {
    super(message);
  }
}

/** Plain English → validated policy, with one retry carrying the problems back to the model. */
export async function compileRules(chat: ChatFn, model: string, text: string, origin: string, maps: UsherMap[]): Promise<RulesResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: rulesSystemPrompt(origin, maps) },
    { role: 'user', content: `The site owner's rules:\n\n${text}` },
  ];
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 };
  let latency = 0;
  let issues: PolicyIssue[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const request: ChatRequest = {
      model,
      temperature: 0,
      messages: [...messages],
      response_format: { type: 'json_schema', json_schema: { name: 'usher_rules', strict: true, schema: rulesSchema() } },
    };
    const result = await chat(request);
    for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += result.usage[k];
    latency += result.latency_ms;
    let policy: UsherPolicy | undefined;
    let summary = '';
    try {
      const out = parseJsonContent(result.content) as RulesDraftOutput;
      summary = out.summary;
      policy = toPolicy(origin, out);
      const schema = policySchemaErrors(policy);
      issues = schema ? [{ path: '$', code: 'invalid_policy', message: schema }] : looserRules(policy, maps);
    } catch {
      issues = [{ path: '$', code: 'invalid_json', message: 'The reply was not the JSON asked for.' }];
    }
    if (policy && !issues.length) return { policy, summary, attempts: attempt, usage, cost_usd: costUsd(model, usage), latency_ms: latency };
    messages.push({ role: 'assistant', content: result.content }, { role: 'user', content: `That policy has problems. Fix them and reply with the whole corrected output.\n${JSON.stringify(issues, null, 1)}` });
  }
  throw new RulesError(`The rules could not be turned into a valid policy: ${issues.map((i) => i.message).join(' ')}`, issues);
}
