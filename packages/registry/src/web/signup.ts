// Self-serve site signup (LU-54): four steps, no passwords. 1 enter the site's address and get both
// keys, shown once; 2 copy the tag; 3 claim the domain, checked live; 4 the dashboard, signed in.
// And "lost your secret key?": a new key only after a fresh claim check. Everything here is written
// for site owners: plain words, none of the protocol's own.

import type { Raw } from './html.ts';
import { html, page } from './html.ts';
import { claimInstructions } from '../registry.ts';

export const STEPS = ['Your keys', 'The tag', 'Prove it\'s yours', 'Done'] as const;

function steps(current: number): Raw {
  return html`<ol class="steps">${STEPS.map((s, i) => html`<li class="${i + 1 === current ? 'now' : i + 1 < current ? 'done' : ''}">${i + 1}. ${s}</li>`)}</ol>`;
}

const STEP_STYLE = html`<style>
ol.steps { list-style:none; display:flex; flex-wrap:wrap; gap:6px 16px; padding:0; margin:0 0 18px; color:var(--muted); font-size:15px; }
ol.steps li.now { color:var(--ink); font-weight:700; } ol.steps li.done { color:var(--accent); }
label.block { display:block; font-weight:600; margin:0 0 12px; } label.block input { display:block; width:100%; margin-top:4px; }
</style>`;

export function startPage(o: { origin?: string; error?: Raw | string } = {}): string {
  return page(
    'Get your keys',
    html`${STEP_STYLE}${steps(1)}
<h1>Make your forms agent-ready</h1>
<p class="lede">Enter your site's address. You'll get two keys, add one tag to your pages, and show that the site is yours. No password, no account.</p>
${o.error ? html`<div class="card error">${o.error}</div>` : ''}
<form class="card" method="post" action="/sites/new">
<label class="block">Your site's address<input type="url" name="origin" required placeholder="https://www.example.com" value="${o.origin ?? ''}"></label>
<button type="submit">Get my keys</button>
</form>
<p class="small muted">Already have keys? <a href="/dashboard">Sign in</a>. Lost your secret key? <a href="/sites/lost">Get a new one</a>.</p>`,
  );
}

/** Both keys, once. The download posts them back to be returned as a file; nothing is kept but the secret's hash. */
export function keysPage(o: { origin: string; siteKey: string; secretKey: string; reissued?: boolean }): string {
  return page(
    'Your keys',
    html`${STEP_STYLE}${o.reissued ? '' : steps(1)}
<h1>${o.reissued ? 'Your new secret key' : 'Your keys'}</h1>
<p class="lede">For ${o.origin}.</p>
<div class="card warn"><b>Save your secret key now. It is not shown again.</b> We keep only a scrambled copy, so we can't show it to you later.${o.reissued ? ' Your old secret key no longer works.' : ''}</div>
<div class="card">
<p><b>Site key</b> (public: it goes in the tag on your pages)</p>
<pre class="key">${o.siteKey}</pre>
<p><b>Secret key</b> (private: it signs you in to your dashboard)</p>
<pre class="key">${o.secretKey}</pre>
<form method="post" action="/sites/new/keys"><input type="hidden" name="origin" value="${o.origin}"><input type="hidden" name="site_key" value="${o.siteKey}"><input type="hidden" name="secret_key" value="${o.secretKey}"><button type="submit" class="secondary">Download both keys</button></form>
</div>
<p><a class="button" href="${o.reissued ? '/dashboard' : '/sites/new/tag'}">${o.reissued ? 'Open your dashboard' : 'Next: the tag'}</a></p>`,
  );
}

export function keysFile(o: { origin: string; siteKey: string; secretKey: string }): string {
  return `Usher keys for ${o.origin}\n\nSite key (public; goes in the tag on your pages):\n${o.siteKey}\n\nSecret key (private; signs you in to your dashboard; keep it safe):\n${o.secretKey}\n`;
}

export function tagPage(o: { url: string; siteKey: string }): string {
  const tag = `<script src="${o.url}/usher.js"\n        data-usher-registry="${o.url}"\n        data-usher-site-key="${o.siteKey}" defer></script>`;
  return page(
    'The tag',
    html`${STEP_STYLE}${steps(2)}
<h1>Add the tag</h1>
<p class="lede">Put this in the pages that have your forms, before <code>&lt;/head&gt;</code>:</p>
<pre>${tag}</pre>
<div class="card"><p>It shows agents where to knock and records what agents that knock do on your forms; it never tracks people and never sees what anyone types.</p></div>
<p><a class="button" href="/sites/new/claim">Next: prove it's yours</a></p>`,
  );
}

/** What a failed claim check found, in plain words. */
export function explainClaim(origin: string, tried: { method: string; result: string }[]): string[] {
  const c = claimInstructions({ origin, site_key: '' });
  return tried.map(({ method, result }) => {
    if (/private or local/.test(result)) return `${origin} is a local or private address, which can't be checked from the internet.`;
    if (method === 'well-known') {
      if (/^HTTP 404/.test(result)) return `There's no file at ${c.well_known.url} yet (your site said "not found").`;
      if (/^HTTP (\d+)/.test(result)) return `Your site answered ${c.well_known.url} with an error (${result.replace('HTTP ', 'code ')}).`;
      if (/does not contain/.test(result)) return `The file at ${c.well_known.url} is there, but it doesn't contain your site key.`;
      if (/not JSON/.test(result)) return `The file at ${c.well_known.url} is there, but it isn't the text shown above.`;
      return `We couldn't reach ${c.well_known.url}.`;
    }
    if (/no TXT records$/.test(result)) return `There's no TXT record at ${c.dns.name} yet. New DNS records can take a while to appear.`;
    if (/with this site key/.test(result)) return `There are TXT records at ${c.dns.name}, but none with your site key.`;
    return `The DNS check didn't pass (${result}).`;
  });
}

/** Step 3, which is also what the dashboard shows until the claim passes. */
export function claimPage(o: { url: string; site: { origin: string; site_key: string }; failure?: string[]; fromDashboard?: boolean }): string {
  const c = claimInstructions(o.site);
  const tag = `<script src="${o.url}/usher.js" data-usher-registry="${o.url}" data-usher-site-key="${o.site.site_key}" defer></script>`;
  return page(
    'Prove it\'s yours',
    html`${STEP_STYLE}${o.fromDashboard ? html`<form method="post" action="/dashboard/logout" style="float:right"><button class="secondary">Sign out</button></form>` : ''}${steps(3)}
<h1>${o.fromDashboard ? html`Almost there: prove ${o.site.origin} is yours` : html`Prove ${o.site.origin} is yours`}</h1>
<p class="lede">${o.fromDashboard ? 'Your dashboard opens once this check passes. ' : ''}Do either of these, then press Check now. We check again every day; if it stops passing three days running, the dashboard closes until it passes again.</p>
${o.failure ? html`<div class="card error"><b>Not yet.</b><ul>${o.failure.map((f) => html`<li>${f}</li>`)}</ul></div>` : ''}
<div class="card"><h2>Put a file on your site</h2>
<p>Make this address on your site, <a href="${c.well_known.url}">${c.well_known.url}</a>, return exactly this text:</p>
<pre>${JSON.stringify(c.well_known.content, null, 2)}</pre></div>
<div class="card"><h2>Or add a DNS record</h2>
<p>Where you manage your domain, add a <b>TXT</b> record:</p>
<table><tbody><tr><th>Name</th><td><code>${c.dns.name}</code></td></tr><tr><th>Value</th><td><code>${c.dns.value}</code></td></tr></tbody></table></div>
<form method="post" action="${o.fromDashboard ? '/dashboard/verify' : '/sites/new/claim'}"><button type="submit">Check now</button></form>
${o.fromDashboard ? html`<h2>Still to do</h2><p>If you haven't yet, add the tag to the pages with your forms:</p><pre>${tag}</pre>` : ''}`,
  );
}

export function lostPage(o: { origin?: string; error?: Raw | string; failure?: string[]; site?: { origin: string; site_key: string } } = {}): string {
  const c = o.site ? claimInstructions(o.site) : null;
  return page(
    'Lost your secret key?',
    html`${STEP_STYLE}<h1>Lost your secret key?</h1>
<p class="lede">You can get a new one by showing again that the site is yours: the file on your site or the DNS record you set up when you got your keys. If you removed them, put them back first.</p>
${o.error ? html`<div class="card error">${o.error}</div>` : ''}
${o.failure ? html`<div class="card error"><b>We couldn't confirm the site is yours.</b><ul>${o.failure.map((f) => html`<li>${f}</li>`)}</ul></div>` : ''}
${c ? html`<div class="card"><p>The file at <code>${c.well_known.url}</code>:</p><pre>${JSON.stringify(c.well_known.content, null, 2)}</pre><p>Or a TXT record at <code>${c.dns.name}</code> with the value <code>${c.dns.value}</code>.</p></div>` : ''}
<form class="card" method="post" action="/sites/lost">
<label class="block">Your site's address<input type="url" name="origin" required placeholder="https://www.example.com" value="${o.origin ?? ''}"></label>
<button type="submit">Check and give me a new key</button>
</form>`,
  );
}

/** Plain words for what registering said, on the start page. */
export function explainRegistration(code: string, message: string, origin: string): Raw | string {
  if (code === 'site_exists' && /claimed/.test(message) && !/waiting/.test(message)) return html`${origin} already has keys. <a href="/dashboard">Sign in</a>, or if you've lost the secret key, <a href="/sites/lost">get a new one</a>.`;
  if (code === 'site_exists') return `Someone started setting up ${origin} recently and hasn't finished. If that was you, sign in with the secret key you were given; otherwise try again tomorrow.`;
  return 'Enter the address of your site, like https://www.example.com, with nothing after the domain.';
}
