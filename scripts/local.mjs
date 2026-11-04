// npm run local: the registry and the demo site on this machine, joined up, with the demo maps. No
// keys needed: everything an agent does here runs from the maps. With --agent, a reference agent
// also gets a health quote from the demo site, so there is a session to look at on the dashboard.
//
//   npm run local                    registry on 4200, demo site on 4100 (PORT, SITE_PORT to change)
//   npm run local -- --agent         the same, and run the agent once they are up
//   npm run local -- --sites         the same, and six more fictional businesses to join and map as
//                                    an owner, on ports 4301 to 4306 (mapping needs MODEL_API_KEY)
//
// Stores its data in data/local (gitignored): delete the folder to start again. The keys below are
// for this machine only, as in docker-compose.yml.

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { agent: { type: 'boolean', default: false }, sites: { type: 'boolean', default: false } } });

// The registry reads .env with process.loadEnvFile.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error(`Usher needs Node 20.12 or later; this is ${process.version}.`);
  process.exit(1);
}

const host = 'localhost';
const registryUrl = `http://${host}:${process.env.PORT ?? 4200}`;
const siteUrl = `http://${host}:${process.env.SITE_PORT ?? 4100}`;
const siteKey = 'usp_localdevelopmentonly000';
const secretKey = 'uss_localdevelopmentonly00000000';
const tsx = ['--disable-warning=ExperimentalWarning', '--import', 'tsx'];

const children = new Set();
const start = (name, args, env, cwd) => {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  children.add(child);
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split('\n').filter(Boolean)) if (!line.startsWith('{')) console.log(`[${name}] ${line}`);
  });
  return child;
};
const stop = () => {
  for (const child of children) child.kill();
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => (stop(), process.exit(0)));

const ready = async (url) => {
  for (let i = 0; i < 120; i++) {
    const up = await fetch(url).then((r) => r.ok, () => false);
    if (up) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  console.error(`Nothing answered at ${url} after a minute.`);
  process.exit(1);
};

const portBusy = async (url) => fetch(url).then(() => true, () => false);
for (const url of [registryUrl, siteUrl]) {
  if (await portBusy(url)) {
    console.error(`Something is already running at ${url}. Stop it, or set PORT and SITE_PORT.`);
    process.exit(1);
  }
}

// The dev keys go with a fresh store each start, so the demo always opens the same way.
await rm('data/local', { recursive: true, force: true });

const registry = start('registry', [...tsx, 'packages/registry/src/server.ts', '--port', new URL(registryUrl).port, '--data', 'data/local', '--seed', 'mock-site', '--seed-origin', siteUrl, '--allow-private'], {
  REGISTRY_PUBLIC_URL: registryUrl,
  USHER_VIEWER: '1',
  USHER_DEV_SITE_ORIGIN: siteUrl,
  USHER_DEV_SITE_KEY: siteKey,
  USHER_DEV_SECRET_KEY: secretKey,
});
registry.on('exit', (code) => {
  if (code) {
    stop();
    process.exit(code);
  }
});
await ready(`${registryUrl}/healthz`);
start('site', ['server.mjs'], { PORT: new URL(siteUrl).port, USHER_REGISTRY_URL: registryUrl, USHER_SITE_KEY: siteKey, USHER_SITE_ORIGIN: siteUrl }, 'examples/mock-quote-site');
await ready(`${siteUrl}/healthz`);
if (values.sites) start('sites', ['server.mjs'], { USHER_REGISTRY_URL: registryUrl }, 'examples/sites');

const agentCommand = (path, profile, intent) => ['run', 'agent', '--', `${siteUrl}${path}`, '--profile', `packages/agent/profiles/${profile}.json`, '--intent', intent, '--mcp', '--auto-confirm'];
console.log(`
Usher is running on this machine.

  Front page    ${registryUrl}
  Dashboard     ${registryUrl}/dashboard
                sign in with the site's address, ${siteUrl}, and the secret key ${secretKey}
  Demo site     ${siteUrl}/health/about    Brightwater, a fictional insurer

Get a quote with an agent, in another terminal:

  npm ${agentCommand('/health/about', 'test-health', 'quote.health_insurance').join(' ')}
  npm ${agentCommand('/quote/driver', 'test-driver', 'quote.car_insurance').join(' ')}

${values.sites ? `Join and map a site as its owner, starting at ${registryUrl}/sites/new, with http://${host}:4301 for Larchmont (examples/sites/README.md).

` : ''}Press Ctrl+C to stop.
`);

if (values.agent) {
  const agent = start('agent', [...tsx, 'packages/agent/src/cli.ts', ...agentCommand('/health/about', 'test-health', 'quote.health_insurance').slice(3)], {});
  agent.on('exit', (code) => {
    children.delete(agent);
    console.log(code === 0 ? `\nThe agent finished. See its session at ${registryUrl}/dashboard.` : `\nThe agent stopped with code ${code}.`);
    if (code && process.platform === 'linux') console.log('If Chromium could not start, run: npx playwright install --with-deps chromium');
    if (code) process.exitCode = code;
  });
}
