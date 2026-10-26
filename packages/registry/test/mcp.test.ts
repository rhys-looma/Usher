import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { jwkThumbprint, publicPart, verifyToken } from '@usher/core';
import { seed, startRegistry } from '../src/index.ts';
import { testStorage } from './storage-helper.ts';

test('MCP server: knock, get_map, submit_map and report_run as tools, signing with a local key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usher-mcp-'));
  const running = await startRegistry({ storage: await testStorage(join(dir, 'registry')) });
  const maps = await seed(running.registry, 'mock-site', 'http://localhost:4100');
  const keyFile = join(dir, 'agent-key.json');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', '--import', 'tsx', fileURLToPath(new URL('../src/mcp.ts', import.meta.url))],
    env: { ...(process.env as Record<string, string>), USHER_REGISTRY_URL: running.url, USHER_AGENT_KEY_FILE: keyFile },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'usher-test', version: '0.0.0' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['get_map', 'knock', 'report_run', 'submit_map']);

    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result.content));
      return result.structuredContent as Record<string, any>;
    };
    const knock = await call('knock', { url: 'http://localhost:4100/quote/driver', fingerprint: maps[0]!.fingerprint });
    assert.equal(knock.match.kind, 'exact');
    const keys = await (await fetch(knock.keys_url)).json();
    const verified = await verifyToken(knock.token, { keys, origin: 'http://localhost:4100' });
    assert.ok(verified.ok);
    // The key file was created on first use, private to the user, and the agent id is its thumbprint.
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
    assert.equal(verified.claims.sub, await jwkThumbprint(publicPart(JSON.parse(await readFile(keyFile, 'utf8')))));

    const byDigest = await call('get_map', { url: 'http://localhost:4100/quote/vehicle', digest: maps[1]!.fingerprint.digest });
    assert.equal(byDigest.map.path, '/quote/vehicle');
    const byPage = await call('get_map', { url: 'http://localhost:4100/quote/cover', fingerprint: maps[2]!.fingerprint });
    assert.equal(byPage.match.kind, 'exact');

    const submitted = await call('submit_map', { map: { ...maps[0]!, origin: 'http://localhost:4103' } });
    assert.equal(submitted.stored, true);
    const reported = await call('report_run', { session: knock.session, url: 'http://localhost:4100/quote/result', outcome: 'completed', summary: { pages: 1 } });
    assert.equal(reported.recorded, true);

    const bad = await client.callTool({ name: 'get_map', arguments: { url: 'http://localhost:4100/' } });
    assert.equal(bad.isError, true);
  } finally {
    await client.close();
    await running.close();
    await rm(dir, { recursive: true });
  }
});
