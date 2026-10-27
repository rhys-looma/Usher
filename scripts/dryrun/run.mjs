// Pre-deploy dry run: the production images, on the production host names, behind a stand-in for
// CloudFront and the ALB (proxy.mjs), on this machine. Catches anything that assumes one host,
// plain http, or a single proxy hop.
//
//   REGISTRY_PUBLIC_URL=https://<registry host> USHER_SITE_URL=https://<demo site host> npm run dryrun
//
// 1. Production mode: the registry starts with NODE_ENV=production (and refuses to without its
//    settings); health, HSTS, privacy, robots.txt, security.txt; the map viewer is switched off.
// 2. The flows: the same registry, allowed to reach the demo site's private address (it is on this
//    machine), runs the signup flow in a browser (keys, the tag, the domain claim, the dashboard) and
//    then the end-to-end agent run (npm run e2e:remote) against the public URLs.
// Needs Docker, and port 443 free on this machine.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const registryUrl = process.env.REGISTRY_PUBLIC_URL?.replace(/\/$/, '');
const siteUrl = process.env.USHER_SITE_URL?.replace(/\/$/, '');
if (!registryUrl?.startsWith('https://') || !siteUrl?.startsWith('https://')) {
  console.error('Set REGISTRY_PUBLIC_URL and USHER_SITE_URL to the deployment\'s https URLs.');
  process.exit(2);
}
const registryHost = new URL(registryUrl).hostname;
const siteHost = new URL(siteUrl).hostname;
process.env.USHER_DRYRUN_HOSTS = `${registryHost},${siteHost}`;

const NET = 'usher-dryrun';
const ADMIN_KEY = 'dryrun-admin-key-not-for-production-0001';
const DB = 'postgres://usher:dryrun@postgres:5432/usher';
// Node reads NODE_EXTRA_CA_CERTS only at startup: the first run makes the certificates, then runs
// itself again trusting them, with the host names resolved to the CloudFront + ALB stand-in.
if (!process.env.USHER_DRYRUN_CERTS) {
  const dir = mkdtempSync(join(tmpdir(), 'usher-dryrun-'));
  makeCerts(dir);
  const child = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('./resolve.mjs', import.meta.url)), fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: { ...process.env, USHER_DRYRUN_CERTS: dir, NODE_EXTRA_CA_CERTS: join(dir, 'ca.pem') },
  });
  rmSync(dir, { recursive: true, force: true });
  process.exit(child.status ?? 1);
}
const certs = process.env.USHER_DRYRUN_CERTS;
const results = [];
const check = (name, ok, detail = '') => {
  results.push([name, ok]);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const quiet = (...args) => spawnSync('docker', args, { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function removeContainers() {
  for (const c of ['usher-dryrun-proxy', 'usher-dryrun-site', 'usher-dryrun-registry', 'usher-dryrun-postgres']) quiet('rm', '-f', c);
  quiet('network', 'rm', NET);
}
function cleanup() {
  removeContainers();
}

async function until(what, test, seconds = 90) {
  for (let i = 0; i < seconds; i++) {
    if (await test().catch(() => false)) return true;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// One certificate for both hosts, from a throwaway certificate authority.
function makeCerts(dir) {
  const ssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Usher dry run CA', '-keyout', 'ca.key', '-out', 'ca.pem');
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${registryHost}`, '-keyout', 'tls.key', '-out', 'tls.csr');
  writeFileSync(join(dir, 'san.ext'), `subjectAltName=DNS:${registryHost},DNS:${siteHost}\n`);
  ssl('x509', '-req', '-in', 'tls.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-extfile', 'san.ext', '-out', 'tls.pem');
}

function registry(env) {
  quiet('rm', '-f', 'usher-dryrun-registry');
  const flags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  docker('run', '-d', '--name', 'usher-dryrun-registry', '--network', NET, '--network-alias', 'registry', '-v', `${certs}:/certs:ro`, '-e', 'NODE_EXTRA_CA_CERTS=/certs/ca.pem', ...flags, 'usher-dryrun-registry');
}

function site(siteKey) {
  quiet('rm', '-f', 'usher-dryrun-site');
  docker('run', '-d', '--name', 'usher-dryrun-site', '--network', NET, '--network-alias', 'site', '-v', `${certs}:/certs:ro`, '-e', 'NODE_EXTRA_CA_CERTS=/certs/ca.pem', '-e', 'NODE_ENV=production', '-e', `USHER_REGISTRY_URL=${registryUrl}`, '-e', `USHER_SITE_ORIGIN=${siteUrl}`, '-e', `USHER_ADMIN_KEY=${ADMIN_KEY}`, ...(siteKey ? ['-e', `USHER_SITE_KEY=${siteKey}`] : []), 'usher-dryrun-site');
}

const healthy = (url) => async () => (await fetch(`${url}/healthz`)).ok;

process.on('SIGINT', () => (cleanup(), process.exit(130)));
removeContainers();
try {
  console.log('building images…');
  execFileSync('docker', ['build', '-q', '-f', 'Dockerfile.registry', '-t', 'usher-dryrun-registry', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('docker', ['build', '-q', '-f', 'Dockerfile.mock-site', '-t', 'usher-dryrun-site', '.'], { cwd: root, stdio: 'ignore' });
  docker('network', 'create', NET);
  docker('run', '-d', '--name', 'usher-dryrun-postgres', '--network', NET, '--network-alias', 'postgres', '-e', 'POSTGRES_USER=usher', '-e', 'POSTGRES_PASSWORD=dryrun', '-e', 'POSTGRES_DB=usher', 'postgres:16-alpine');
  // The stand-in for CloudFront and the ALB answers to both host names, inside Docker and on this machine.
  docker('run', '-d', '--name', 'usher-dryrun-proxy', '--network', NET, '--network-alias', registryHost, '--network-alias', siteHost, '-p', '127.0.0.1:443:443',
    '-v', `${certs}:/certs:ro`, '-v', `${join(root, 'scripts/dryrun/proxy.mjs')}:/proxy.mjs:ro`,
    '-e', `ROUTES=${registryHost}=registry:4200,${siteHost}=site:4100`, '-e', 'CERT=/certs/tls.pem', '-e', 'KEY=/certs/tls.key', 'node:20-alpine', 'node', '/proxy.mjs');
  await until('postgres', async () => spawnSync('docker', ['exec', 'usher-dryrun-postgres', 'pg_isready', '-U', 'usher'], { stdio: 'ignore' }).status === 0);
  const signingKey = execFileSync('npm', ['run', '--silent', 'keygen'], { cwd: root, encoding: 'utf8' }).trim();
  const production = { NODE_ENV: 'production', REGISTRY_PUBLIC_URL: registryUrl, DATABASE_URL: DB, USHER_SIGNING_KEY: signingKey, USHER_DAILY_MODEL_BUDGET_USD: '1', USHER_ADMIN_KEY: ADMIN_KEY, USHER_CONTACT_EMAIL: 'security@dryrun.invalid', USHER_SEED: 'mock-site', USHER_SEED_ORIGIN: siteUrl, USHER_KEEPER_ORIGINS: siteUrl };

  // 1. Production mode.
  const { USHER_DAILY_MODEL_BUDGET_USD: _, ...noBudget } = production;
  const refused = spawnSync('docker', ['run', '--rm', '--network', NET, ...Object.entries(noBudget).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'usher-dryrun-registry'], { encoding: 'utf8' });
  check('production refuses to start without a spend cap', refused.status === 1 && /USHER_DAILY_MODEL_BUDGET_USD is required/.test(refused.stderr), refused.stderr.split('\n')[1]?.trim());
  registry(production);
  site();
  await until('registry', healthy(registryUrl));
  await until('demo site', healthy(siteUrl));
  const health = await (await fetch(`${registryUrl}/healthz`)).json();
  check('registry healthy on its public URL, on Postgres', health.ok && health.storage === 'postgres');
  const front = await fetch(`${registryUrl}/`);
  const frontText = await front.text();
  check('HSTS over https', /max-age=/.test(front.headers.get('strict-transport-security') ?? ''));
  check('front page tag points at the public /usher.js', frontText.includes(`src="${registryUrl}/usher.js"`) && frontText.includes(`data-usher-registry="${registryUrl}"`));
  check('front page links privacy', frontText.includes('href="/privacy"'));
  const version = await (await fetch(`${registryUrl}/usher/version.json`)).json();
  const cacheOf = async (path) => (await fetch(`${registryUrl}${path}`)).headers.get('cache-control');
  check('cache: versioned site script immutable, /usher.js short', (await cacheOf(version.path)) === 'public, max-age=31536000, immutable' && (await cacheOf('/usher.js')) === 'public, max-age=300');
  check('cache: dynamic pages no-store', front.headers.get('cache-control') === 'no-store' && (await cacheOf('/dashboard')) === 'no-store' && (await cacheOf('/sites/new')) === 'no-store');
  const privacy = await (await fetch(`${registryUrl}/privacy`)).text();
  check('privacy page names the contact', privacy.includes('mailto:security@dryrun.invalid'));
  check('robots.txt allows all', (await (await fetch(`${registryUrl}/robots.txt`)).text()).includes('Allow: /'));
  const security = await (await fetch(`${registryUrl}/.well-known/security.txt`)).text();
  check('security.txt has a contact and its canonical URL', security.includes('Contact: mailto:security@dryrun.invalid') && security.includes(`Canonical: ${registryUrl}/.well-known/security.txt`));
  const own = await (await fetch(`${registryUrl}/.well-known/usher-site.json`)).json();
  check('Usher\'s own site key is served', typeof own.site_key === 'string');
  const viewer = await fetch(`${registryUrl}/viewer`, { method: 'POST', body: new URLSearchParams({ url: `${siteUrl}/quote/driver` }) });
  check('map viewer is switched off in production', viewer.status === 404 && /switched off/.test(await viewer.text()) && !frontText.includes('Try it'));
  const shared = await fetch(`${registryUrl}/maps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"map":{}}' });
  check('agents\' maps are not accepted in production', shared.status === 403 && (await shared.json()).error === 'maps_closed');
  const discovery = await (await fetch(`${siteUrl}/.well-known/usher.json`)).json();
  check('demo site points agents at the public registry', discovery.knock_url === `${registryUrl}/knock`);
  const flip = await fetch(`${siteUrl}/__admin/variant`, { method: 'POST', body: new URLSearchParams({ variant: 'b' }), redirect: 'manual' });
  check('demo layout switch needs the admin key', flip.status === 401);

  // 2. The flows. The demo site is on a private address here, so claim checks must be allowed to
  // reach it; in AWS it is public and this setting stays off.
  // Seeding outside production also registers the site; its maps are already in the database.
  const { NODE_ENV: __, USHER_SEED: ___, USHER_SEED_ORIGIN: ____, ...flowsEnv } = production;
  registry({ ...flowsEnv, TRUSTED_PROXY_HOPS: '2', USHER_ALLOW_PRIVATE: '1' });
  await until('registry', healthy(registryUrl));

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ acceptDownloads: true });
  await page.goto(`${registryUrl}/sites/new`);
  await page.getByLabel("Your site's address").fill(`${siteUrl}/quote/driver`);
  await page.getByRole('button', { name: 'Get my keys' }).click();
  const keys = await page.locator('body').innerText();
  const siteKey = /usp_[\w-]+/.exec(keys)?.[0];
  const secret = /uss_[\w-]+/.exec(keys)?.[0];
  check('signup: keys for the demo site\'s public origin', Boolean(siteKey && secret) && keys.includes(`For ${siteUrl}.`));
  await page.getByRole('link', { name: 'Next: the tag' }).click();
  const tag = await page.locator('pre').first().innerText();
  check('signup: the tag points at the public /usher.js', tag.includes(`<script src="${registryUrl}/usher.js"`) && tag.includes(`data-usher-registry="${registryUrl}"`), tag.split('\n')[0]);
  await page.getByRole('link', { name: "Next: prove it's yours" }).click();
  const claim = await page.locator('body').innerText();
  check('signup: the claim file is on the site\'s public origin', claim.includes(`${siteUrl}/.well-known/usher-site.json`));
  // The site now serves its key, as an owner would after adding the tag and the file.
  site(siteKey);
  await until('demo site', healthy(siteUrl));
  await page.getByRole('button', { name: 'Check now' }).click();
  check('signup: the claim passes and the dashboard opens', new URL(page.url()).pathname === '/dashboard' && /You're set up\./.test(await page.locator('body').innerText()));
  const cookie = (await page.context().cookies(registryUrl)).find((c) => c.name === 'usher_site');
  check('dashboard cookie is Secure and HttpOnly', Boolean(cookie?.secure && cookie.httpOnly));
  const quote = await (await fetch(`${siteUrl}/quote/driver`)).text();
  check('demo site\'s own tag points at the public registry', quote.includes(`src="${registryUrl}/usher.js"`) && quote.includes(`data-usher-site-key="${siteKey}"`));
  await browser.close();

  console.log('\nend to end (npm run e2e:remote) against the public URLs:');
  // Through NODE_OPTIONS, so the agent's MCP server (a child process) resolves the hosts the same way.
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${fileURLToPath(new URL('./resolve.mjs', import.meta.url))}`.trim() };
  const e2e = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'packages/agent/scripts/e2e-remote.ts', '--registry', registryUrl, '--site', siteUrl, '--secret', secret, '--admin-key', ADMIN_KEY], { cwd: root, stdio: 'inherit', env });
  const code = await new Promise((r) => e2e.on('exit', r));
  check('end to end', code === 0);
} catch (err) {
  check('dry run completed', false, err.message);
  for (const c of ['usher-dryrun-registry', 'usher-dryrun-site', 'usher-dryrun-proxy']) {
    const logs = spawnSync('docker', ['logs', '--tail', '20', c], { encoding: 'utf8' });
    console.error(`--- ${c} ---\n${logs.stdout}${logs.stderr}`);
  }
} finally {
  if (process.env.USHER_DRYRUN_KEEP !== '1') cleanup();
}
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed} of ${results.length} dry-run checks passed`);
process.exit(failed ? 1 : 0);
