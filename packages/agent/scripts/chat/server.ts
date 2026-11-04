// The local chat tester: try a site's assistant app without an assistant. A small chat page on this
// machine, where Muse Spark (on your own MODEL_API_KEY) talks to the site's real MCP endpoint and
// its real card, as Claude or ChatGPT would. `npm run local` starts it. It listens on this machine
// only, and keeps conversations in memory: it writes down nothing anyone types.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { costUsd, parseJsonContent, type ChatFn, type ChatMessage } from '@usher/core';
import { chatPage } from './page.ts';

export const UI_EXTENSION = 'io.modelcontextprotocol/ui';
const MAX_BODY = 64 * 1024;
const MAX_TOOL_CALLS_A_TURN = 6;
const MAX_CONVERSATIONS = 20;
// What a card may call on its own, the person's click being the authorisation.
const CARD_TOOLS = new Set(['usher_confirm', 'usher_cancel', 'plan_status', 'prepare_run']);

export interface ChatTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  _meta?: { ui?: { resourceUri?: string } };
}

export interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** The part of an MCP client this needs; tests pass their own. */
export interface SiteClient {
  instructions(): string;
  listTools(): Promise<ChatTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  readResource(uri: string): Promise<string>;
  close(): Promise<void>;
}

export interface ChatSite {
  name: string;
  origin: string;
}

export interface ChatOptions {
  registryUrl: string;
  sites: ChatSite[];
  chat: ChatFn;
  model: string;
  port?: number;
  connect?: (endpoint: string) => Promise<SiteClient>;
}

interface Conversation {
  site: ChatSite;
  client: SiteClient;
  tools: ChatTool[];
  history: ChatMessage[];
  spent: number;
}

export type ChatEvent =
  | { type: 'say'; text: string }
  | { type: 'tool'; name: string; args: Record<string, unknown>; result: string; isError: boolean }
  | { type: 'card'; tool: string; result: ToolResult; html: string }
  | { type: 'spend'; usd: number }
  | { type: 'error'; text: string };

async function mcpClient(endpoint: string): Promise<SiteClient> {
  // Declares that it draws cards, as Claude and ChatGPT do, so the site's app behaves as it does there.
  const client = new Client({ name: 'usher-chat-tester', version: '0.1.0' }, { capabilities: { extensions: { [UI_EXTENSION]: {} } } as never });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  return {
    instructions: () => client.getInstructions() ?? '',
    listTools: async () => (await client.listTools()).tools as ChatTool[],
    callTool: async (name, args) => (await client.callTool({ name, arguments: args })) as ToolResult,
    readResource: async (uri) => {
      const first = (await client.readResource({ uri })).contents[0] as { text?: string } | undefined;
      return first?.text ?? '';
    },
    close: () => client.close(),
  };
}

const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['say', 'tool', 'arguments_json'],
  properties: {
    say: { type: 'string', description: 'What to say to the person now. Empty if you are only calling a tool.' },
    tool: { type: 'string', description: 'The tool to call now, or empty if you are done until the person replies.' },
    arguments_json: { type: 'string', description: 'The tool\'s arguments as a JSON object, or "{}".' },
  },
};

function systemPrompt(c: Conversation): string {
  const tools = c.tools.map((t) => `- ${t.name}: ${t.description ?? ''}\n  Arguments (JSON Schema): ${JSON.stringify(t.inputSchema ?? {})}`).join('\n');
  return `You are an AI assistant in a chat, with one connected app: ${c.site.name}. Help the person using its tools, as you would in Claude or ChatGPT.

The app's instructions:
${c.client.instructions()}

Its tools:
${tools}

Call one tool at a time, and follow what its result tells you. When a result says a card is on screen, the person is answering there: say one short line and call no tool. Pass the person's details as they gave them. Never make up an answer to a question that is theirs to answer, and never answer a consent for them.`;
}

/** A tool's result as the model reads it. Long results are cut: the card holds the rest. */
function forModel(name: string, result: ToolResult): string {
  const text = (result.content ?? []).map((c) => c.text ?? '').join('\n');
  return `The result of ${name}${result.isError ? ' (an error)' : ''}:\n${text.slice(0, 12_000)}`;
}

const resourceOf = (tool?: ChatTool) => tool?._meta?.ui?.resourceUri;

/** One turn: the model and the app go back and forth until the model has nothing more to call. */
export async function runTurn(c: Conversation, chat: ChatFn, model: string, emit: (e: ChatEvent) => void): Promise<void> {
  for (let i = 0; i <= MAX_TOOL_CALLS_A_TURN; i++) {
    const result = await chat({
      model,
      temperature: 0,
      messages: [{ role: 'system', content: systemPrompt(c) }, ...c.history],
      response_format: { type: 'json_schema', json_schema: { name: 'chat_reply', strict: true, schema: REPLY_SCHEMA } },
    });
    c.spent += costUsd(model, result.usage) ?? 0;
    emit({ type: 'spend', usd: c.spent });
    const reply = parseJsonContent(result.content) as { say?: string; tool?: string; arguments_json?: string };
    c.history.push({ role: 'assistant', content: result.content });
    if (reply.say) emit({ type: 'say', text: reply.say });
    if (!reply.tool) return;
    if (i === MAX_TOOL_CALLS_A_TURN) break;

    const tool = c.tools.find((t) => t.name === reply.tool);
    if (!tool) {
      c.history.push({ role: 'user', content: `There is no tool called ${reply.tool}.` });
      continue;
    }
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(reply.arguments_json || '{}') as Record<string, unknown>;
    } catch {
      c.history.push({ role: 'user', content: 'Those arguments were not valid JSON. Try again.' });
      continue;
    }
    const called = await c.client.callTool(tool.name, args);
    const text = forModel(tool.name, called);
    emit({ type: 'tool', name: tool.name, args, result: text, isError: Boolean(called.isError) });
    c.history.push({ role: 'user', content: text });
    const uri = resourceOf(tool);
    if (uri && called.structuredContent && !called.isError) emit({ type: 'card', tool: tool.name, result: called, html: await c.client.readResource(uri) });
  }
  emit({ type: 'error', text: 'Stopped: too many tool calls in one turn.' });
}

/** Only this machine's own page: other sites in the browser must not reach a server that spends your key. */
function sameMachine(req: IncomingMessage, port: () => number): boolean {
  const own = [`127.0.0.1:${port()}`, `localhost:${port()}`];
  if (!own.includes(req.headers.host ?? '')) return false;
  const origin = req.headers.origin;
  return !origin || own.some((host) => origin === `http://${host}`);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new Error('Expected JSON.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('Too long.');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

export async function startChat(options: ChatOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const connect = options.connect ?? mcpClient;
  const endpoint = (site: ChatSite) => `${options.registryUrl}/mcp/${new URL(site.origin).host}`;
  const conversations = new Map<string, Conversation>();
  let url = '';

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const message = (err: unknown) => (err instanceof Error ? err.message.slice(0, 300) : 'That failed.');

  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://chat').pathname;
      if (!sameMachine(req, () => (server.address() as AddressInfo).port)) return json(res, 403, { error: 'This page answers on this machine only.' });
      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self' about: data: blob:; img-src data:" });
        return res.end(chatPage());
      }
      if (req.method === 'GET' && path === '/api/sites') {
        // A site is on offer once its app answers: the owner has published it.
        const sites = await Promise.all(
          options.sites.map(async (site) => {
            try {
              const client = await connect(endpoint(site));
              const ready = (await client.listTools()).some((t) => t.name.startsWith('get_'));
              await client.close();
              return { ...site, ready };
            } catch {
              return { ...site, ready: false };
            }
          }),
        );
        return json(res, 200, { sites });
      }
      if (req.method !== 'POST') return json(res, 404, { error: 'Not found.' });
      const body = await readJson(req);

      if (path === '/api/start') {
        const site = options.sites.find((s) => s.origin === body.origin);
        if (!site) return json(res, 400, { error: 'Not one of the local sites.' });
        const client = await connect(endpoint(site));
        const id = randomUUID();
        if (conversations.size >= MAX_CONVERSATIONS) {
          const [oldest, gone] = conversations.entries().next().value as [string, Conversation];
          conversations.delete(oldest);
          void gone.client.close().catch(() => undefined);
        }
        conversations.set(id, { site, client, tools: await client.listTools(), history: [], spent: 0 });
        return json(res, 200, { id, endpoint: endpoint(site), tools: conversations.get(id)!.tools.map((t) => t.name) });
      }

      const c = conversations.get(String(body.id));
      if (!c) return json(res, 404, { error: 'That conversation has ended. Choose a site to start again.' });

      if (path === '/api/say') {
        const text = String(body.text ?? '').trim().slice(0, 4000);
        if (!text) return json(res, 400, { error: 'Say something first.' });
        c.history.push({ role: 'user', content: text });
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
        const emit = (e: ChatEvent) => res.write(`${JSON.stringify(e)}\n`);
        await runTurn(c, options.chat, options.model, emit).catch((err) => emit({ type: 'error', text: message(err) }));
        return res.end();
      }
      if (path === '/api/tool') {
        const name = String(body.name);
        if (!CARD_TOOLS.has(name) || !c.tools.some((t) => t.name === name)) return json(res, 403, { error: `A card can't call ${name}.` });
        const result = await c.client.callTool(name, (body.arguments ?? {}) as Record<string, unknown>);
        return json(res, 200, { result });
      }
      if (path === '/api/context') {
        c.history.push({ role: 'user', content: String(body.text ?? '').slice(0, 12_000) });
        return json(res, 200, {});
      }
      return json(res, 404, { error: 'Not found.' });
    })().catch((err) => {
      if (res.headersSent) return res.end();
      json(res, 500, { error: message(err) });
    });
  });

  const host = '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(options.port ?? 4400, host, resolve));
  url = `http://${host}:${(server.address() as AddressInfo).port}`;
  return {
    server,
    url,
    close: async () => {
      await Promise.all([...conversations.values()].map((c) => c.client.close().catch(() => undefined)));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
