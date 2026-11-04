// npm run local: the Usher portal and the test sites on this machine, then the steps to follow.
// Larchmont and five other fictional businesses wait to be added to Usher. Brightwater is already
// set up. Needs MODEL_API_KEY in .env (.env.example has the list).
//
//   npm run local                    portal on 4200, Brightwater on 4100, the others on 4301 to 4306,
//                                    the chat tester on 4400 (PORT, SITE_PORT, PORT_BASE, CHAT_PORT)
//   npm run local:agent              in another terminal: an agent gets a quote from Brightwater
//   npm run local:agent -- car       the same for its car insurance quote
//
// Stores its data in data/local (gitignored): delete the folder to start again. The keys below are
// for this machine only, as in docker-compose.yml.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { agent: { type: 'boolean', default: false } } });

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
const larchmontUrl = `http://${host}:${process.env.PORT_BASE ?? 4301}`;
const chatPort = process.env.CHAT_PORT ?? 4400;
const chatUrl = `http://${host}:${chatPort}`;
const tsx = ['--disable-warning=ExperimentalWarning', '--import', 'tsx'];

const QUOTES = {
  health: ['/health/about', 'test-health', 'quote.health_insurance'],
  car: ['/quote/driver', 'test-driver', 'quote.car_insurance'],
};
const agentArgs = (quote) => {
  const [path, profile, intent] = QUOTES[quote];
  return [`${siteUrl}${path}`, '--profile', `packages/agent/profiles/${profile}.json`, '--intent', intent, '--mcp', '--auto-confirm'];
};

// npm run local:agent: one quote against the portal and site already running.
if (positionals[0] === 'agent') {
  const quote = positionals[1] ?? 'health';
  if (!QUOTES[quote]) {
    console.error('Use health or car.');
    process.exit(2);
  }
  const { status } = spawnSync(process.execPath, [...tsx, 'packages/agent/src/cli.ts', ...agentArgs(quote)], { stdio: 'inherit' });
  if (status) console.log(`\nIs npm run local running in another terminal?${process.platform === 'linux' ? ' If Chromium could not start, run: npx playwright install --with-deps chromium' : ''}`);
  process.exit(status ?? 1);
}

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
for (const url of [registryUrl, siteUrl, larchmontUrl, chatUrl]) {
  if (await portBusy(url)) {
    console.error(`Something is already running at ${url}. Stop it, or set PORT, SITE_PORT, PORT_BASE and CHAT_PORT.`);
    process.exit(1);
  }
}

// Muse Spark reads the pages, so nothing here works far without its key.
const env = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const hasKey = (name) => Boolean(process.env[name]) || new RegExp(`^${name}=\\S`, 'm').test(env);
if (!hasKey('MODEL_API_KEY')) {
  console.error('Usher needs your Meta Model API key. Copy .env.example to .env, fill in MODEL_API_KEY, and run this again.');
  process.exit(1);
}
if (!hasKey('BASETEN_API_KEY')) console.log('No BASETEN_API_KEY in .env: Muse Spark Open gives no second opinion on risk.');

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
// Their settings go with the store, so each start has them waiting to be added again.
start('sites', ['server.mjs'], { USHER_REGISTRY_URL: registryUrl, SITES_SETTINGS: resolve('data/local/site-settings.json') }, 'examples/sites');
await ready(`${larchmontUrl}/`);
// The chat tester: Muse Spark and each site's real app, as an assistant would use them.
const base = Number(process.env.PORT_BASE ?? 4301);
const others = ['Larchmont Mortgages', 'Kestrel Energy', 'Fernbrook Borough Council', 'Hollyhock Vets', 'Packhorse Removals', 'Little Fig'].map((name, i) => ({ name, origin: `http://${host}:${base + i}` }));
start('chat', [...tsx, 'packages/agent/scripts/chat/cli.ts'], {
  CHAT_PORT: chatPort,
  USHER_CHAT_REGISTRY: registryUrl,
  USHER_CHAT_SITES: JSON.stringify([{ name: 'Brightwater Insurance', origin: siteUrl }, ...others]),
});

console.log(`
Usher is running on this machine.

  Usher portal    ${registryUrl}
  Test site       ${larchmontUrl}    Larchmont Mortgages, not on Usher yet
  Ready-made site ${siteUrl}/health/about    Brightwater, already set up

Add the test site to Usher:

  1. Go to ${registryUrl}/sites/new, enter ${larchmontUrl} and save your keys.
  2. Go to ${larchmontUrl}/__settings, paste the site key and save. That adds Usher's tag to the site.
  3. Back on the portal, press Next, then Check now, to prove the site is yours.
  4. In Map my site, start at ${larchmontUrl}/aip/you and press Start. Muse Spark goes through the form.
  5. Choose Finish here, check the map and publish it. Then write your rules, accept the look and publish the app.

Chat with a site's app, as an assistant would use it:

  ${chatUrl}

See an agent use a site, in another terminal:

  npm run local:agent

  Then see its session at ${registryUrl}/dashboard
  Sign in with ${siteUrl} and the secret key ${secretKey}

Press Ctrl+C to stop. Each start begins again from nothing.
`);

if (values.agent) {
  const agent = start('agent', [...tsx, 'packages/agent/src/cli.ts', ...agentArgs('health')], {});
  agent.on('exit', (code) => {
    children.delete(agent);
    console.log(code === 0 ? `\nThe agent finished. See its session at ${registryUrl}/dashboard.` : `\nThe agent stopped with code ${code}.`);
    if (code && process.platform === 'linux') console.log('If Chromium could not start, run: npx playwright install --with-deps chromium');
    if (code) process.exitCode = code;
  });
}
