// The public map viewer (LU-38): paste a URL, see the map Usher builds for its form. Compiles are
// rate limited and cached by fingerprint digest; failures say why in plain words.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Browser } from 'playwright';
import { CompileError, VIEWPORT, compilePage, fingerprint, mapFromLabels, pickForm, scanScript, type ChatFn, type Scan, type UsherMap } from '@usher/core';
import { RateLimiter } from '../rate-limit.ts';
import type { MapRecord, Storage } from '../storage.ts';
import { html, page, riskBadge, when, type Raw } from './html.ts';

export type ViewerFailure = 'invalid_url' | 'private_address' | 'unreachable' | 'http_error' | 'timeout' | 'no_form' | 'no_model' | 'labels_invalid' | 'rate_limited';

export type ViewerResult =
  | { ok: true; map: UsherMap; cached: boolean; model: string; cost_usd: number | null; ms: number }
  | { ok: false; reason: ViewerFailure; message: string };

export interface ViewerOptions {
  storage: Storage;
  chat?: ChatFn;
  model?: string;
  /** Allow localhost and private networks (for local demos). */
  allowPrivate?: boolean;
  timeoutMs?: number;
}

interface CachedLabels {
  labels: unknown;
  model: string;
  created_at: string;
}

function isPrivate(address: string): boolean {
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    return a === '::1' || a === '::' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80') || a.startsWith('::ffff:127.') || a.startsWith('::ffff:10.') || a.startsWith('::ffff:192.168.');
  }
  const [a, b] = address.split('.').map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
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

  async compile(input: string, client: string): Promise<ViewerResult> {
    const fail = (reason: ViewerFailure, message: string): ViewerResult => ({ ok: false, reason, message });
    let url: URL;
    try {
      url = new URL(input.trim().match(/^https?:\/\//i) ? input.trim() : `https://${input.trim()}`);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    } catch {
      return fail('invalid_url', 'That is not a web address. Try something like https://example.com/contact.');
    }
    if (!this.options.allowPrivate) {
      const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
      if (!addresses.length) return fail('unreachable', `${url.hostname} could not be found.`);
      if (addresses.some((a) => isPrivate(a.address))) return fail('private_address', 'The viewer only opens public websites.');
    }
    if (!this.perClient.wouldAllow(client) || !this.overall.wouldAllow('all')) return fail('rate_limited', 'Too many maps compiled recently. Try again in a while.');

    const started = performance.now();
    const context = await (await this.getBrowser()).newContext({ viewport: VIEWPORT });
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
      this.perClient.allow(client);
      this.overall.allow('all');

      // Same structure as before: reuse the labels, locate again on this page.
      const digest = (await fingerprint(pickForm(scan).elements)).digest;
      const cached = await this.options.storage.getCached<CachedLabels>('viewer-labels', digest);
      if (cached) {
        const map = await mapFromLabels(tab, cached.labels, { compiler: cached.model, created_at: cached.created_at });
        if (map) return { ok: true, map, cached: true, model: cached.model, cost_usd: 0, ms: Math.round(performance.now() - started) };
      }
      if (!this.options.chat || !this.options.model) return fail('no_model', 'This registry has no model configured to compile maps.');
      try {
        const result = await compilePage(tab, { chat: this.options.chat, model: this.options.model });
        await this.options.storage.putCached('viewer-labels', digest, { labels: result.labels, model: result.model, created_at: result.map.provenance.created_at } satisfies CachedLabels);
        return { ok: true, map: result.map, cached: false, model: result.model, cost_usd: result.cost_usd, ms: Math.round(performance.now() - started) };
      } catch (err) {
        if (err instanceof CompileError) return fail('labels_invalid', 'The model could not label this form reliably, so no map was made.');
        throw err;
      }
    } finally {
      await context.close();
    }
  }
}

export function viewerPage(options: { url?: string; error?: { reason: string; message: string } } = {}): string {
  return page(
    'Map viewer',
    html`<h1>Map viewer</h1>
<p class="lede">Paste the address of a page with a form. Usher reads its structure, never anything typed, and Muse Spark labels what each field means and how risky it is to act on. Nothing is submitted.</p>
<form class="inline card" method="post" action="/viewer">
  <input type="url" name="url" required placeholder="https://example.com/contact" value="${options.url ?? ''}" aria-label="Page address">
  <button type="submit">Build the map</button>
</form>
${options.error ? html`<div class="card error"><b>No map.</b> ${options.error.message} <span class="muted small">(${options.error.reason})</span></div>` : ''}`,
  );
}

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
export function mapPage(map: UsherMap, info: { source: string; record?: MapRecord }): string {
  const drift = info.record?.drift;
  return page(
    map.form.purpose,
    html`<p class="muted small"><a href="/viewer">Map viewer</a> · ${map.origin}${map.path}</p>
<h1>${map.form.purpose}</h1>
<p class="lede">${map.form.intent ? html`Intent <code>${map.form.intent}</code> · ` : ''}${map.fields.length} fields, ${map.actions.length} actions · ${info.source}</p>
${drift ? html`<div class="card warn"><b>Drifted.</b> The live form no longer matches this map (similarity ${drift.score}), reported ${when(drift.at)}.</div>` : ''}
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
<h2>Fingerprint</h2>
<div class="card"><p class="mono small">${map.fingerprint.digest}</p><p class="small muted">${map.fingerprint.signature.length} element signatures: ${map.fingerprint.signature.join(' ')}</p></div>
<h2>Raw map</h2>
<pre>${JSON.stringify(map, null, 2)}</pre>`,
  );
}
