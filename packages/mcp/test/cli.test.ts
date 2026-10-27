// @usher-run/mcp as built for npm (dist/cli.js): --version, the MCP server over stdio against a
// registry, and --check knocking on a seeded form. Nothing published is needed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { seed, startRegistry, type RunningRegistry } from '@usher/registry';
import { testStorage } from '../../registry/test/storage-helper.ts';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const run = promisify(execFile);
const FORM = 'http://localhost:4100/quote/driver';
let dir: string;
let registry: RunningRegistry;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usher-mcp-cli-'));
  registry = await startRegistry({ storage: await testStorage(join(dir, 'registry')) });
  await seed(registry.registry, 'mock-site', 'http://localhost:4100');
});
after(async () => {
  await registry.close();
  await rm(dir, { recursive: true });
});

test('--version prints the package version, and nothing on stderr', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const { stdout, stderr } = await run(process.execPath, [cli, '--version']);
  assert.equal(stdout.trim(), pkg.version);
  assert.equal(stderr, '');
});

test('serves MCP over stdio: the tools, and a signed knock with a key made on first run', async () => {
  const keyFile = join(dir, 'stdio', 'agent-key.json');
  const client = new Client({ name: 'usher-cli-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli], env: { ...(process.env as Record<string, string>), USHER_REGISTRY_URL: registry.url, USHER_AGENT_KEY_FILE: keyFile }, stderr: 'inherit' }));
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ['get_map', 'get_plan', 'knock', 'report_run', 'submit_map', 'usher_cancel', 'usher_confirm', 'usher_fill']);
    const knock = await client.callTool({ name: 'knock', arguments: { url: FORM, intent: 'quote.car_insurance' } });
    assert.ok(!knock.isError, JSON.stringify(knock.content));
    assert.equal(typeof (knock.structuredContent as { token?: unknown }).token, 'string');
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600, 'the key file is private');
  } finally {
    await client.close();
  }
});

test('--check knocks and says what came back', async () => {
  const env = { ...process.env, USHER_REGISTRY_URL: registry.url, USHER_AGENT_KEY_FILE: join(dir, 'check', 'agent-key.json'), USHER_CHECK_URL: FORM };
  const { stdout, stderr } = await run(process.execPath, [cli, '--check'], { env });
  assert.match(stdout, /pass {7}a token, valid until/);
  assert.match(stdout, /map {8}\d+ fields/);
  assert.match(stdout, /\nOK\n?$/);
  assert.equal(stderr, '', 'no experimental-feature noise');
});
