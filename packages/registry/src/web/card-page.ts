// The card (MCP Apps, SEP-1865): Usher's tool results as small cards in clients that render them (Claude,
// ChatGPT). One ui:// resource draws whichever card the result calls for:
//   - usher_fill / usher_confirm paused: the decision card. The site's consent wording verbatim with a
//     real checkbox each, optional opt-ins as yes/no, the submit named as the site names it, and one
//     Confirm. Where the host declares it can pass a card's tool calls to the server (serverTools),
//     Confirm calls usher_confirm itself and shows the result. Elsewhere, and whenever unsure, it
//     sends the person's own short confirmation ("Confirm: declaration yes, marketing no, get my
//     quote yes") as their message, and the agent calls usher_confirm from it.
//   - usher_confirm done: the result card. Outcome, the figures verbatim, a thumbnail.
//   - knock: the "Admit one agent" ticket, read-only.
// A result for a site with a theme (core theme.ts) carries it as `theme`: the card then shows the
// site's name, logo and colours in a band with a fixed "via Usher" mark, and its typeface and
// corners. The card checks every value against the same closed lists before using it (colours as
// #rrggbb, the typeface by id from its own list, the radius from its own list, the logo as a PNG
// data URL) and sets only its own custom properties: a theme changes how a card looks, never what
// it asks, what is ticked, what is sent, or what it says Usher is.
// The text result is unchanged and is what the model reads: nothing depends on the card rendering.
// No external resources, no network, no tracking; the card shows only the site's words and the
// user's own result.

import { RADII, RESULT_FIELDS, TYPEFACES } from '@usher/core';
import { CARD_CSS, CARD_DARK, CARD_LIGHT } from './cards.ts';

export const CARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Usher</title>
<style>
:root { ${CARD_LIGHT} --serif:"Iowan Old Style","Charter","Palatino Linotype",Palatino,Georgia,serif; color-scheme:light dark; }
@media (prefers-color-scheme: dark) { :root { ${CARD_DARK} } }
:root[data-theme="light"] { ${CARD_LIGHT} }
:root[data-theme="dark"] { ${CARD_DARK} }
* { box-sizing:border-box; }
html, body { margin:0; background:transparent; color:var(--ink); font:15px/1.5 var(--font,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif); -webkit-font-smoothing:antialiased; }
main { padding:14px; max-width:560px; }
${CARD_CSS}
</style>
<style id="brand"></style>
</head>
<body>
<main id="root" class="uc"><p class="note">Waiting for Usher…</p></main>
<script>
(function () {
  var nextId = 1, waiting = {}, root = document.getElementById('root'), caps = null;
  function send(msg) { window.parent.postMessage(msg, '*'); }
  function request(method, params) {
    var id = nextId++;
    send({ jsonrpc: '2.0', id: id, method: method, params: params });
    return new Promise(function (resolve, reject) { waiting[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) { send({ jsonrpc: '2.0', method: method, params: params }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function where(url) { try { var u = new URL(url); return u.host + u.pathname; } catch (e) { return ''; } }
  function resize() { notify('ui/notifications/size-changed', { width: Math.ceil(document.documentElement.scrollWidth), height: Math.ceil(document.documentElement.scrollHeight) }); }
  function theme(ctx) { if (ctx && (ctx.theme === 'light' || ctx.theme === 'dark')) document.documentElement.setAttribute('data-theme', ctx.theme); }

  // The site's theme, checked here against the card's own lists; anything else is no theme at all.
  var FACES = ${JSON.stringify(TYPEFACES)}, RADII = ${JSON.stringify(RADII)}, FIELDS = ${JSON.stringify(RESULT_FIELDS)}, brand = null;
  function colour(v) { return typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v); }
  function tokens(t) { return !!t && colour(t.accent) && colour(t.accent_ink) && colour(t.band) && colour(t.band_ink); }
  function brandOf(t) {
    if (!t || typeof t !== 'object' || typeof t.name !== 'string' || !t.name.trim() || t.name.length > 60) return null;
    if (!tokens(t.light) || !tokens(t.dark) || !Object.prototype.hasOwnProperty.call(FACES, t.typeface) || RADII.indexOf(t.radius) < 0) return null;
    var logo = typeof t.logo === 'string' && t.logo.length < 70000 && /^data:image\\/png;base64,[A-Za-z0-9+\\/]+={0,2}$/.test(t.logo) ? t.logo : '';
    return { name: t.name, logo: logo, light: t.light, dark: t.dark, face: FACES[t.typeface], radius: t.radius, fields: (Array.isArray(t.result_fields) ? t.result_fields : []).filter(function (f) { return FIELDS.indexOf(f) >= 0; }) };
  }
  function applyBrand(b) {
    var style = document.getElementById('brand');
    if (!b) { style.textContent = ''; return; }
    function vars(t) { return '--accent:' + t.accent + ';--btn:' + t.accent + ';--btn-ink:' + t.accent_ink + ';--band:' + t.band + ';--band-ink:' + t.band_ink + ';'; }
    style.textContent = ':root{--font:' + b.face + ';--title-font:' + b.face + ';--radius:' + b.radius + 'px;' + vars(b.light) + '}'
      + '@media (prefers-color-scheme: dark){:root{' + vars(b.dark) + '}}'
      + ':root[data-theme="light"]{' + vars(b.light) + '}:root[data-theme="dark"]{' + vars(b.dark) + '}';
  }
  // The band: the site's name and logo, and always "via Usher". Nothing of the site's but these.
  function band() {
    return brand ? '<div class="band">' + (brand.logo ? '<img alt="" src="' + brand.logo + '">' : '') + '<span class="name">' + esc(brand.name) + '</span><span class="via">via Usher</span></div>' : '';
  }

  window.addEventListener('message', function (event) {
    var m = event.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id != null && !m.method && waiting[m.id]) {
      var w = waiting[m.id]; delete waiting[m.id];
      if (m.error) w.reject(m.error); else w.resolve(m.result);
      return;
    }
    if (m.method === 'ui/notifications/tool-result') return render(m.params || {});
    if (m.method === 'ui/notifications/host-context-changed') return theme(m.params);
    if (m.method === 'ui/resource-teardown' && m.id != null) return send({ jsonrpc: '2.0', id: m.id, result: {} });
    if (m.method === 'ping' && m.id != null) return send({ jsonrpc: '2.0', id: m.id, result: {} });
  });

  function render(result) {
    var data = result.structuredContent || {};
    var image = (result.content || []).filter(function (c) { return c && c.type === 'image'; })[0];
    brand = brandOf(data.theme);
    applyBrand(brand);
    if (data.status === 'needs_decision') decisionCard(data);
    else if (data.status === 'completed' || data.status === 'stopped' || data.status === 'failed' || data.status === 'cancelled') resultCard(data, image);
    else if (data.token && data.session) ticket(data);
    else root.innerHTML = '<p class="note">Usher answered; your assistant has the details.</p>';
    resize();
  }

  // The decision card: the site's words, the user's answers, handed back to the model.
  function decisionCard(d) {
    var blocks = d.blocks || [], page = '', first = blocks.filter(function (b) { return b.source && b.source.url; })[0];
    if (first) page = where(first.source.url);
    // A plan (get_plan): the person answers once, up front, for their own assistant's browser.
    var plan = d.plan_for === 'browser';
    var html = '<div class="card">' + band() + '<p class="label">Your decision</p><h1 class="title">' + (plan ? 'Before your assistant starts' : 'Before Usher goes on') + '</h1>'
      + (page ? '<p class="where">' + esc(page) + '</p>' : plan && d.url ? '<p class="where">' + esc(where(d.url)) + '</p>' : '')
      + '<p class="asking">' + (plan ? 'Your answers go to your assistant with the plan. Usher keeps none of them.' : 'Usher is asking you, not the agent') + '</p><div id="f">';
    (d.decisions || []).forEach(function (q, i) {
      var own = blocks.filter(function (b) { return b.source && b.source.key === q.key; });
      var wording = own.filter(function (b) { return b.kind === 'consent'; });
      var text = wording[0] ? wording[0].text : q.label;
      var terms = wording.slice(1).map(function (b) { return '<div class="terms">' + esc(b.text) + (b.source.url ? '\\n<a href="#" data-open="' + esc(b.source.url) + '">' + esc(where(b.source.url)) + '</a>' : '') + '</div>'; }).join('');
      var name = 'q' + i;
      if (q.kind === 'required_consent') {
        html += '<div class="row"><label class="check"><input type="checkbox" name="' + name + '" data-key="' + esc(q.key) + '" data-kind="consent"><span class="verbatim">' + esc(text) + '<span class="tag req">required</span></span></label>' + terms + '</div>';
      } else if (q.kind === 'optional_consent') {
        html += '<div class="row"><span class="verbatim">' + esc(text) + '<span class="tag opt">optional</span></span>' + terms
          + '<div class="yesno"><label><input type="radio" name="' + name + '" value="yes" data-key="' + esc(q.key) + '" data-kind="yesno"> Yes</label><label><input type="radio" name="' + name + '" value="no" checked data-key="' + esc(q.key) + '" data-kind="yesno"> No</label></div></div>';
      } else if (q.kind === 'submit') {
        var said = own.filter(function (b) { return b.kind === 'disclosure'; }).map(function (b) { return '<p class="disclosure">' + esc(b.text) + '</p>'; }).join('');
        html += '<div class="row"><label class="check"><input type="checkbox" name="' + name + '" data-key="' + esc(q.key) + '" data-kind="consent"><span>Yes, press <b>“' + esc(q.label) + '”</b> for me</span></label>' + said + '</div>';
      } else if (q.kind === 'confirm_value') {
        // Theirs alone: what they said, put back to them, nothing chosen until they choose.
        html += '<div class="row"><span class="verbatim">' + esc(q.label) + '<span class="tag req">confirm</span></span><p class="said">You said: <b>' + esc(q.value || '') + '</b></p>'
          + '<div class="yesno"><label><input type="radio" name="' + name + '" value="yes" data-key="' + esc(q.key) + '" data-kind="yesno"> That&#39;s right</label><label><input type="radio" name="' + name + '" value="no" data-key="' + esc(q.key) + '" data-kind="yesno"> Not right</label></div></div>';
      } else if (q.options && q.options.length) {
        // The site's own options: one is chosen, nothing chosen for them.
        html += '<div class="row"><label>' + esc(q.label) + (plan && !q.required ? ' <span class="tag opt">optional</span>' : '') + '<select name="' + name + '" data-key="' + esc(q.key) + '" data-kind="value"><option value="">Choose…</option>'
          + q.options.map(function (o) { return '<option>' + esc(o) + '</option>'; }).join('') + '</select></label></div>';
      } else {
        html += '<div class="row"><label>' + esc(q.label) + (plan && !q.required ? ' <span class="tag opt">optional</span>' : '') + '<input type="text" name="' + name + '" data-key="' + esc(q.key) + '" data-kind="value" autocomplete="off"></label></div>';
      }
    });
    html += '<button type="button" id="go">Confirm</button><p class="note" id="msg">Confirm sends your answers on. Leave a required box unticked and Usher stops; nothing is submitted.</p></div></div>';
    root.innerHTML = html;
    // A plan's card may be left open while the person answers in the chat instead: ask Usher every
    // few seconds whether the plan was prepared, and if so, say so in place of the questions.
    var answeredHere = false;
    if (plan && d.plan_id && caps && caps.serverTools) {
      var polls = 0;
      var poll = setInterval(function () {
        if (answeredHere || ++polls > 450) return clearInterval(poll);
        request('tools/call', { name: 'plan_status', arguments: { plan_id: d.plan_id } }).then(function (r) {
          var status = r && r.structuredContent && r.structuredContent.status;
          if (status === 'unknown') return clearInterval(poll);
          if (status !== 'prepared' || answeredHere) return;
          clearInterval(poll);
          root.innerHTML = '<div class="card">' + band() + '<p class="label">Your decision</p><h1 class="title">Answered in the chat</h1>'
            + (d.url ? '<p class="where">' + esc(where(d.url)) + '</p>' : '')
            + '<p class="note">Your assistant has your answers and is carrying on with the plan. Nothing more to do here.</p></div>';
          resize();
        }).catch(function () { clearInterval(poll); });
      }, 4000);
    }
    // A button, not a form: sandboxed cards may not be allowed to submit forms.
    document.getElementById('go').addEventListener('click', function () {
      var answers = {}, missing = [], parts = [];
      (d.decisions || []).forEach(function (q) {
        var els = document.querySelectorAll('[data-key="' + q.key + '"]'), value;
        Array.prototype.forEach.call(els, function (el) {
          var kind = el.getAttribute('data-kind');
          if (kind === 'consent') value = el.checked;
          else if (kind === 'yesno') { if (el.checked) value = el.value === 'yes'; }
          else if (el.value.trim()) value = el.value.trim();
        });
        if (value === undefined) { if (!plan || q.required || q.kind !== 'missing_value') missing.push(q.key); return; }
        answers[q.key] = value;
        parts.push(q.short + ' ' + (typeof value === 'boolean' ? (value ? 'yes' : 'no') : '"' + value + '"'));
      });
      var msg = document.getElementById('msg');
      if (missing.length) { msg.className = 'note warn'; msg.textContent = 'Please answer every question first.'; resize(); return; }
      // The person's own confirmation, in their words: what the agent passes to usher_confirm.
      // A plan's answers aren't a confirmation for usher_confirm: they go to prepare_run.
      var phrase = (plan ? 'My answers for the Usher plan: ' : 'Confirm: ') + parts.join(', ');
      answeredHere = true;
      document.getElementById('go').disabled = true;
      function say(cls, text) { msg.className = cls; msg.textContent = text; resize(); }
      // Path 2, the default: the confirmation goes into the chat as the person's message, and the
      // agent calls usher_confirm from it. Hosts without ui/message: the person sends it themselves.
      function viaMessage() {
        if (!(caps && caps.message)) return say('note', 'Send this to your assistant: ' + phrase);
        request('ui/message', { role: 'user', content: [{ type: 'text', text: phrase }] }).then(function (r) {
          if (r && r.isError) throw new Error('rejected');
          say('note', 'Sent as your message: ' + phrase);
        }).catch(function () { say('note warn', 'Send this to your assistant: ' + phrase); });
      }
      // Path 1: hosts that let a card call its server's tools (they declare serverTools) submit from
      // here, the person's click being the authorisation, and the card shows the result.
      // A plan: the answers go to prepare_run, which hands the plan back with them in place (and, on
      // a joined site, the token for the stops the person ticked); the assistant then fills it.
      if (plan && caps && caps.serverTools) {
        var values = {}, confirmed = [];
        (d.decisions || []).forEach(function (q) {
          if (!(q.key in answers)) return;
          if (q.kind === 'missing_value') values[q.key] = answers[q.key];
          else if (answers[q.key] === true) confirmed.push(q.key);
        });
        request('tools/call', { name: 'prepare_run', arguments: { url: d.url, intent: d.intent || undefined, values: values, confirmed: confirmed } }).then(function (result) {
          if (!result || result.isError) throw new Error('refused');
          var text = (result.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('\\n');
          request('ui/update-model-context', { content: [{ type: 'text', text: 'The person answered in the Usher card and Usher prepared the run:\\n' + text }] }).catch(function () {});
          say('note', 'Done. Your assistant has the plan with your answers' + (confirmed.length ? ', and the go-ahead for ' + confirmed.length + ' stop' + (confirmed.length === 1 ? '' : 's') : '') + '.');
          if (caps && caps.message) request('ui/message', { role: 'user', content: [{ type: 'text', text: 'I answered in the Usher card. Carry on with the plan.' }] }).catch(function () {});
        }).catch(viaMessage);
        return;
      }
      if (caps && caps.serverTools) {
        request('tools/call', { name: 'usher_confirm', arguments: { id: d.id, answers: answers, confirmation: phrase } }).then(function (result) {
          if (!result || result.isError) throw new Error('refused');
          var text = (result.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('\\n');
          request('ui/update-model-context', { content: [{ type: 'text', text: 'The person confirmed in the Usher card (' + phrase + ') and Usher went on. Its result:\\n' + text }] }).catch(function () {});
          render(result);
          // The chat carries on: a short message as the person (their click), so the assistant
          // answers with the result it now has in context. Hosts without ui/message: the card alone.
          if (caps && caps.message) request('ui/message', { role: 'user', content: [{ type: 'text', text: 'I confirmed in the Usher card: ' + phrase.replace(/^Confirm: /, '') + '. What happened?' }] }).catch(function () {});
        }).catch(viaMessage);
      } else viaMessage();
    });
    bindLinks();
  }

  // The ticket: what the agent was admitted with. Structure only.
  function ticket(k) {
    var claims = {};
    try { claims = JSON.parse(atob(k.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) {}
    var map = k.map || {}, fields = (map.fields || []).length, rules = (k.rules && k.rules.actions) || {};
    var confirm = Object.keys(rules).filter(function (x) { return rules[x] === 'confirm'; });
    var forbid = Object.keys(rules).filter(function (x) { return rules[x] === 'forbid'; });
    var agent = claims.sub ? (claims.act && claims.act.sub === 'hosted' ? 'hosted ' : 'key ') + claims.sub.slice(0, 4) + '…' + claims.sub.slice(-3) + ', signed' : 'signed';
    var until = k.expires_at ? new Date(k.expires_at) : null;
    var house = (confirm.length ? 'Ask the person before ' + confirm.join(', ') + '. ' : '') + (forbid.length ? forbid.join(', ') + ' are the person\\'s alone.' : '') || 'No extra rules.';
    var purpose = (map.form && map.form.purpose) || 'A form';
    root.innerHTML = '<div class="card ticket"><div class="ticket-main">' + band() + '<p class="label">Admit one agent</p><h1 class="title">' + esc(purpose.replace(/:.*$/, '')) + '</h1>'
      + '<p class="where">' + esc(where((map.path && claims.origin) ? claims.origin + map.path : '')) + '</p><dl>'
      + '<div><dt>Agent</dt><dd>' + esc(agent) + '</dd></div>'
      + '<div><dt>Map</dt><dd>' + (map.path ? esc(map.path) + ': ' + fields + ' fields by meaning' + (k.match ? ' · ' + esc(k.match.kind) + ' match' : '') : 'No map for this page yet') + '</dd></div>'
      + '<div><dt>House rules</dt><dd>' + esc(house) + '</dd></div>'
      + '<div><dt>Valid</dt><dd>' + (until ? 'until ' + esc(until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + ', this site only' : 'this site only') + '</dd></div>'
      + '</dl></div><div class="stub"><span class="label">No.</span><b>' + esc(String(k.session).slice(-4).toUpperCase()) + '</b><span>session</span></div></div>';
  }

  // The result: outcome, the figures as the site shows them, a thumbnail. No link to the page: it
  // would open fresh, without the person's session, somewhere else than their result.
  function resultCard(r, image) {
    var res = r.result || {}, ok = r.status === 'completed';
    var facts = res.facts || [];
    // A theme chooses which parts beyond the headline figure show; without one, all of them.
    if (brand && brand.fields.indexOf('more_facts') < 0) facts = facts.slice(0, 1);
    if (brand && brand.fields.indexOf('thumbnail') < 0) image = null;
    var url = res.final_url || r.final_url || '';
    root.innerHTML = '<div class="card">' + band() + '<p class="label">' + (brand ? 'Your result' : 'Usher') + '</p><h1 class="title">' + esc(res.title || (ok ? 'Done' : 'Stopped')) + '</h1>'
      + (url ? '<p class="where">' + esc(where(url)) + '</p>' : '')
      + '<p class="outcome ' + (ok ? 'ok' : 'no') + '">' + (ok ? 'Completed' : esc(r.status)) + (r.reason ? ': ' + esc(r.reason) : '') + '</p>'
      + (facts.length ? '<ul class="facts">' + facts.map(function (f) { return '<li class="verbatim">' + esc(f) + '</li>'; }).join('') + '</ul>' : '')
      + (image && image.data ? '<img class="thumb" alt="The page Usher finished on" src="data:' + esc(image.mimeType || 'image/png') + ';base64,' + esc(image.data) + '">' : '')
      + (ok && facts.length ? '<p class="note">As the site shows it, word for word</p>' : '')
      + '</div>';
    var img = root.querySelector('img');
    if (img) img.addEventListener('load', resize);
    bindLinks();
  }

  function bindLinks() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-open]'), function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); request('ui/open-link', { url: a.getAttribute('data-open') }).catch(function () {}); });
    });
  }

  request('ui/initialize', { appInfo: { name: 'usher-card', version: '1' }, appCapabilities: {}, protocolVersion: '2026-01-26' }).then(function (r) {
    // What the host declares it supports decides Confirm's path; nothing is guessed from its name.
    caps = (r && r.hostCapabilities) || null;
    theme(r && r.hostContext);
    notify('ui/notifications/initialized', {});
    resize();
  }, function () { notify('ui/notifications/initialized', {}); });
})();
</script>
</body>
</html>`;
