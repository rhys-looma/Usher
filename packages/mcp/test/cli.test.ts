// @usher-run/mcp as built for npm (dist/cli.js): --version, the MCP server over stdio against a
// registry, and --check knocking on a seeded form. Nothing published is needed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
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

test('installed on its own, outside this repository, it starts: the bundle reads no files beside it', async () => {
  // As npm lays it out: node_modules/@usher-run/mcp/dist/cli.js, with only its declared dependency.
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const home = join(dir, 'installed');
  const at = join(home, 'node_modules', '@usher-run', 'mcp', 'dist');
  await mkdir(at, { recursive: true });
  await copyFile(cli, join(at, 'cli.js'));
  await copyFile(fileURLToPath(new URL('../package.json', import.meta.url)), join(at, '..', 'package.json'));
  for (const dep of ['playwright', 'playwright-core']) await symlink(fileURLToPath(import.meta.resolve(`${dep}/package.json`)).replace(/\/package\.json$/, ''), join(home, 'node_modules', dep));
  const { stdout } = await run(process.execPath, [join(at, 'cli.js'), '--version'], { cwd: home });
  assert.equal(stdout.trim(), pkg.version);
  const checked = await run(process.execPath, [join(at, 'cli.js'), '--check'], { cwd: home, env: { ...process.env, USHER_REGISTRY_URL: registry.url, USHER_CHECK_URL: FORM, USHER_AGENT_KEY_FILE: join(home, 'key.json') } }).catch((e: { stdout?: string; stderr?: string }) => e);
  assert.match(String(checked.stdout ?? ''), /OK/, String(checked.stderr ?? ''));
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
