// Field-risk classifier (LU-33): a second opinion on each element's risk from an open-weights
// model (Muse Spark Open on Baseten). Given the label, control, an options summary and the form's
// purpose, it says safe, consequential or needs_user. In the compile pipeline, where it disagrees
// with the labeller, the stricter risk is kept and the element is flagged.

import type { ExtractedElement } from '../extract.ts';
import { stricter } from '../labels.ts';
import { RISKS, type Risk } from '../vocabulary.ts';
import { costUsd, parseJsonContent, type ChatFn, type ChatRequest, type Usage } from './model.ts';

export interface RiskOpinion {
  id: string;
  risk: Risk;
  reason: string;
}

export interface Classification {
  opinions: RiskOpinion[];
  model: string;
  usage: Usage;
  cost_usd: number | null;
  latency_ms: number;
}

/** Where the classifier and the labeller differ, and what was kept. */
export interface RiskFlag {
  id: string;
  key: string;
  label: string;
  labeller: Risk;
  classifier: Risk;
  kept: Risk;
  reason: string;
}

const SYSTEM = `You classify the risk of each element of a web form for AI agents acting for a person. For each element, say:
- safe: reversible, no effect outside the session (typing a name, choosing an option, moving to the next step, searching).
- consequential: has an effect the person should know about (requesting a quote, sending a message, creating a booking, subscribing to a newsletter).
- needs_user: commits the person legally or financially, or needs their own judgement (declarations, consent to terms or marketing, payment details, passwords, government ids).
Judge each element on its own, from its label, its control, its options and the form's purpose. Give a short reason. Classify every element listed, once.`;

function describe(e: ExtractedElement): Record<string, unknown> {
  return {
    id: e.id,
    kind: e.kind,
    control: e.control,
    label: e.label,
    required: e.required,
    ...(e.options && { options: `${e.options.items.slice(0, 5).map((o) => o.label).join(', ')}${e.options.total > 5 ? `, … (${e.options.total} in all)` : ''}` }),
  };
}

export function classifierRequest(model: string, purpose: string, elements: ExtractedElement[]): ChatRequest {
  const ids = elements.map((e) => e.id);
  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Form purpose: ${purpose}\n\nElements:\n${JSON.stringify(elements.map(describe))}` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'usher_risk',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['elements'],
          properties: {
            elements: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'risk', 'reason'],
                properties: { id: { type: 'string', enum: ids }, risk: { type: 'string', enum: [...RISKS] }, reason: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  };
}

/** One request for the whole form; every element must get exactly one valid opinion. */
export async function classifyRisks(chat: ChatFn, model: string, purpose: string, elements: ExtractedElement[]): Promise<Classification> {
  const result = await chat(classifierRequest(model, purpose, elements));
  const parsed = parseJsonContent(result.content) as { elements?: unknown };
  const list = Array.isArray(parsed.elements) ? (parsed.elements as Partial<RiskOpinion>[]) : [];
  const opinions = new Map<string, RiskOpinion>();
  for (const o of list) {
    if (typeof o.id === 'string' && RISKS.includes(o.risk as Risk) && elements.some((e) => e.id === o.id) && !opinions.has(o.id)) {
      opinions.set(o.id, { id: o.id, risk: o.risk as Risk, reason: typeof o.reason === 'string' ? o.reason : '' });
    }
  }
  const missing = elements.filter((e) => !opinions.has(e.id)).map((e) => e.id);
  if (missing.length) throw new Error(`The classifier gave no valid risk for ${missing.join(', ')}.`);
  return { opinions: elements.map((e) => opinions.get(e.id)!), model, usage: result.usage, cost_usd: costUsd(model, result.usage), latency_ms: result.latency_ms };
}

/** Compares opinions with the labeller's risks: the stricter is kept, differences are flagged. */
export function reconcile(labelled: { id: string; key: string; label: string; risk: Risk }[], opinions: RiskOpinion[]): { risks: Map<string, Risk>; flags: RiskFlag[]; agreement: number } {
  const byId = new Map(opinions.map((o) => [o.id, o]));
  const risks = new Map<string, Risk>();
  const flags: RiskFlag[] = [];
  let agree = 0;
  for (const l of labelled) {
    const o = byId.get(l.id);
    if (!o) {
      risks.set(l.id, l.risk);
      continue;
    }
    const kept = stricter(l.risk, o.risk);
    risks.set(l.id, kept);
    if (o.risk === l.risk) agree++;
    else flags.push({ id: l.id, key: l.key, label: l.label, labeller: l.risk, classifier: o.risk, kept, reason: o.reason });
  }
  return { risks, flags, agreement: labelled.length ? agree / labelled.length : 1 };
}
