// The chat tester's page, and the small part of an MCP Apps host it needs: the site's real card
// runs in a sandboxed frame, and speaks to this page by postMessage as it would to Claude or ChatGPT.

export function chatPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Usher chat tester</title>
<style>
:root { --ink:#0b2a35; --muted:#55707a; --line:#d5e0e3; --bg:#f3f7f8; --card:#fff; --accent:#0b2a35; --warn:#b3261e; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
header { background:var(--accent); color:#fff; padding:14px 20px; display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; }
header b { font-size:18px; }
header select { font:inherit; padding:6px 8px; border-radius:6px; border:0; max-width:100%; }
main { display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:20px; max-width:1180px; margin:0 auto; padding:20px; }
#chat { display:flex; flex-direction:column; gap:12px; min-height:50vh; }
.m { max-width:85%; padding:10px 14px; border-radius:12px; background:var(--card); border:1px solid var(--line); white-space:pre-wrap; overflow-wrap:anywhere; }
.m.me { align-self:flex-end; background:var(--accent); color:#fff; border-color:var(--accent); }
.m.err { color:var(--warn); border-color:var(--warn); }
.m.wait { color:var(--muted); }
iframe { width:100%; max-width:560px; border:1px solid var(--line); border-radius:12px; background:#fff; height:200px; }
form { display:flex; gap:8px; margin-top:16px; }
textarea { flex:1; min-width:0; font:inherit; padding:10px 12px; border:1px solid var(--line); border-radius:8px; resize:vertical; }
button { font:inherit; font-weight:600; padding:10px 18px; border:0; border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; }
button:disabled { opacity:.5; cursor:default; }
.try { background:transparent; color:var(--ink); border:1px solid var(--line); font-weight:400; text-align:left; padding:8px 12px; }
aside h2 { font-size:15px; margin:0 0 8px; }
aside section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:12px; font-size:14px; }
aside code { overflow-wrap:anywhere; font-size:13px; }
details { border-top:1px solid var(--line); padding:6px 0; }
summary { cursor:pointer; overflow-wrap:anywhere; }
details.bad summary { color:var(--warn); }
pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; margin:6px 0 0; max-height:260px; overflow:auto; }
.muted { color:var(--muted); }
@media (max-width:860px) { main { grid-template-columns:minmax(0,1fr); padding:16px; } .m { max-width:100%; } }
</style></head>
<body>
<header><b>Usher chat tester</b><label>Site's app: <select id="site"></select></label></header>
<main>
<div>
<div id="chat"></div>
<form id="say"><textarea id="text" rows="2" placeholder="Ask for what the site offers" aria-label="Your message"></textarea><button id="send">Send</button></form>
</div>
<aside>
<section><h2>What this is</h2>Muse Spark, on your key, acting as an assistant connected to the site's real app, with its real card. What you type goes to Muse Spark and the site's app. This page keeps it only until you close it or the tester stops.</section>
<section><h2>Connected to</h2><code id="endpoint">Choose a site</code><p class="muted" id="spend">Model spend: $0.000</p></section>
<section><h2>Tool calls</h2><div id="tools"><span class="muted">None yet.</span></div></section>
</aside>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var chat = $('chat'), conv = null, busy = false;
  var PROMPTS = {
    'Brightwater Insurance': "Get me a health insurance quote from Brightwater. I'm Sam Taylor, born 2 April 1988, WR14 1AA, just me, non-smoker, comprehensive cover with a £250 excess.",
    'Larchmont Mortgages': "I'd like a mortgage agreement in principle from Larchmont. Use made-up test details for me."
  };
  function post(path, body) { return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  function line(cls, text) { var d = document.createElement('div'); d.className = 'm ' + cls; d.textContent = text; chat.appendChild(d); d.scrollIntoView({ block: 'nearest' }); return d; }
  function setBusy(b) { busy = b; $('send').disabled = b; }

  function logTool(e) {
    if ($('tools').querySelector('.muted')) $('tools').textContent = '';
    var d = document.createElement('details'); if (e.isError) d.className = 'bad';
    var s = document.createElement('summary'); s.textContent = e.name; d.appendChild(s);
    var p = document.createElement('pre'); p.textContent = 'Arguments: ' + JSON.stringify(e.args || {}, null, 2) + '\\n\\n' + (e.result || ''); d.appendChild(p);
    $('tools').appendChild(d);
  }

  // A card: the host's half of MCP Apps. The frame has no access to this page or its address.
  function card(e) {
    var frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-forms');
    frame.title = 'The site\\'s card';
    frame.srcdoc = e.html;
    chat.appendChild(frame);
    var reply = function (id, result) { frame.contentWindow.postMessage({ jsonrpc: '2.0', id: id, result: result }, '*'); };
    var fail = function (id, text) { frame.contentWindow.postMessage({ jsonrpc: '2.0', id: id, error: { code: -32000, message: text } }, '*'); };
    window.addEventListener('message', function (ev) {
      if (ev.source !== frame.contentWindow) return;
      var m = ev.data || {};
      if (m.method === 'ui/notifications/size-changed') { frame.style.height = Math.max(120, Math.min(2000, (m.params && m.params.height) || 200)) + 'px'; return; }
      if (m.method === 'ui/notifications/initialized') { frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: e.result }, '*'); return; }
      if (m.id == null) return;
      if (m.method === 'ui/initialize') return reply(m.id, { protocolVersion: '2026-01-26', hostInfo: { name: 'usher-chat-tester', version: '0.1.0' }, hostCapabilities: { serverTools: {}, message: {}, openLinks: {} }, hostContext: { theme: 'light' } });
      if (m.method === 'ping') return reply(m.id, {});
      if (m.method === 'tools/call') {
        return post('/api/tool', { id: conv, name: m.params.name, arguments: m.params.arguments }).then(function (r) { return r.json(); }).then(function (r) {
          if (r.error) return fail(m.id, r.error);
          reply(m.id, r.result); logTool({ name: m.params.name + ' (from the card)', args: {}, result: (r.result.content || []).map(function (c) { return c.text || ''; }).join('\\n'), isError: r.result.isError });
        }, function () { fail(m.id, 'That failed.'); });
      }
      if (m.method === 'ui/update-model-context') {
        var text = (m.params.content || []).map(function (c) { return c.text || ''; }).join('\\n');
        return post('/api/context', { id: conv, text: text }).then(function () { reply(m.id, {}); }, function () { fail(m.id, 'That failed.'); });
      }
      if (m.method === 'ui/message') {
        reply(m.id, {});
        return send((m.params.content || []).map(function (c) { return c.text || ''; }).join('\\n'));
      }
      if (m.method === 'ui/open-link') {
        window.open(m.params.url, '_blank', 'noopener');
        return reply(m.id, {});
      }
      fail(m.id, 'Not supported here.');
    });
  }

  function send(text) {
    if (!conv || !text.trim()) return;
    if (busy) { setTimeout(function () { send(text); }, 300); return; }
    setBusy(true);
    line('me', text);
    var wait = line('wait', 'Working…');
    post('/api/say', { id: conv, text: text }).then(function (res) {
      if (!res.ok) return res.json().then(function (b) { line('err', b.error || 'That failed.'); });
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
      function handle(e) {
        if (e.type === 'say') { line('', e.text); chat.appendChild(wait); }
        if (e.type === 'tool') logTool(e);
        if (e.type === 'card') { card(e); chat.appendChild(wait); }
        if (e.type === 'error') line('err', e.text);
        if (e.type === 'spend') $('spend').textContent = 'Model spend: $' + e.usd.toFixed(3);
      }
      function pump() {
        return reader.read().then(function (r) {
          buf += dec.decode(r.value || new Uint8Array(), { stream: !r.done });
          var lines = buf.split('\\n'); buf = lines.pop();
          lines.filter(Boolean).forEach(function (l) { handle(JSON.parse(l)); });
          if (!r.done) return pump();
        });
      }
      return pump();
    }).catch(function () { line('err', 'That failed. Is npm run local still running?'); }).then(function () { wait.remove(); setBusy(false); });
  }

  function start() {
    var origin = $('site').value, name = $('site').selectedOptions[0].dataset.name;
    chat.textContent = ''; conv = null;
    $('tools').innerHTML = '<span class="muted">None yet.</span>'; $('spend').textContent = 'Model spend: $0.000';
    post('/api/start', { origin: origin }).then(function (r) { return r.json(); }).then(function (r) {
      if (r.error) return line('err', r.error);
      conv = r.id; $('endpoint').textContent = r.endpoint;
      var prompt = PROMPTS[name] || 'What can you do for me?';
      var b = document.createElement('button'); b.className = 'try'; b.type = 'button'; b.textContent = 'Try: ' + prompt;
      b.addEventListener('click', function () { b.remove(); send(prompt); });
      chat.appendChild(b);
    }, function () { line('err', 'Could not connect to that app.'); });
  }

  function loadSites() {
    var keep = $('site').value || new URLSearchParams(location.search).get('site');
    return fetch('/api/sites').then(function (r) { return r.json(); }).then(function (r) {
      $('site').textContent = '';
      r.sites.forEach(function (s) {
        var o = document.createElement('option'); o.value = s.origin; o.dataset.name = s.name; o.disabled = !s.ready;
        o.textContent = s.name + (s.ready ? '' : ' (not published yet)'); $('site').appendChild(o);
      });
      var first = r.sites.find(function (s) { return s.ready; });
      if (keep && r.sites.some(function (s) { return s.origin === keep && s.ready; })) $('site').value = keep; else if (first) $('site').value = first.origin;
    });
  }

  $('site').addEventListener('change', start);
  $('site').addEventListener('focus', function () { loadSites(); });
  $('say').addEventListener('submit', function (e) { e.preventDefault(); var t = $('text').value; $('text').value = ''; send(t); });
  $('text').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('say').requestSubmit(); } });
  loadSites().then(start);
})();
</script>
</body></html>`;
}
