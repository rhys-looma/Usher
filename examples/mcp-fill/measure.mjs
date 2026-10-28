// Times usher_fill over stdio, as any MCP client sees it: from the call to the first pause, each
// answer, and the end. No model in the loop, so this is the tools' own time.
//
//   node examples/mcp-fill/measure.mjs [--runs 3]          the published package, via npx
//   USHER_MCP="node packages/mcp/dist/cli.js" node examples/mcp-fill/measure.mjs
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
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 1;
const [command, ...args] = (process.env.USHER_MCP ?? 'npx -y @usher-run/mcp').split(' ');
const url = process.env.BRIGHTWATER_URL ?? usher.demoForm;

for (let i = 0; i < runs; i++) {
  const keyFile = join(await mkdtemp(join(tmpdir(), 'usher-measure-')), 'agent-key.json');
  const client = new Client({ name: 'measure', version: '0' });
  await client.connect(new StdioClientTransport({ command, args, env: { ...process.env, USHER_AGENT_KEY_FILE: keyFile } }));
  const call = async (name, a) => (await client.callTool({ name, arguments: a }, undefined, { timeout: 600_000 })).structuredContent;
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  let reply = await call('usher_fill', { url, intent: 'quote.car_insurance', values });
  const pauses = [];
  while (reply.status === 'needs_decision') {
    pauses.push({ at_ms: ms(), decisions: reply.decisions.map((d) => `${d.kind}:${d.key}`) });
    reply = await call('usher_confirm', { id: reply.id, answers: Object.fromEntries(reply.decisions.map((d) => [d.key, d.key !== 'consent.marketing'])) });
  }
  const done = ms();
  console.log(JSON.stringify({ run: i + 1, status: reply.status, to_first_pause_ms: pauses[0]?.at_ms, to_confirm_prompt_ms: pauses.find((p) => p.kind === 'confirm')?.at_ms, to_completion_ms: done, pauses, actions: reply.actions?.length, used_model: reply.used_model, session: reply.session, final_url: reply.final_url }));
  await client.close();
}
