// The local chat tester: the model and the site's app go back and forth, a card reaches the page,
// and the server answers its own page only, since it spends the owner's key.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startChat, type SiteClient, type ToolResult } from '../scripts/chat/server.ts';

const SITE = { name: 'Brightwater', origin: 'https://quote.example' };
const calls: { name: string; args: Record<string, unknown> }[] = [];
const replies: string[] = [];
const seen: unknown[][] = [];

const client: SiteClient = {
  instructions: () => 'One site.',
  listTools: async () => [
    { name: 'get_quote', description: 'A quote', inputSchema: {}, _meta: { ui: { resourceUri: 'ui://usher/card.html' } } },
    { name: 'usher_confirm', description: 'Confirm', inputSchema: {} },
    { name: 'knock', description: 'Knock', inputSchema: {} },
  ],
  callTool: async (name, args): Promise<ToolResult> => {
    calls.push({ name, args });
    return { content: [{ type: 'text', text: `${name} ran` }], structuredContent: { status: 'needs_decision' } };
  },
  readResource: async () => '<p>card</p>',
  close: async () => undefined,
};
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_tokens: 0 };

let url: string;
let close: () => Promise<void>;
before(async () => {
  const running = await startChat({
    registryUrl: 'https://registry.example',
    sites: [SITE],
    model: 'muse-spark-1.3',
    port: 0,
    connect: async () => client,
    chat: async (request) => {
      seen.push(request.messages);
      return { content: replies.shift() ?? '{"say":"","tool":"","arguments_json":"{}"}', usage, latency_ms: 0, response: {} };
    },
  });
  ({ url, close } = running);
});
after(() => close());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const start = async () => ((await (await post('/api/start', { origin: SITE.origin })).json()) as { id: string }).id;

test('a turn: the model calls the tool, the card goes to the page, and the result goes back to the model', async () => {
  replies.push('{"say":"","tool":"get_quote","arguments_json":"{\\"details\\":\\"Sam\\"}"}', '{"say":"Fill in the card.","tool":"","arguments_json":"{}"}');
  const id = await start();
  const res = await post('/api/say', { id, text: 'A quote please' });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as { type: string; name?: string; html?: string; text?: string });
  assert.deepEqual(calls.at(-1), { name: 'get_quote', args: { details: 'Sam' } });
  assert.equal(events.find((e) => e.type === 'tool')?.name, 'get_quote');
  assert.equal(events.find((e) => e.type === 'card')?.html, '<p>card</p>');
  assert.equal(events.find((e) => e.type === 'say')?.text, 'Fill in the card.');
  assert.match(JSON.stringify(seen.at(-1)), /get_quote ran/);
});

test('a tool the model invents, or bad arguments, go back to it and call nothing', async () => {
  const before = calls.length;
  replies.push('{"say":"","tool":"delete_everything","arguments_json":"{}"}', '{"say":"","tool":"get_quote","arguments_json":"not json"}', '{"say":"Sorry.","tool":"","arguments_json":"{}"}');
  const id = await start();
  await (await post('/api/say', { id, text: 'Go' })).text();
  assert.equal(calls.length, before);
});

test('a turn that keeps calling tools is stopped', async () => {
  for (let i = 0; i < 10; i++) replies.push('{"say":"","tool":"get_quote","arguments_json":"{}"}');
  const id = await start();
  const text = await (await post('/api/say', { id, text: 'Go' })).text();
  assert.match(text, /too many tool calls/);
  replies.length = 0;
});

test('a card can confirm, but not call anything else', async () => {
  const id = await start();
  assert.equal((await post('/api/tool', { id, name: 'usher_confirm', arguments: { id: 'f_1' } })).status, 200);
  assert.equal((await post('/api/tool', { id, name: 'knock', arguments: {} })).status, 403);
  assert.equal((await post('/api/tool', { id, name: 'prepare_run', arguments: {} })).status, 403, 'not one of this app\'s tools');
});

test('only its own page: another origin, another host, a form post and a site not listed are refused', async () => {
  const id = await start();
  assert.equal((await post('/api/say', { id, text: 'Hi' }, { Origin: 'https://evil.example' })).status, 403);
  const form = await fetch(`${url}/api/say`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ id, text: 'Hi' }) });
  assert.equal(form.status, 500);
  assert.equal((await post('/api/start', { origin: 'https://other.example' })).status, 400);
  assert.equal((await post('/api/say', { id: 'nope', text: 'Hi' })).status, 404);
  const { request } = await import('node:http');
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${url}/`, { headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0));
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403, 'a rebound host name');
});

test('it answers on localhost as well as its own address', async () => {
  const port = new URL(url).port;
  const { request } = await import('node:http');
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${url}/`, { headers: { Host: `localhost:${port}` } }, (res) => resolve(res.statusCode ?? 0));
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 200);
});
