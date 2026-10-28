// The map viewer (LU-38). Anyone can pick one of a fixed list of public forms (picker.ts) and see
// the map Usher builds for it; nobody sends a URL. A site owner signed in to the dashboard can map
// any page on their own claimed origin. Local demos can open any address ('open'). Every request
// the browser makes, redirects and subresources included, must reach a public address. Compiles
// are rate limited, within the daily model budget, and cached by fingerprint digest.

import { lookup } from 'node:dns/promises';
import { isPrivateAddress, publicHost } from '@usher/core/public-fetch';
import type { Browser } from 'playwright';
import { BudgetExceeded, CompileError, NoFormError, VIEWPORT, candidateForms, compilePage, fingerprint, mapFromLabels, scanScript, type ChatFn, type RiskFlag, type Scan, type UsherMap } from '@usher/core';
import { RateLimiter } from '../rate-limit.ts';
import type { MapRecord, Storage } from '../storage.ts';
import { html, page, riskBadge, verificationNote, when, type Raw } from './html.ts';
import type { PickerForm } from './picker.ts';

export type ViewerFailure = 'invalid_url' | 'private_address' | 'unreachable' | 'http_error' | 'timeout' | 'no_form' | 'no_model' | 'labels_invalid' | 'rate_limited' | 'budget' | 'unknown_form' | 'not_your_site';

export type ViewerResult =
  | { ok: true; map: UsherMap; cached: boolean; model: string; cost_usd: number | null; ms: number; flags?: RiskFlag[] }
  | { ok: false; reason: ViewerFailure; message: string };

export interface ViewerOptions {
  storage: Storage;
  chat?: ChatFn;
  model?: string;
  /** A second opinion on risk (Muse Spark Open); disagreements keep the stricter risk and are shown. */
  classifier?: { chat: ChatFn; model: string };
  /** Allow localhost and private networks (for local demos). */
  allowPrivate?: boolean;
  /** The forms anyone can pick (picker.ts). */
  forms?: PickerForm[];
  /** True once today's model budget is spent: the picker refresh then loads nothing. */
  overBudget?: () => Promise<boolean>;
  timeoutMs?: number;
}

interface CachedLabels {
  labels: unknown;
  model: string;
  created_at: string;
}

interface PickedMap {
  map: UsherMap;
  model: string;
  compiled_at: string;
  flags?: RiskFlag[];
}

export class Viewer {
  private browser?: Promise<Browser>;
  // Per client (in memory only; addresses are never stored) and overall.
  private readonly perClient = new RateLimiter(10, 3_600_000);
  private readonly overall = new RateLimiter(100, 3_600_000);

  constructor(private readonly options: ViewerOptions) {}

  private getBrowser(): Promise<Browser> {
    this.browser ??= import('playwright').then(({ chromium }) => chromium.launch());
    return this.browser;
  }

  async close(): Promise<void> {
    if (this.browser) await (await this.browser).close();
  }

  get forms(): PickerForm[] {
    return this.options.forms ?? [];
  }

  /** One of the picker's forms: from the cache when it has been mapped, else mapped now. */
  async pick(id: string, client: string): Promise<ViewerResult> {
    const form = this.forms.find((f) => f.id === id);
    if (!form) return { ok: false, reason: 'unknown_form', message: 'Pick one of the forms listed.' };
    const picked = await this.options.storage.getCached<PickedMap>('viewer-pick', id);
    if (picked) return { ok: true, map: picked.map, cached: true, model: picked.model, cost_usd: 0, ms: 0, ...(picked.flags && { flags: picked.flags }) };
    return this.mapPicked(form, client, true);
  }

  /**
   * Maps every picker form again (the keeper calls this after its runs). A form whose structure
   * hasn't changed reuses its labels, so it costs no model call; spend stays within the daily budget.
   */
  async refreshPicker(): Promise<{ id: string; ok: boolean; detail: string }[]> {
    const results: { id: string; ok: boolean; detail: string }[] = [];
    if (!this.options.chat || !this.options.model) return results;
    if (await this.options.overBudget?.()) return [{ id: '*', ok: false, detail: "today's model budget is used up" }];
    for (const form of this.forms) {
      const result = await this.mapPicked(form, 'keeper', false).catch((err: Error) => ({ ok: false, reason: 'unreachable', message: err.message }) as ViewerResult);
      results.push({ id: form.id, ok: result.ok, detail: result.ok ? (result.cached ? 'unchanged' : `rebuilt by ${result.model}`) : result.message });
      if (!result.ok && result.reason === 'budget') break;
    }
    return results;
  }

  private async mapPicked(form: PickerForm, client: string, limited: boolean): Promise<ViewerResult> {
    const result = await this.run(new URL(form.url), client, limited);
    if (result.ok) await this.options.storage.putCached('viewer-pick', form.id, { map: result.map, model: result.model, compiled_at: new Date().toISOString(), ...(result.flags && { flags: result.flags }) } satisfies PickedMap);
    return result;
  }

  /**
   * Any address: a signed-in owner's page on their own origin (`owner`), or, for local demos
   * ('open' mode, never in production), anything.
   */
  async compile(input: string, client: string, options: { owner?: string } = {}): Promise<ViewerResult> {
    const fail = (reason: ViewerFailure, message: string): ViewerResult => ({ ok: false, reason, message });
    let url: URL;
    try {
      url = new URL(input.trim().match(/^https?:\/\//i) ? input.trim() : `https://${input.trim()}`);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    } catch {
      return fail('invalid_url', 'That is not a web address. Try something like https://example.com/contact.');
    }
    if (options.owner && url.origin !== options.owner) return fail('not_your_site', `Only pages on your own site (${options.owner}) can be mapped here.`);
    if (!this.options.allowPrivate) {
      const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
      if (!addresses.length) return fail('unreachable', `${url.hostname} could not be found.`);
      if (addresses.some((a) => isPrivateAddress(a.address))) return fail('private_address', 'The viewer only opens public websites.');
    }
    return this.run(url, client, true);
  }

  private async run(url: URL, client: string, limited: boolean): Promise<ViewerResult> {
    const fail = (reason: ViewerFailure, message: string): ViewerResult => ({ ok: false, reason, message });
    if (limited && (!this.perClient.wouldAllow(client) || !this.overall.wouldAllow('all'))) return fail('rate_limited', 'Too many maps compiled recently. Try again in a while.');

    const started = performance.now();
    const context = await (await this.getBrowser()).newContext({ viewport: VIEWPORT });
    // Every request the page makes (redirects, scripts, frames) must reach a public address.
    if (!this.options.allowPrivate) {
      const verdicts = new Map<string, Promise<boolean>>();
      await context.route('**/*', async (route) => {
        const host = new URL(route.request().url()).hostname;
        if (!verdicts.has(host)) verdicts.set(host, publicHost(host));
        return (await verdicts.get(host)) ? route.continue() : route.abort('blockedbyclient');
      });
    }
    try {
      const tab = await context.newPage();
      let response;
      try {
        response = await tab.goto(url.href, { waitUntil: 'load', timeout: this.options.timeoutMs ?? 30_000 });
      } catch (err) {
        const timedOut = err instanceof Error && /Timeout/i.test(err.message);
        return timedOut ? fail('timeout', 'The page took too long to load.') : fail('unreachable', `The page could not be opened (${err instanceof Error ? err.message.split('\n')[0] : 'error'}).`);
      }
      const status = response?.status() ?? 200;
      if (status >= 400) {
        const blocked = [401, 403, 429, 503].includes(status);
        return fail('http_error', blocked ? `The site refused the request (HTTP ${status}); it may block automated browsers.` : `The page returned HTTP ${status}.`);
      }
      const scan: Scan = await tab.evaluate(scanScript());
      if (!scan.forms.some((f) => f.elements.some((e) => e.kind === 'field' && e.visible))) return fail('no_form', 'No form with visible fields was found on that page.');
      if (limited) {
        this.perClient.allow(client);
        this.overall.allow('all');
      }

      // Same structure as before (any form a map could be for): reuse the labels, locate again on this page.
      for (const form of candidateForms(scan.forms)) {
        const digest = (await fingerprint(form.elements)).digest;
        const cached = await this.options.storage.getCached<CachedLabels>('viewer-labels', digest);
        if (!cached) continue;
        const map = await mapFromLabels(tab, cached.labels, { compiler: cached.model, created_at: cached.created_at }, digest);
        if (map) return { ok: true, map, cached: true, model: cached.model, cost_usd: 0, ms: Math.round(performance.now() - started) };
      }
      if (!this.options.chat || !this.options.model) return fail('no_model', 'No model is set up here to read pages yet.');
      try {
        const result = await compilePage(tab, { chat: this.options.chat, model: this.options.model, ...(this.options.classifier && { classifier: this.options.classifier }) });
        const flags = result.classifier && !('error' in result.classifier) ? result.classifier.flags : undefined;
        await this.options.storage.putCached('viewer-labels', result.map.fingerprint.digest, { labels: result.labels, model: result.model, created_at: result.map.provenance.created_at } satisfies CachedLabels);
        return { ok: true, map: result.map, cached: false, model: result.model, cost_usd: result.cost_usd, ms: Math.round(performance.now() - started), ...(flags && { flags }) };
      } catch (err) {
        if (err instanceof NoFormError) return fail('no_form', err.message);
        if (err instanceof CompileError) return fail('labels_invalid', 'The model could not label this form reliably, so no map was made.');
        if (err instanceof BudgetExceeded) return fail('budget', `${err.message} Maps already built are still shown from the cache.`);
        throw err;
      }
    } finally {
      await context.close();
    }
  }
}

/** The picker's forms, one button each: a visitor chooses by id and never sends an address. */
export function pickerButtons(forms: PickerForm[], from?: string): Raw {
  return html`<form class="picker" method="post" action="/viewer">${from ? html`<input type="hidden" name="from" value="${from}">` : ''}
${forms.map((f) => html`<button type="submit" name="form" value="${f.id}"><b>${f.name}</b><span>${f.about}</span></button>`)}
</form>`;
}

export function viewerPage(options: { forms: PickerForm[]; owner?: string; open?: boolean; url?: string; error?: { reason: string; message: string } }): string {
  return page(
    'Map viewer',
    html`<style>${PICKER_STYLE}</style><h1>Map viewer</h1>
<p class="lede">Pick a form. Usher reads its structure, never anything typed, and Muse Spark labels what each field means and how risky it is to act on. Nothing is submitted.</p>
${options.error ? html`<div class="card error"><b>No map.</b> ${options.error.message}</div>` : ''}
${pickerButtons(options.forms)}
${
  options.owner || options.open
    ? html`<h2>${options.owner ? 'A page on your site' : 'Any page (local demo)'}</h2>
<form class="inline card" method="post" action="/viewer">
  <input type="url" name="url" required placeholder="${options.owner ? `${options.owner}/contact` : 'https://example.com/contact'}" value="${options.url ?? ''}" aria-label="Page address">
  <button type="submit">Build the map</button>
</form>`
    : html`<p class="small muted">Run a site? <a href="/dashboard">Sign in</a> to map any page on it.</p>`
}`,
  );
}

export const PICKER_STYLE = `
form.picker { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:10px; margin:0 0 14px; }
form.picker button { display:flex; flex-direction:column; align-items:flex-start; gap:2px; text-align:left; background:var(--card); color:var(--ink); border:1px solid var(--line); padding:14px 16px; font-weight:400; align-self:stretch; }
form.picker button b { font-family:var(--serif); font-size:18px; font-weight:700; }
form.picker button span { font-size:13.5px; color:var(--muted); line-height:1.35; }
form.picker button:hover { border-color:var(--accent); background:var(--card); color:var(--ink); }
form.picker button:hover b { color:var(--accent); }
`;

function condition(c: UsherMap['fields'][number]['shown_if']): Raw | string {
  if (!c) return '';
  return html`<span class="small">when <code>${c.field}</code> ${c.op.replace('_', ' ')}${c.value !== undefined ? html` <code>${Array.isArray(c.value) ? c.value.join(', ') : c.value}</code>` : ''}</span>`;
}

function locators(el: { locators: UsherMap['fields'][number]['locators'] }): Raw {
  return html`<details><summary class="small">${el.locators.length} locator${el.locators.length === 1 ? '' : 's'}</summary><ol class="small mono">${el.locators.map(
    (l) => html`<li>${l.by}: ${l.value}${l.name ? ` "${l.name}"` : ''}</li>`,
  )}</ol></details>`;
}

/** A map, readable: purpose, fields with key and risk, actions, locators, fingerprint, raw JSON. */
/** A map as a page. For a site owner (owner: true), without the structure signature and the raw file, which are for developers. */
export function mapPage(map: UsherMap, info: { source: string; record?: MapRecord; flags?: RiskFlag[]; owner?: boolean }): string {
  const drift = info.record?.drift;
  return page(
    map.form.purpose,
    html`<p class="muted small"><a href="/viewer">Map viewer</a> · ${map.origin}${map.path}</p>
<h1>${map.form.purpose}</h1>
<p class="lede">${map.form.intent ? html`Intent <code>${map.form.intent}</code> · ` : ''}${map.fields.length} fields, ${map.actions.length} actions · ${info.source}</p>
${info.record && verificationNote(info.record) ? html`<div class="card ${info.record.verification ? 'notice' : 'warn'}">${verificationNote(info.record)}</div>` : ''}
${drift ? html`<div class="card warn"><b>Drifted.</b> The live form no longer matches this map (similarity ${drift.score}), reported ${when(drift.at)}.</div>` : ''}
${info.flags?.length ? html`<div class="card warn"><b>Second opinion.</b> The open-weights classifier disagreed on ${info.flags.length} element${info.flags.length === 1 ? '' : 's'}; the stricter risk was kept.<ul class="small">${info.flags.map((f) => html`<li>${f.label} (<code>${f.key}</code>): labeller ${f.labeller}, classifier ${f.classifier}, kept ${riskBadge(f.kept)}. ${f.reason}</li>`)}</ul></div>` : ''}
<h2>Fields</h2>
<div class="card"><table>
<thead><tr><th>Label</th><th>Key</th><th>Control</th><th>Risk</th><th>Notes</th><th>Found by</th></tr></thead>
<tbody>${map.fields.map(
      (f) => html`<tr><td>${f.label}${f.required ? html` <span class="muted small">required</span>` : ''}</td><td><code>${f.key}</code></td><td>${f.control}</td><td>${riskBadge(f.risk)}</td>
<td>${condition(f.shown_if)}${f.options ? html`<span class="small muted">${f.options.total} options${f.options.truncated ? ' (first 20 kept)' : ''}</span>` : ''}${f.sensitive ? html` <span class="badge risk-needs_user">sensitive</span>` : ''}</td><td>${locators(f)}</td></tr>`,
    )}</tbody></table></div>
<h2>Actions</h2>
<div class="card"><table>
<thead><tr><th>Label</th><th>Key</th><th>Kind</th><th>Risk</th><th>Leads to</th><th>Found by</th></tr></thead>
<tbody>${map.actions.map(
      (a) => html`<tr><td>${a.label}</td><td><code>${a.key}</code></td><td>${a.kind}</td><td>${riskBadge(a.risk)}</td><td>${a.leads_to ? html`<code>${a.leads_to}</code>` : html`<span class="muted">–</span>`}</td><td>${locators(a)}</td></tr>`,
    )}</tbody></table></div>
${
      info.owner
        ? html`<p class="small muted"><a href="/maps/${map.fingerprint.digest}?origin=${encodeURIComponent(map.origin)}">Download the map file</a> (JSON, for developers).</p>`
        : html`<h2>Fingerprint</h2>
<div class="card"><p class="mono small">${map.fingerprint.digest}</p><p class="small muted">${map.fingerprint.signature.length} element signatures: ${map.fingerprint.signature.join(' ')}</p></div>
<h2>Raw map</h2>
<pre>${JSON.stringify(map, null, 2)}</pre>`
    }`,
  );
}
