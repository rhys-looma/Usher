// MCP Apps (SEP-1865): Usher's tool results as small cards in clients that render them (Claude,
// ChatGPT). One ui:// resource draws whichever card the result calls for:
//   - usher_fill / usher_confirm paused: the decision card. The site's consent wording verbatim with a
//     real checkbox each, optional opt-ins as yes/no, the submit named as the site names it, and one
//     Confirm. Confirm hands the answers back to the model (ui/message, ui/update-model-context) for
//     usher_confirm; the card never calls a tool itself, because ChatGPT doesn't let a card do that.
//   - usher_confirm done: the result card. Outcome, the figures verbatim, a thumbnail, a link.
//   - knock: the "Admit one agent" ticket, read-only.
// The text result is unchanged and is what the model reads: nothing depends on the card rendering.
// No external resources, no network, no tracking; the card shows only the site's words and the
// user's own result.

import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CARD_CSS, CARD_DARK, CARD_LIGHT } from '../../registry/src/web/cards.ts';

export const CARD_URI = 'ui://usher/card.html';
export const CARD_MIME = 'text/html;profile=mcp-app';

/** Tool metadata that links a tool's results to the card (the standard key and ChatGPT's alias). */
export const CARD_META = { ui: { resourceUri: CARD_URI }, 'openai/outputTemplate': CARD_URI };

/** Claude's dedicated origin for a server's views: the first 32 hex characters of sha256(server URL). */
export function claudeDomain(serverUrl: string): string {
  return `${createHash('sha256').update(serverUrl).digest('hex').slice(0, 32)}.claudemcpcontent.com`;
}

/**
 * Registers the card. `serverUrl`, for a server reached over HTTP (hosted), gives Claude its
 * dedicated origin for the card; a local stdio server has none, and the host's default applies.
 */
export function registerCards(server: McpServer, options: { serverUrl?: string } = {}): void {
  server.registerResource(
    'usher-card',
    CARD_URI,
    { title: 'Usher card', description: 'Usher\'s decisions, ticket and result as a small card.', mimeType: CARD_MIME, _meta: { ui: { prefersBorder: true } } },
    async () => {
      const client = server.server.getClientVersion()?.name ?? '';
      const domain = options.serverUrl && /claude/i.test(client) ? claudeDomain(options.serverUrl) : undefined;
      return { contents: [{ uri: CARD_URI, mimeType: CARD_MIME, text: CARD_HTML, _meta: { ui: { prefersBorder: true, csp: {}, ...(domain && { domain }) } } }] };
    },
  );
}

const CARD_HTML = `<!doctype html>
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
html, body { margin:0; background:transparent; color:var(--ink); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
main { padding:14px; max-width:560px; }
${CARD_CSS}
</style>
</head>
<body>
<main id="root" class="uc"><p class="note">Waiting for Usher…</p></main>
<script>
(function () {
  var nextId = 1, waiting = {}, root = document.getElementById('root');
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
    var html = '<div class="card"><p class="label">Your decision</p><h1 class="title">Before Usher goes on</h1>'
      + (page ? '<p class="where">' + esc(page) + '</p>' : '')
      + '<p class="asking">Usher is asking you, not the agent</p><div id="f">';
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
      } else {
        html += '<div class="row"><label>' + esc(q.label) + '<input type="text" name="' + name + '" data-key="' + esc(q.key) + '" data-kind="value" autocomplete="off"></label></div>';
      }
    });
    html += '<button type="button" id="go">Confirm</button><p class="note" id="msg">Your answers go back to your assistant, which passes them to Usher. Leave a required box unticked and Usher stops; nothing is submitted.</p></div></div>';
    root.innerHTML = html;
    // A button, not a form: sandboxed cards may not be allowed to submit forms.
    document.getElementById('go').addEventListener('click', function () {
      var answers = {}, missing = [];
      Array.prototype.forEach.call(document.querySelectorAll('[data-key]'), function (el) {
        var key = el.getAttribute('data-key'), kind = el.getAttribute('data-kind');
        if (kind === 'consent') answers[key] = el.checked;
        else if (kind === 'yesno') { if (el.checked) answers[key] = el.value === 'yes'; }
        else { if (el.value.trim()) answers[key] = el.value.trim(); else missing.push(key); }
      });
      var msg = document.getElementById('msg');
      if (missing.length) { msg.className = 'note warn'; msg.textContent = 'Please answer every question first.'; resize(); return; }
      var payload = { usher_confirm: { id: d.id, answers: answers } };
      var text = 'My answers to Usher\\'s questions, from the Usher card. Pass them to usher_confirm exactly as they are: ' + JSON.stringify(payload.usher_confirm);
      document.getElementById('go').disabled = true;
      request('ui/update-model-context', { content: [{ type: 'text', text: text }], structuredContent: payload }).catch(function () {});
      // content is a list of blocks (the SDK's schema; the spec's prose shows one block).
      request('ui/message', { role: 'user', content: [{ type: 'text', text: text }] }).then(function (r) {
        if (r && r.isError) throw new Error('rejected');
        msg.className = 'note'; msg.textContent = 'Sent to your assistant.'; resize();
      }).catch(function () {
        msg.className = 'note warn'; msg.textContent = 'Your assistant didn\\'t take the answers here. Tell it in the chat instead.'; document.getElementById('go').disabled = false; resize();
      });
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
    root.innerHTML = '<div class="card ticket"><div class="ticket-main"><p class="label">Admit one agent</p><h1 class="title">' + esc(purpose.replace(/:.*$/, '')) + '</h1>'
      + '<p class="where">' + esc(where((map.path && claims.origin) ? claims.origin + map.path : '')) + '</p><dl>'
      + '<div><dt>Agent</dt><dd>' + esc(agent) + '</dd></div>'
      + '<div><dt>Map</dt><dd>' + (map.path ? esc(map.path) + ': ' + fields + ' fields by meaning' + (k.match ? ' · ' + esc(k.match.kind) + ' match' : '') : 'No map for this page yet') + '</dd></div>'
      + '<div><dt>House rules</dt><dd>' + esc(house) + '</dd></div>'
      + '<div><dt>Valid</dt><dd>' + (until ? 'until ' + esc(until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + ', this site only' : 'this site only') + '</dd></div>'
      + '</dl></div><div class="stub"><span class="label">No.</span><b>' + esc(String(k.session).slice(-4).toUpperCase()) + '</b><span>session</span></div></div>';
  }

  // The result: outcome, the figures as the site shows them, a thumbnail and a link.
  function resultCard(r, image) {
    var res = r.result || {}, ok = r.status === 'completed';
    var facts = res.facts || [];
    var url = res.final_url || r.final_url || '';
    root.innerHTML = '<div class="card"><p class="label">Usher</p><h1 class="title">' + esc(res.title || (ok ? 'Done' : 'Stopped')) + '</h1>'
      + (url ? '<p class="where">' + esc(where(url)) + '</p>' : '')
      + '<p class="outcome ' + (ok ? 'ok' : 'no') + '">' + (ok ? 'Completed' : esc(r.status)) + (r.reason ? ': ' + esc(r.reason) : '') + '</p>'
      + (facts.length ? '<ul class="facts">' + facts.map(function (f) { return '<li class="verbatim">' + esc(f) + '</li>'; }).join('') + '</ul>' : '')
      + (image && image.data ? '<img class="thumb" alt="The page Usher finished on" src="data:' + esc(image.mimeType || 'image/png') + ';base64,' + esc(image.data) + '">' : '')
      + (url && ok ? '<p class="note"><a href="#" data-open="' + esc(url) + '">Open the page</a> · as the site shows it, word for word</p>' : '')
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
    theme(r && r.hostContext);
    notify('ui/notifications/initialized', {});
    resize();
  }, function () { notify('ui/notifications/initialized', {}); });
})();
</script>
</body>
</html>`;
