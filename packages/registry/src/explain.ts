// Session explanations (LU-34): one to three plain sentences a site owner would find useful about
// what agents did on a form. Code works out the facts from the log (structure and timings only);
// the model only puts them into words. Any ChatFn works: Muse Spark, or Spark Open on Baseten.

import { createHash } from 'node:crypto';
import { costUsd, parseJsonContent, type ChatFn, type ChatRequest, type Usage, type UsherMap } from '@usher/core';
import type { Session } from './storage.ts';

export interface Explanation {
  path: string;
  text: string;
  sessions: number;
  model: string;
  created_at: string;
  /** Hash of the facts, so unchanged activity is not explained twice. */
  facts_sha256: string;
}

interface BlockedFact {
  path: string;
  reason: string;
}

const FILL_ACTIONS = new Set(['fill', 'select', 'choose', 'check', 'uncheck']);
/** A step counts as a stall when agents typically spend this long on it. */
export const STALL_SECONDS = 10;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
}

/** What happened on one form, from sessions and refusals: counts and timings, never values. */
export function formFacts(map: UsherMap, sessions: Session[], blocked: BlockedFact[]): Record<string, unknown> {
  const path = map.path;
  const elements = new Map([...map.fields, ...map.actions].map((e) => [e.key, e]));
  const relevant = sessions.filter((s) => s.events.some((e) => e.path === path));
  const advance = map.actions.find((a) => a.key === 'form.submit' || a.key === 'search.submit') ?? map.actions.find((a) => a.key === 'nav.next');
  const dwell = new Map<string, number[]>();
  let submitted = 0;
  let held = 0;
  let confirmed = 0;
  let viaCompile = 0;
  const handoffs = new Map<string, number>();

  for (const s of relevant) {
    const events = s.events.filter((e) => e.path === path).sort((a, b) => a.ts.localeCompare(b.ts));
    if (events.some((e) => e.action === 'submit' && e.key === advance?.key)) submitted++;
    if (events.some((e) => e.action === 'held')) held++;
    if (events.some((e) => e.action === 'confirm')) confirmed++;
    if (events.some((e) => e.action === 'knock' && e.detail?.match !== 'exact')) viaCompile++;
    for (const e of events) if (e.action === 'handoff' && e.key) handoffs.set(e.key, (handoffs.get(e.key) ?? 0) + 1);
    // Time an agent spent before each action: from the previous event on this page.
    for (let i = 1; i < events.length; i++) {
      const e = events[i]!;
      if (!FILL_ACTIONS.has(e.action) || !e.key) continue;
      const seconds = (Date.parse(e.ts) - Date.parse(events[i - 1]!.ts)) / 1000;
      dwell.set(e.key, [...(dwell.get(e.key) ?? []), seconds]);
    }
  }

  const stalls = [...dwell]
    .map(([key, times]) => {
      const el = elements.get(key);
      return { key, label: el?.label, control: el && 'control' in el ? el.control : undefined, options: el && 'options' in el ? el.options?.total : undefined, median_seconds: Math.round(median(times) * 10) / 10, agents: times.length };
    })
    .filter((s) => s.median_seconds >= STALL_SECONDS)
    .sort((a, b) => b.median_seconds - a.median_seconds)
    .slice(0, 3);
  const refusals = blocked.filter((b) => b.path === path).reduce<Record<string, number>>((acc, b) => ({ ...acc, [b.reason]: (acc[b.reason] ?? 0) + 1 }), {});

  return {
    form: { path, purpose: map.form.purpose, fields: map.fields.length, way_forward: advance ? { key: advance.key, label: advance.label, risk: advance.risk } : null },
    agents: new Set(relevant.map((s) => s.agent)).size,
    sessions: relevant.length,
    reached_way_forward: submitted,
    paused_for_user_confirmation: held,
    confirmed_by_user: confirmed,
    read_the_page_themselves_no_exact_map: viaCompile,
    handed_to_the_user: Object.fromEntries(handoffs),
    stalls_over_10_seconds: stalls,
    refused_attempts: refusals,
  };
}

const SYSTEM = `You explain to a website owner, in plain English, what AI agents did on one of their forms. You get facts worked out from the site's agent log: counts and timings by semantic field key, never anything a person typed.

Write 1 to 3 short sentences the owner would find useful and could act on. Lead with what matters most: where agents stall (only the steps listed as stalls) and a likely reason (for example a dropdown with many options and no search), how many reached the end, how many paused for their user's confirmation and were confirmed, what was refused and why. Leave out anything that is zero or unremarkable. Use the numbers given. Name fields by their visible label. Do not invent facts, do not mention anything not in the facts, and do not use words like JSON, session id or event.`;

export function explanationSchema(): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, required: ['sentences'], properties: { sentences: { type: 'array', items: { type: 'string' } } } };
}

export function factsHash(facts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

export interface ExplainResult {
  text: string;
  facts: Record<string, unknown>;
  facts_sha256: string;
  usage: Usage;
  cost_usd: number | null;
  latency_ms: number;
}

/** Puts a form's facts into one to three sentences. */
export async function explainFacts(chat: ChatFn, model: string, facts: Record<string, unknown>): Promise<ExplainResult> {
  const request: ChatRequest = {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Facts:\n${JSON.stringify(facts, null, 1)}` },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'usher_explanation', strict: true, schema: explanationSchema() } },
  };
  const result = await chat(request);
  const parsed = parseJsonContent(result.content) as { sentences?: unknown };
  const sentences = Array.isArray(parsed.sentences) ? parsed.sentences.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
  if (!sentences.length) throw new Error('The model gave no explanation.');
  return {
    text: sentences.slice(0, 3).map((s) => s.trim()).join(' '),
    facts,
    facts_sha256: factsHash(facts),
    usage: result.usage,
    cost_usd: costUsd(model, result.usage),
    latency_ms: result.latency_ms,
  };
}
