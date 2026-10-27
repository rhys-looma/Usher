// A fresh agent identity runs usher_fill on the demo quote, then this waits for its session to
// appear on the registry's public demo dashboard (/demo/dashboard). Fails if it takes more than ten
// seconds from the first pause (by then the agent has knocked on every page).
//
//   node examples/mcp-fill/demo-dashboard-check.mjs                      the published package, via npx
//   USHER_MCP="node packages/mcp/dist/cli.js" node examples/mcp-fill/demo-dashboard-check.mjs
//
// Knocks on the registry and demo form @usher-run/mcp defaults to; the driver is fictional.

import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = new URL('../../', import.meta.url);
const { usher } = JSON.parse(await readFile(new URL('packages/mcp/package.json', root), 'utf8'));
const { _comment, 'consent.declaration': _d, 'consent.marketing': _m, ...values } = JSON.parse(await readFile(new URL('packages/agent/profiles/test-driver.json', root), 'utf8'));
const registry = (process.env.USHER_REGISTRY_URL ?? usher.defaultRegistry).replace(/\/$/, '');
const url = process.env.BRIGHTWATER_URL ?? usher.demoForm;
const [command, ...args] = (process.env.USHER_MCP ?? 'npx -y @usher-run/mcp').split(' ');

const keyFile = join(await mkdtemp(join(tmpdir(), 'usher-demo-check-')), 'agent-key.json');
const client = new Client({ name: 'demo-dashboard-check', version: '0' });
await client.connect(new StdioClientTransport({ command, args, env: { ...process.env, USHER_REGISTRY_URL: registry, USHER_AGENT_KEY_FILE: keyFile } }));
const call = async (name, a) => (await client.callTool({ name, arguments: a }, undefined, { timeout: 600_000 })).structuredContent;

const listed = async (sid) => (await (await fetch(`${registry}/demo/dashboard`, { cache: 'no-store' })).text()).includes(`/demo/dashboard/sessions/${sid}`);
let reply = await call('usher_fill', { url, intent: 'quote.car_insurance', values });
const paused = performance.now();
while (reply.status === 'needs_decision') reply = await call('usher_confirm', { id: reply.id, answer: reply.decision.key !== 'consent.marketing' });
await client.close();
if (reply.status !== 'completed' || !reply.session) {
  console.error(`usher_fill did not complete: ${JSON.stringify(reply).slice(0, 300)}`);
  process.exit(1);
}
let seen = null;
while (performance.now() - paused < 10_000) {
  if (await listed(reply.session)) {
    seen = Math.round(performance.now() - paused);
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}
const timeline = seen === null ? '' : await (await fetch(`${registry}/demo/dashboard/sessions/${reply.session}`)).text();
const events = (timeline.match(/<li>/g) ?? []).length;
console.log(JSON.stringify({ session: reply.session, completed_ms: Math.round(performance.now() - paused), on_dashboard_within_ms: seen, events_on_session_page: events }));
if (seen === null) {
  console.error(`Session ${reply.session} did not appear on ${registry}/demo/dashboard within 10 s.`);
  process.exit(1);
}
