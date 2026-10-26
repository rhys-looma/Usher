// Root test runner: starts the mock quote site in layouts A and B on free ports, runs every
// workspace's tests against them, then stops both. Exits with the tests' exit code.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverScript = join(root, 'examples/mock-quote-site/server.mjs');
const servers = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startMockSite(variant) {
  const port = await freePort();
  const child = spawn(process.execPath, [serverScript], {
    env: { ...process.env, PORT: String(port), VARIANT: variant },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  servers.push(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mock site (${variant}) did not start`)), 10_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`localhost:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`mock site (${variant}) exited with ${code}`)));
  });
  return `http://localhost:${port}`;
}

function stopAll() {
  for (const child of servers) if (child.exitCode === null) child.kill();
}

process.on('SIGINT', () => {
  stopAll();
  process.exit(130);
});

let code = 1;
try {
  const [a, b] = await Promise.all([startMockSite('a'), startMockSite('b')]);
  console.log(`mock site: layout A ${a}, layout B ${b}`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  code = await new Promise((resolve) => {
    const run = spawn(npm, ['test', '--workspaces', '--if-present'], {
      cwd: root,
      env: { ...process.env, USHER_MOCK_A: a, USHER_MOCK_B: b },
      stdio: 'inherit',
    });
    run.on('exit', (exit) => resolve(exit ?? 1));
  });
} catch (err) {
  console.error(err);
} finally {
  stopAll();
}
process.exit(code);
