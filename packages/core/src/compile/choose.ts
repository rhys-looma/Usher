// Choosing the form by intent. When a page has more than one form a map could be for (after code
// has left out cookie widgets, site searches and newsletter boxes; see forms.ts), Muse Spark gets a
// line about each and the agent's intent, and names one. Code builds the lines and checks the
// answer; the model never sees the page's markup.

import type { Scan, ScannedForm } from '../inpage.ts';
import { candidateForms, mainForm } from '../forms.ts';
import { costUsd, parseJsonContent, type ChatFn, type ChatRequest, type Usage } from './model.ts';
import { shortlist } from './shortlist.ts';

export interface FormChoice {
  model: string;
  /** Index of the chosen form in the scan. */
  index: number;
  reason: string;
  /** How many forms it chose between. */
  candidates: number;
  usage: Usage;
  cost_usd: number | null;
  latency_ms: number;
}

export const CHOOSE_SYSTEM = `You choose which form on a web page an AI agent should use. You get one line per form, written by code from the page, and the agent's intent.
Choose the form a person with that intent came to this page to fill in. Never choose a site search, a cookie or consent widget, or a newsletter sign-up unless the intent asks for one.
Answer with the form's id and a reason of a few words.`;

/** One line about a form: a guess at its purpose from its fields' likely keys, its fields and buttons. */
export function formLine(form: ScannedForm, id: string): string {
  const fields = form.elements.filter((e) => e.kind === 'field' && e.visible);
  const buttons = form.elements.filter((e) => e.kind === 'action' && e.visible);
  const likely = [...new Set(fields.map((f) => shortlist({ kind: 'field', control: f.control, label: f.label, ...(f.autocomplete && { autocomplete: f.autocomplete }) })[0]).filter(Boolean))];
  const quote = (s: string) => JSON.stringify(s.slice(0, 60));
  return [
    `${id}:`,
    `purpose guess from its fields: ${likely.length ? likely.slice(0, 6).join(', ') : 'unclear'};`,
    `${fields.length} visible field${fields.length === 1 ? '' : 's'}: ${fields.slice(0, 12).map((f) => `${quote(f.label)} (${f.control})`).join(', ')}${fields.length > 12 ? ', …' : ''};`,
    `buttons: ${buttons.slice(0, 6).map((b) => quote(b.label)).join(', ') || 'none'}`,
    form.pseudo ? '; controls outside any <form>' : `${form.domId ? `; form id ${quote(form.domId)}` : ''}${form.actionPath ? `; submits to ${form.actionPath}` : ''}`,
  ].join(' ');
}

export function chooseRequest(scan: Scan, forms: ScannedForm[], intent: string | null | undefined, model: string, title: string): ChatRequest {
  const ids = forms.map((f) => `F${f.index}`);
  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: CHOOSE_SYSTEM },
      { role: 'user', content: `Intent: ${intent ?? 'none given; choose the main form a person came to this page to fill in'}\nPage: ${title} (${new URL(scan.url).pathname})\nForms:\n${forms.map((f, i) => formLine(f, ids[i]!)).join('\n')}` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'form_choice', strict: true, schema: { type: 'object', additionalProperties: false, required: ['form', 'reason'], properties: { form: { type: 'string', enum: ids }, reason: { type: 'string' } } } },
    },
  };
}

export class NoFormError extends Error {
  constructor(url: string, intent: string | null | undefined, scan: Scan) {
    const left = [...new Set(scan.forms.flatMap((f) => [f.banner && 'a cookie or consent widget', f.search && 'a site search', f.newsletter && 'a newsletter sign-up'].filter(Boolean)))];
    super(`No form to map on ${url}${intent ? ` for ${intent}` : ''}${left.length ? `: the page has only ${left.join(', ')}` : ''}.`);
    this.name = 'NoFormError';
  }
}

/**
 * The form to map. One candidate needs no model; several go to the model with the intent. If the
 * model fails, the likeliest form by code. Throws NoFormError when nothing qualifies.
 */
export async function chooseForm(scan: Scan, options: { intent?: string | null; chat?: ChatFn; model?: string; title?: string }): Promise<{ form: ScannedForm; choice?: FormChoice; error?: string }> {
  const candidates = candidateForms(scan.forms, options.intent);
  if (!candidates.length) throw new NoFormError(scan.url, options.intent, scan);
  if (candidates.length === 1 || !options.chat || !options.model) return { form: mainForm(scan.forms, options.intent)! };
  const request = chooseRequest(scan, candidates, options.intent, options.model, options.title ?? '');
  try {
    const result = await options.chat(request);
    const answer = parseJsonContent(result.content) as { form?: string; reason?: string };
    const form = candidates.find((f) => `F${f.index}` === answer.form);
    if (!form) throw new Error(`The model chose ${String(answer.form)}, which is not a candidate.`);
    return { form, choice: { model: options.model, index: form.index, reason: String(answer.reason ?? ''), candidates: candidates.length, usage: result.usage, cost_usd: costUsd(options.model, result.usage), latency_ms: result.latency_ms } };
  } catch (err) {
    return { form: mainForm(scan.forms, options.intent)!, error: err instanceof Error ? err.message : String(err) };
  }
}
