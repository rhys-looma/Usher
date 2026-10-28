// Starts the mock quote site as a child process on a free port, optionally wired to a registry.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const serverScript = fileURLToPath(new URL('../../../examples/mock-quote-site/server.mjs', import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export interface MockSite {
  url: string;
  process: ChildProcess;
  /** Switches the live layout, as /__admin does. */
  setLayout(layout: 'a' | 'b' | 'c'): Promise<void>;
  stop(): Promise<void>;
}

export interface MockSiteOptions {
  registry?: string;
  variant?: 'a' | 'b' | 'c';
  /** Registers the site's origin before it starts and returns the site key for its script tag. */
  register?: (origin: string) => Promise<string>;
  /** A fixed port instead of a free one. */
  port?: number;
}

export async function startMockSite(options: MockSiteOptions = {}): Promise<MockSite> {
  const port = options.port ?? (await freePort());
  const siteKey = await options.register?.(`http://localhost:${port}`);
  const child = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      PORT: String(port),
      VARIANT: options.variant ?? 'a',
      ...(options.registry && { USHER_REGISTRY_URL: options.registry }),
      ...(siteKey && { USHER_SITE_KEY: siteKey }),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock site did not start')), 10_000);
    child.stdout!.on('data', (chunk) => {
      if (String(chunk).includes(`on port ${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`mock site exited with ${code}`)));
  });
  const url = `http://localhost:${port}`;
  return {
    url,
    process: child,
    async setLayout(layout) {
      await fetch(`${url}/__admin/variant`, { method: 'POST', body: new URLSearchParams({ variant: layout }), redirect: 'manual' });
    },
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}
