// Site policies (LU-15): rules per origin and form, with the invariant that a policy can only make
// an action stricter than its map's risk, never looser. Shared by the registry, the server check
// and the site script.

import type { UsherMap } from './map.ts';
import { vocabulary as defaultVocabulary, type Risk, type Vocabulary } from './vocabulary.ts';

export type ActionRule = 'allow' | 'confirm' | 'forbid';

export interface RateLimit {
  /** A semantic key, counted when an agent knocks to perform it, or "knock" for every knock. */
  action: string;
  per: 'agent' | 'origin';
  max: number;
  window: 'minute' | 'hour' | 'day';
}

export interface PolicyRules {
  agent_lane?: boolean;
  actions?: Record<string, ActionRule>;
  rate_limits?: RateLimit[];
}

export interface PolicyForm extends PolicyRules {
  match: { path: string } | { digest: string };
}

export interface UsherPolicy {
  usher_policy: '0.1';
  origin: string;
  default: PolicyRules;
  forms?: PolicyForm[];
  /** hosted: agents acting through a hosted Usher connection (a registry's /mcp), as a class. */
  agents?: { allow?: '*' | string[]; block?: string[]; hosted?: 'allow' | 'block' };
  retention?: { session_days?: number };
}

/** The rules that apply to one form: policy and map risk combined. */
export interface EffectiveRules {
  agent_lane: boolean;
  /** Every key the map or the policy mentions. */
  actions: Record<string, ActionRule>;
  rate_limits: RateLimit[];
}

export const RULE_ORDER: readonly ActionRule[] = ['allow', 'confirm', 'forbid'];

/** The least a map's risk allows. */
export const FLOOR: Record<Risk, ActionRule> = { safe: 'allow', consequential: 'confirm', needs_user: 'forbid' };

export const WINDOW_MS: Record<RateLimit['window'], number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

export function stricterRule(a: ActionRule, b: ActionRule): ActionRule {
  return RULE_ORDER.indexOf(a) >= RULE_ORDER.indexOf(b) ? a : b;
}

/** Path patterns: `*` matches within one segment, `**` across segments. */
export function pathMatches(pattern: string, path: string): boolean {
  const re = pattern
    .split(/(\*\*|\*)/)
    .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${re}$`).test(path);
}

export function formMatches(form: PolicyForm, path: string, digest?: string): boolean {
  return 'path' in form.match ? pathMatches(form.match.path, path) : form.match.digest === digest;
}

/** The policy's own rules for a form: default, then each matching form entry in order. */
export function policyRulesFor(policy: UsherPolicy | undefined, path: string, digest?: string): Required<PolicyRules> {
  const rules: Required<PolicyRules> = { agent_lane: true, actions: {}, rate_limits: [] };
  for (const part of [policy?.default, ...(policy?.forms ?? []).filter((f) => formMatches(f, path, digest))]) {
    if (!part) continue;
    if (part.agent_lane !== undefined) rules.agent_lane = part.agent_lane;
    Object.assign(rules.actions, part.actions);
    if (part.rate_limits) rules.rate_limits.push(...part.rate_limits);
  }
  return rules;
}

/** Policy rules raised to the floor each element's risk sets. */
export function effectiveRules(policy: UsherPolicy | undefined, map: UsherMap | null, path: string): EffectiveRules {
  const own = policyRulesFor(policy, path, map?.fingerprint.digest);
  const actions: Record<string, ActionRule> = { ...own.actions };
  for (const el of [...(map?.fields ?? []), ...(map?.actions ?? [])]) {
    actions[el.key] = stricterRule(actions[el.key] ?? 'allow', FLOOR[el.risk]);
  }
  return { agent_lane: own.agent_lane, actions, rate_limits: own.rate_limits };
}

export function agentStanding(policy: UsherPolicy | undefined, agentId: string, hosted = false): 'allowed' | 'blocked' | 'not_allowed' {
  if (policy?.agents?.block?.includes(agentId) || (hosted && policy?.agents?.hosted === 'block')) return 'blocked';
  const allow = policy?.agents?.allow ?? '*';
  return allow === '*' || allow.includes(agentId) ? 'allowed' : 'not_allowed';
}

export interface PolicyIssue {
  path: string;
  code: string;
  message: string;
}

/**
 * Checks a policy never loosens an action: against every map it applies to, and for keys no map
 * has yet, against the vocabulary's default risk. Schema validity is checked separately.
 */
export function looserRules(policy: UsherPolicy, maps: UsherMap[], vocab: Vocabulary = defaultVocabulary): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const defaults = new Map(vocab.entries.map((e) => [e.key, e.default_risk]));
  const check = (actions: Record<string, ActionRule> | undefined, applies: UsherMap[], at: string) => {
    for (const [key, rule] of Object.entries(actions ?? {})) {
      const risks = applies.flatMap((m) => [...m.fields, ...m.actions].filter((e) => e.key === key).map((e) => ({ risk: e.risk, where: `${m.path}` })));
      const fallback = defaults.get(key);
      const floors = risks.length ? risks : fallback ? [{ risk: fallback, where: 'the vocabulary default' }] : [];
      for (const { risk, where } of floors) {
        if (RULE_ORDER.indexOf(rule) < RULE_ORDER.indexOf(FLOOR[risk])) {
          issues.push({ path: `${at}.actions.${key}`, code: 'looser_than_map', message: `"${key}" is ${risk} (${where}), so its rule must be at least "${FLOOR[risk]}", not "${rule}".` });
          break;
        }
      }
    }
  };
  check(policy.default.actions, maps, 'default');
  (policy.forms ?? []).forEach((form, i) => check(form.actions, maps.filter((m) => formMatches(form, m.path, m.fingerprint.digest)), `forms[${i}]`));
  return issues;
}
