// The owner's theme page (LU-58): what Usher proposed from the site (or what is in use), an editor
// for each part of the theme, "Refresh from my site", and a live preview of the three cards. The
// preview is the real card (card-page.ts), served from /card-preview.html into sandboxed frames:
// this page plays the assistant's part, sending each frame a sample result with the theme as it
// stands, so what the owner sees is what Claude and ChatGPT render.

import { RADII, RESULT_FIELDS, TYPEFACE_IDS, cardTheme, themeTokens, validateTheme, type CardTheme, type SiteTheme, type ThemeProblem } from '@usher/core';
import type { SiteThemeRecord } from '../registry.ts';
import { Raw, html, page, when } from './html.ts';

const FIELD_NAMES: Record<string, string> = { more_facts: 'Every figure on the result, not only the headline', thumbnail: 'A thumbnail of the result page (fields masked)' };
const TYPEFACE_NAMES: Record<string, string> = { system: 'System (the device\'s own)', grotesque: 'Grotesque (Helvetica, Arial)', humanist: 'Humanist (Segoe, Gill Sans)', geometric: 'Geometric (Avenir, Futura)', rounded: 'Rounded', serif: 'Serif (Charter, Georgia)' };

/** Usher's own look, as a starting point when the site has no theme yet. */
export function startingTheme(name: string): SiteTheme {
  return { name, accent: '#7434d3', second: '#191942', typeface: 'system', radius: 0, result_fields: ['more_facts', 'thumbnail'] };
}

/** The theme the editor shows: what is proposed, else what is in use, else Usher's own. */
export function editing(record: SiteThemeRecord, name: string): SiteTheme {
  return record.proposed ?? record.approved ?? startingTheme(name);
}

/** The theme from the editor's form: the logo by choice (none, the current one, or a candidate), the rest as given. */
export function themeFromForm(form: URLSearchParams, record: SiteThemeRecord, name: string): { theme: SiteTheme } | { problems: ThemeProblem[] } {
  const current = editing(record, name);
  const choice = form.get('logo') ?? 'current';
  const candidate = /^c(\d+)$/.exec(choice);
  const logo = choice === 'none' ? undefined : candidate ? record.derived?.candidates.logos[Number(candidate[1])] : current.logo;
  return validateTheme({
    name: form.get('name') ?? '',
    ...(logo && { logo }),
    accent: form.get('accent') ?? '',
    second: form.get('second') ?? '',
    typeface: form.get('typeface') ?? '',
    radius: form.get('radius') ?? '',
    result_fields: form.getAll('result_fields'),
  });
}

/** What the preview needs back: the card theme, and where contrast moved a colour. */
export function previewOf(checked: { theme: SiteTheme } | { problems: ThemeProblem[] }): { theme: CardTheme; notes: string[] } | { problems: ThemeProblem[] } {
  if ('problems' in checked) return checked;
  return { theme: cardTheme(checked.theme), notes: contrastNotes(checked.theme) };
}

function contrastNotes(theme: SiteTheme): string[] {
  const notes: string[] = [];
  for (const mode of ['light', 'dark'] as const) {
    const t = themeTokens(theme, mode);
    if (t.accent !== theme.accent) notes.push(`On ${mode} cards the accent is ${t.accent}, the nearest to ${theme.accent} that is readable there.`);
    if (t.band !== theme.second) notes.push(`On ${mode} cards the band is ${t.band}, the nearest to ${theme.second} that its text is readable on.`);
  }
  return notes;
}

/** Sample results for the three cards, from the site's own journey where there is one. Not anyone's data. */
export function previewSamples(origin: string, journey: { title: string; start: string } | undefined, shot?: string): Record<'ticket' | 'decision' | 'result', { structuredContent: Record<string, unknown>; content?: unknown[] }> {
  const path = journey ? new URL(journey.start, origin).pathname : '/';
  const title = journey?.title ? journey.title.replace(/^(.)/, (c) => c.toUpperCase()) : 'Your form';
  const claims = { sub: 'h0sted0example0agent', act: { sub: 'hosted' }, origin };
  const token = `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.preview`;
  const image = shot && /^data:image\/jpeg;base64,/.test(shot) ? [{ type: 'image', mimeType: 'image/jpeg', data: shot.slice('data:image/jpeg;base64,'.length) }] : [];
  return {
    ticket: { structuredContent: { token, session: 's_preview0000PRVW', expires_at: new Date(Date.now() + 600_000).toISOString(), map: { path, form: { purpose: title }, fields: new Array(12).fill({}) }, rules: { actions: { 'consent.declaration': 'confirm', 'form.submit': 'confirm', 'account.password': 'forbid' } }, match: { kind: 'exact' } } },
    decision: {
      structuredContent: {
        status: 'needs_decision',
        id: 'f_preview',
        decisions: [
          { key: 'person.smoker', label: 'Have you smoked in the last 12 months? (example)', kind: 'confirm_value', value: 'No', page: path, short: 'smoker' },
          { key: 'consent.declaration', label: 'Declaration', kind: 'required_consent', page: path, short: 'declaration' },
          { key: 'consent.marketing', label: 'Marketing', kind: 'optional_consent', page: path, short: 'marketing' },
          { key: 'form.submit', label: 'Get my quote', kind: 'submit', page: path, short: 'get my quote' },
        ],
        blocks: [
          { kind: 'consent', text: 'Example wording: I confirm the information I have given is true and complete to the best of my knowledge.', verbatim: true, source: { key: 'consent.declaration', url: `${origin}${path}` } },
          { kind: 'consent', text: 'Example wording: send me offers by email.', verbatim: true, source: { key: 'consent.marketing', url: `${origin}${path}` } },
        ],
      },
    },
    result: { structuredContent: { status: 'completed', id: 'f_preview', result: { title: `${title} (example)`, final_url: `${origin}${path}`, facts: ['£66.92 a month', 'Comprehensive cover, £250 excess', 'Example figures, not a real quote'] } }, content: image },
  };
}

/** Serialised for a <script type="application/json">: nothing in it can close the element. */
const embed = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

/** The dashboard card: what the cards look like now, and where to change it. */
export function themeCard(record: SiteThemeRecord, busy: boolean): Raw {
  const status = record.approved
    ? html`In use since ${when(record.approved_at)}${record.proposed ? html`; a new proposal is waiting for you` : ''}.`
    : record.proposed
      ? html`Usher proposed one from your site ${when(record.derived?.at)}. It isn't used until you accept it.`
      : busy
        ? html`Usher is reading your site now.`
        : html`None yet: your cards show Usher's own look.`;
  return html`<div class="card"><h2>Your assistant app's look</h2>
<p>Your name, logo and colours on the cards Claude and ChatGPT show your customers. ${status}</p>
<p><a class="button" href="/dashboard/theme">${record.approved || record.proposed ? 'See and adjust' : 'Set it up'}</a></p></div>`;
}

export const THEME_STYLE = `
.theme-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.1fr); gap:22px; align-items:start; }
.previews { display:grid; gap:14px; position:sticky; top:12px; }
.previews iframe { width:100%; border:1px solid var(--line); border-radius:10px; background:var(--card); height:260px; display:block; }
.previews .modes { display:flex; gap:12px; font-size:14px; align-items:center; }
.swatches { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0 0; }
.swatches button { width:26px; height:26px; padding:0; border:1px solid var(--line); border-radius:6px; cursor:pointer; }
.logos { display:flex; flex-wrap:wrap; gap:10px; }
.logos label { display:flex; gap:6px; align-items:center; border:1px solid var(--line); border-radius:8px; padding:6px 10px; }
.logos img { max-height:32px; max-width:140px; display:block; }
.shot { max-width:100%; border:1px solid var(--line); border-radius:8px; }
.theme-form label { display:block; margin:12px 0 0; }
.theme-form > label > input[name=name], .theme-form > label > select { display:block; width:100%; max-width:22em; margin-top:4px; font:inherit; padding:6px 8px; }
.theme-form fieldset { margin:14px 0 0; }
.theme-form input[type=color] { width:56px; height:34px; padding:0 2px; vertical-align:middle; }
.theme-form .hex { width:7.5em; font-family:ui-monospace,monospace; }
#notes:empty { display:none; }
@media (max-width:900px) { .theme-grid { grid-template-columns:minmax(0,1fr); } .previews { position:static; } }
`;

export function themePage(input: {
  origin: string;
  record: SiteThemeRecord;
  name: string;
  journey?: { title: string; start: string };
  refusal: string | null;
  busy: boolean;
  notice?: Raw | string;
  problems?: ThemeProblem[];
  form?: SiteTheme;
}): string {
  const { record } = input;
  const theme = input.form ?? editing(record, input.name);
  const derived = record.derived;
  const candidates = derived?.candidates;
  const colours = [...new Map((candidates?.colours ?? []).map((c) => [c.hex, c])).values()].slice(0, 14);
  const swatches = (field: 'accent' | 'second') =>
    colours.length ? html`<span class="swatches" aria-label="Colours from your site">${colours.map((c) => html`<button type="button" data-swatch="${c.hex}" data-for="${field}" title="${c.hex}: ${c.role}" style="background:${c.hex}"></button>`)}</span>` : '';
  const colour = (field: 'accent' | 'second', label: string, hint: string) =>
    html`<label>${label} <input type="color" data-pair="${field}" value="${theme[field]}"> <input class="hex" name="${field}" value="${theme[field]}" pattern="#[0-9a-fA-F]{6}" required><br><small class="muted">${hint}</small></label>${swatches(field)}`;
  const status = record.approved && !record.proposed
    ? html`<p>This look is <b>in use</b> on your cards, since ${when(record.approved_at)}.</p>`
    : record.proposed
      ? html`<p>Usher <b>proposed</b> this from your site. It isn't used on your cards until you accept it.</p>`
      : html`<p>Your cards use Usher's own look until you set yours.</p>`;
  const how = derived
    ? html`<p class="small muted">Read ${when(derived.at)} from ${derived.candidates.pages.join(' and ')} in ${(derived.ms / 1000).toFixed(1)} s; chosen by ${derived.by === 'code' ? 'simple rules (no model was available)' : derived.by}${derived.why ? html`: ${derived.why}` : '.'}</p>`
    : '';
  const problems = input.problems?.length ? html`<div class="card error">${input.problems.map((p) => html`<p>${p.message}</p>`)}</div>` : '';
  const body = html`<h1>Your assistant app's look</h1>
<p class="lede">How the cards look when someone uses your site through Claude, ChatGPT or another assistant: your name, logo, colours, typeface and corners. What the cards do never changes: Usher asks your customer, not the assistant; consents start unticked; your wording is shown word for word; nothing is submitted until they say so; and every card says "via Usher".</p>
${input.notice ? html`<div class="card notice">${input.notice}</div>` : ''}${problems}
<div class="theme-grid">
<div>
<div class="card">${status}${how}
<form method="post" action="/dashboard/theme/refresh">${input.refusal ? html`<button type="submit" disabled>Refresh from my site</button> <span class="small muted">${input.refusal}</span>` : input.busy ? html`<button type="submit" disabled>Reading your site…</button>` : html`<button type="submit">Refresh from my site</button> <span class="small muted">Usher opens your home page and your form in its own browser and proposes a look. Nothing changes until you accept it.</span>`}</form>
</div>
<form class="card theme-form" id="theme-form" method="post" action="/dashboard/theme">
<label>Name on the cards<input name="name" value="${theme.name}" maxlength="60" required></label>
<fieldset><legend>Logo</legend><div class="logos">
<label><input type="radio" name="logo" value="none"${theme.logo ? '' : ' checked'}> No logo, the name only</label>
${theme.logo ? html`<label><input type="radio" name="logo" value="current" checked> <img alt="The current logo" src="${theme.logo}"></label>` : ''}
${(candidates?.logos ?? []).filter((l) => l !== theme.logo).map((l) => html`<label><input type="radio" name="logo" value="c${candidates!.logos.indexOf(l)}"> <img alt="A logo from your site" src="${l}"></label>`)}
</div><small class="muted">Only images from your own pages, captured by Usher's browser, at most 48 KB.</small></fieldset>
${colour('accent', 'Accent', 'Buttons, ticks and the title\'s full stop.')}
${colour('second', 'Second colour', 'The band at the top of each card, with your name.')}
<label>Typeface<select name="typeface">${TYPEFACE_IDS.map((t) => html`<option value="${t}"${t === theme.typeface ? ' selected' : ''}>${TYPEFACE_NAMES[t] ?? t}</option>`)}</select></label>
<label>Corners<select name="radius">${RADII.map((r) => html`<option value="${r}"${r === theme.radius ? ' selected' : ''}>${r === 0 ? 'Square' : `${r} px`}</option>`)}</select></label>
<fieldset><legend>On the result card</legend><p class="small muted">The headline figure always shows.</p>${RESULT_FIELDS.map((f) => html`<label><input type="checkbox" name="result_fields" value="${f}"${theme.result_fields.includes(f) ? ' checked' : ''}> ${FIELD_NAMES[f] ?? f}</label>`)}</fieldset>
<div id="notes" class="small muted" aria-live="polite"></div>
<p><button type="submit">${record.approved && !record.proposed ? 'Save changes' : 'Accept and use this look'}</button></p>
</form>
${derived?.shot ? html`<details class="card"><summary>What Usher looked at</summary><p class="small muted">Your home page as Usher's browser saw it, every field greyed out.</p><img class="shot" alt="Your home page, fields masked" src="${derived.shot}"></details>` : ''}
</div>
<div class="previews">
<div class="modes"><b>Preview</b><label><input type="radio" name="preview-mode" value="light" checked> Light</label><label><input type="radio" name="preview-mode" value="dark"> Dark</label></div>
${(['decision', 'result', 'ticket'] as const).map((k) => html`<iframe sandbox="allow-scripts" data-src="/card-preview.html" data-kind="${k}" title="Preview of the ${k} card"></iframe>`)}
<p class="small muted">The real cards, with example content. Assistants show them at about this width.</p>
</div>
</div>
<script type="application/json" id="samples">${new Raw(embed(previewSamples(input.origin, input.journey, derived?.shot)))}</script>
<script type="application/json" id="initial">${new Raw(embed(previewOf(validateTheme(theme))))}</script>`;
  return page('Your assistant app\'s look', body, { scripts: ['/theme.js'], style: THEME_STYLE });
}

/** Plays the assistant's part for the preview frames, and keeps the colour pickers and text in step. */
export const THEME_JS = `(function () {
  var form = document.getElementById('theme-form');
  if (!form) return;
  var samples = JSON.parse(document.getElementById('samples').textContent);
  var current = JSON.parse(document.getElementById('initial').textContent);
  var frames = Array.prototype.slice.call(document.querySelectorAll('iframe[data-kind]'));
  var mode = 'light', ready = [];
  function post(frame, msg) { frame.contentWindow.postMessage(msg, '*'); }
  function sample(frame) {
    var s = samples[frame.getAttribute('data-kind')];
    var structured = Object.assign({}, s.structuredContent);
    if (current && current.theme) structured.theme = current.theme;
    return { structuredContent: structured, content: s.content || [] };
  }
  function show(frame) { post(frame, { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: sample(frame) }); }
  window.addEventListener('message', function (event) {
    var frame = frames.filter(function (f) { return f.contentWindow === event.source; })[0];
    var m = event.data;
    if (!frame || !m || m.jsonrpc !== '2.0') return;
    if (m.method === 'ui/initialize') post(frame, { jsonrpc: '2.0', id: m.id, result: { hostCapabilities: {}, hostContext: { theme: mode } } });
    else if (m.method === 'ui/notifications/initialized') { if (ready.indexOf(frame) < 0) ready.push(frame); show(frame); }
    else if (m.method === 'ui/notifications/size-changed' && m.params && m.params.height) frame.style.height = Math.min(900, Math.max(120, m.params.height + 4)) + 'px';
    else if (m.id != null && m.method) post(frame, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Preview only' } });
  });
  var notes = document.getElementById('notes'), timer;
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      fetch('/dashboard/theme/preview', { method: 'POST', body: new URLSearchParams(new FormData(form)), credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (r) {
        if (r.problems) { notes.textContent = r.problems.map(function (p) { return p.message; }).join(' '); return; }
        current = r;
        notes.textContent = (r.notes || []).join(' ');
        ready.forEach(show);
      }).catch(function () {});
    }, 200);
  }
  Array.prototype.forEach.call(document.querySelectorAll('input[type=color][data-pair]'), function (picker) {
    var text = form.querySelector('input[name="' + picker.getAttribute('data-pair') + '"]');
    picker.addEventListener('input', function () { text.value = picker.value; refresh(); });
    text.addEventListener('input', function () { if (/^#[0-9a-fA-F]{6}$/.test(text.value)) picker.value = text.value.toLowerCase(); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-swatch]'), function (b) {
    b.addEventListener('click', function () {
      var field = b.getAttribute('data-for');
      form.querySelector('input[name="' + field + '"]').value = b.getAttribute('data-swatch');
      form.querySelector('input[data-pair="' + field + '"]').value = b.getAttribute('data-swatch');
      refresh();
    });
  });
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  Array.prototype.forEach.call(document.querySelectorAll('input[name=preview-mode]'), function (r) {
    r.addEventListener('change', function () {
      mode = r.value;
      ready.forEach(function (f) { post(f, { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: mode } }); });
    });
  });
  if (current && current.notes) notes.textContent = current.notes.join(' ');
  // Loaded only now, so every frame's hello reaches a listener.
  frames.forEach(function (f) { f.src = f.getAttribute('data-src'); });
})();
`;
