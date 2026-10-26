import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage, startRegistry } from '../src/index.ts';

test('the /demo routes are off unless USHER_DEMO=1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usher-demo-gate-'));
  const running = await startRegistry({
    storage: new FileStorage(dir),
    demo: async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('stage');
    },
  });
  const before = process.env.USHER_DEMO;
  try {
    delete process.env.USHER_DEMO;
    assert.equal((await fetch(`${running.url}/demo`)).status, 404);
    process.env.USHER_DEMO = '1';
    const on = await fetch(`${running.url}/demo`);
    assert.equal(on.status, 200);
    assert.equal(await on.text(), 'stage');
    assert.equal((await fetch(`${running.url}/demox`)).status, 404, 'only /demo and below');
  } finally {
    if (before === undefined) delete process.env.USHER_DEMO;
    else process.env.USHER_DEMO = before;
    await running.close();
    await rm(dir, { recursive: true });
  }
});
