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
:root { --bg:#fbf9f4; --card:#fffdf8; --ink:#191942; --muted:#5b5f7a; --line:#d9d4c7; --rule:#191942; --accent:#7434d3;
  --cons:#8a5a00; --cons-bg:#f8edd2; --user:#a1251b; --user-bg:#f7e2de; --safe:#0f7a3d; --safe-bg:#e3f1e6;
  --serif:"Iowan Old Style","Charter","Palatino Linotype",Palatino,Georgia,serif; color-scheme:light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#12132c; --card:#1b1d3d; --ink:#f1ede3; --muted:#b0afc4; --line:#34365a; --rule:#f1ede3; --accent:#c5a3ff;
  --cons:#f0c05a; --cons-bg:#3a2f14; --user:#f19389; --user-bg:#3b1d1a; --safe:#6fd39a; --safe-bg:#173325; } }
:root[data-theme="light"] { --bg:#fbf9f4; --card:#fffdf8; --ink:#191942; --muted:#5b5f7a; --line:#d9d4c7; --rule:#191942; --accent:#7434d3; --cons:#8a5a00; --cons-bg:#f8edd2; --user:#a1251b; --user-bg:#f7e2de; --safe:#0f7a3d; --safe-bg:#e3f1e6; }
:root[data-theme="dark"] { --bg:#12132c; --card:#1b1d3d; --ink:#f1ede3; --muted:#b0afc4; --line:#34365a; --rule:#f1ede3; --accent:#c5a3ff; --cons:#f0c05a; --cons-bg:#3a2f14; --user:#f19389; --user-bg:#3b1d1a; --safe:#6fd39a; --safe-bg:#173325; }
* { box-sizing:border-box; }
html, body { margin:0; background:transparent; color:var(--ink); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
main { padding:14px; max-width:560px; }
.card { background:var(--card); border:1.5px solid var(--rule); padding:16px 18px; }
.label { font-size:11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin:0; }
h1 { font-family:var(--serif); font-size:22px; line-height:1.2; margin:4px 0 2px; }
h1::after { content:"."; color:var(--accent); }
.where { color:var(--muted); font-size:13px; margin:0 0 10px; word-break:break-all; }
.asking { display:inline-block; font-size:12.5px; font-weight:600; background:var(--cons-bg); color:var(--cons); padding:2px 10px; border-radius:999px; margin:0 0 12px; }
.row { border-top:1px dotted var(--line); padding:10px 0; }
.row:first-of-type { border-top:0; }
label.check { display:flex; gap:10px; align-items:flex-start; cursor:pointer; }
label.check input { margin-top:3px; width:18px; height:18px; accent-color:var(--accent); flex:none; }
.verbatim { white-space:pre-wrap; }
.terms { margin:8px 0 0 28px; font-size:13px; color:var(--muted); border-left:2px solid var(--line); padding-left:10px; max-height:140px; overflow:auto; white-space:pre-wrap; }
.terms a, a { color:var(--ink); text-decoration-color:var(--accent); text-underline-offset:3px; }
.tag { font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; border-radius:999px; padding:1px 8px; margin-left:6px; white-space:nowrap; }
.req { background:var(--user-bg); color:var(--user); } .opt { background:var(--safe-bg); color:var(--safe); }
.yesno { display:flex; gap:14px; margin:8px 0 0 28px; font-size:14px; }
.yesno label { display:flex; gap:6px; align-items:center; cursor:pointer; }
.disclosure { margin:6px 0 0 28px; font-size:13px; color:var(--muted); white-space:pre-wrap; }
input[type=text] { width:100%; font:inherit; color:var(--ink); background:var(--bg); border:1.5px solid var(--line); padding:7px 9px; margin-top:6px; }
button { font:inherit; font-weight:600; background:var(--rule); color:var(--card); border:0; padding:10px 18px; cursor:pointer; margin-top:12px; }
button:disabled { opacity:.5; cursor:default; }
.note { font-size:12.5px; color:var(--muted); margin:8px 0 0; }
.warn { color:var(--user); }
.ticket { display:grid; grid-template-columns:minmax(0,1fr) 92px; padding:0; }
.ticket-main { padding:16px 18px; }
.ticket dl { margin:10px 0 0; display:grid; gap:7px; }
.ticket dl div { display:grid; grid-template-columns:92px 1fr; gap:10px; border-top:1px dotted var(--line); padding-top:7px; }
.ticket dt { font-size:10.5px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); padding-top:2px; }
.ticket dd { margin:0; font-size:14px; }
.stub { border-left:1.5px dashed var(--rule); padding:16px 8px; display:flex; flex-direction:column; align-items:center; justify-content:space-between; text-align:center; gap:6px; }
.stub b { font-family:var(--serif); font-size:24px; writing-mode:vertical-rl; transform:rotate(180deg); letter-spacing:.06em; }
.stub span:last-child { font-size:11px; color:var(--muted); }
.facts { list-style:none; margin:10px 0 0; padding:0; }
.facts li { border-top:1px dotted var(--line); padding:7px 0; font-size:15px; }
.facts li:first-child { border-top:0; font-family:var(--serif); font-size:22px; font-weight:700; }
.thumb { display:block; width:100%; max-height:180px; object-fit:cover; object-position:top; border:1px solid var(--line); margin-top:10px; }
.outcome { font-weight:700; }
.outcome.ok { color:var(--safe); } .outcome.no { color:var(--user); }
@media (max-width:420px) { .ticket { grid-template-columns:1fr; } .stub { border-left:0; border-top:1.5px dashed var(--rule); flex-direction:row; padding:10px 18px; } .stub b { writing-mode:horizontal-tb; transform:none; } .ticket dl div { grid-template-columns:1fr; gap:1px; } }
</style>
</head>
<body>
<main id="root"><p class="note">Waiting for Usher…</p></main>
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
    var html = '<div class="card"><p class="label">Your decision</p><h1>Before Usher goes on</h1>'
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
    root.innerHTML = '<div class="card ticket"><div class="ticket-main"><p class="label">Admit one agent</p><h1>' + esc(purpose.replace(/:.*$/, '')) + '</h1>'
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
    root.innerHTML = '<div class="card"><p class="label">Usher</p><h1>' + esc(res.title || (ok ? 'Done' : 'Stopped')) + '</h1>'
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
