// Test harness. Starts the mock quote site in layouts A, B and C on free ports, runs a command with their
// URLs in USHER_MOCK_A, USHER_MOCK_B and USHER_MOCK_C, then stops them. Exits with the command's exit code.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
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
      if (String(chunk).includes(`on port ${port}`)) {
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

export async function withMockSites(command, args) {
  process.on('SIGINT', () => {
    stopAll();
    process.exit(130);
  });
  let code = 1;
  try {
    const [a, b, c] = await Promise.all([startMockSite('a'), startMockSite('b'), startMockSite('c')]);
    console.log(`mock site: layout A ${a}, layout B ${b}, layout C ${c}`);
    code = await new Promise((resolve) => {
      const run = spawn(command, args, {
        cwd: root,
        env: { ...process.env, USHER_MOCK_A: a, USHER_MOCK_B: b, USHER_MOCK_C: c },
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
      run.on('exit', (exit) => resolve(exit ?? 1));
    });
  } catch (err) {
    console.error(err);
  } finally {
    stopAll();
  }
  process.exit(code);
}
