// Details as prose, keyed by Usher. The person writes their details in their own words; Muse Spark
// reads them against the journey's own keys (from the plan) and returns a value per key, or null.
// It labels meaning only: it sees keys, labels, meanings and options, never the page, locators or
// selectors. The answer goes through the same pre-flight as keyed values. One call per usher_fill,
// within the daily cap. The log keeps the prompt's instructions, the schema and which keys came
// back: never the person's text or the values.

import { appendLog, costUsd, DEFAULT_LOG_DIR, lookupFilled, parseJsonContent, vocabulary, type ChatFn, type ChatRequest, type PlanInput, type Usage, type UsherPlan } from '@usher/core';

export interface MappedDetails {
  values: Record<string, string>;
  usage: Usage;
  cost_usd: number | null;
  latency_ms: number;
}

/** The inputs the person's details can give: everything but what is the user's alone to answer. */
export const detailInputs = (plan: UsherPlan): PlanInput[] => plan.inputs.filter((i) => i.risk !== 'needs_user');

const isDate = (i: PlanInput) => i.control === 'date' || i.constraints?.format === 'date';

/** One optional (nullable) property per key: option values as an enum, dates as YYYY-MM-DD. */
export function detailsSchema(inputs: PlanInput[]): Record<string, unknown> {
  const property = (i: PlanInput) => {
    const options = i.options && !i.options.truncated ? i.options.items.map((o) => o.value) : null;
    const value = options ? { type: 'string', enum: options } : { type: 'string', ...(isDate(i) && { description: 'A date as YYYY-MM-DD' }) };
    return { anyOf: [value, { type: 'null' }] };
  };
  return { type: 'object', additionalProperties: false, required: inputs.map((i) => i.key), properties: Object.fromEntries(inputs.map((i) => [i.key, property(i)])) };
}

export function detailsPrompt(inputs: PlanInput[], lookups: Set<string>): string {
  const meanings = new Map(vocabulary.entries.map((e) => [e.key, e.meaning]));
  const lines = inputs.map((i) => {
    const options = i.options ? ` Options (value = label): ${i.options.items.map((o) => `${o.value} = ${o.label}`).join('; ')}${i.options.truncated ? `; … ${i.options.total} in all` : ''}.` : '';
    const meaning = meanings.get(i.key);
    return `- ${i.key}: "${i.label}"${meaning ? ` (${meaning})` : ''}, ${i.control}${isDate(i) ? ', as YYYY-MM-DD' : ''}${lookups.has(i.key) ? ', usually filled by the site\'s own lookup: give it only if the person says it' : ''}.${options}`;
  });
  return `You read a person's details, written in their own words, for a web form, and return them by the form's keys. The person is filling the form themselves through their assistant.

## The form's keys
${lines.join('\n')}

## Rules
- Give a value only for what the person actually says. Anything they don't say is null; never guess or invent.
- For a key with options, give the option's value (left of "="), choosing the one that means what they said ("£250 excess" is 250; "paying monthly" is the monthly option; "no claims" is no).
- Dates as YYYY-MM-DD ("born 2 April 1988" is 1988-04-02). Numbers as digits without units or separators ("8,000 miles a year" is 8000).
- Names, addresses and registrations as written, without changing their case or spacing beyond trimming.`;
}

/** Maps the person's text to values by key, with one Muse Spark call. */
export async function mapDetails(chat: ChatFn, model: string, plan: UsherPlan, text: string, options: { logDir?: string | null; given?: (key: string) => boolean } = {}): Promise<MappedDetails> {
  const inputs = detailInputs(plan);
  const lookups = lookupFilled(plan, options.given ?? (() => false));
  const system = detailsPrompt(inputs, lookups);
  const schema = detailsSchema(inputs);
  const request: ChatRequest = {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'usher_details', strict: true, schema } },
  };
  const result = await chat(request);
  const parsed = (parseJsonContent(result.content) ?? {}) as Record<string, unknown>;
  const allowed = new Set(inputs.map((i) => i.key));
  const values = Object.fromEntries(Object.entries(parsed).filter(([k, v]) => allowed.has(k) && typeof v === 'string' && v.trim() !== '').map(([k, v]) => [k, (v as string).trim()]));
  const cost = costUsd(model, result.usage);
  const logDir = options.logDir === undefined ? DEFAULT_LOG_DIR : options.logDir;
  // The instructions and schema, and which keys came back: never the person's text or the values.
  if (logDir) await appendLog(logDir, { ts: new Date().toISOString(), model, task: 'details', origin: plan.origin, intent: plan.intent, system, schema, keys_returned: Object.keys(values).sort(), usage: result.usage, latency_ms: result.latency_ms, cost_usd: cost }).catch(() => undefined);
  return { values, usage: result.usage, cost_usd: cost, latency_ms: result.latency_ms };
}
