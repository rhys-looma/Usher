// The registry server. Configured by environment (for deployment) with flags as local shortcuts.
//
//   npm run registry -- [--port 4200] [--data data/registry] [--seed mock-site --seed-origin <the demo site's URL>] [--allow-private]
//
// Environment (see DEPLOY.md):
//   PORT, HOST                      where to listen (default 4200, 127.0.0.1; 0.0.0.0 in containers)
//   REGISTRY_PUBLIC_URL             the URL agents and sites use; the token issuer (without it, the
//                                   address it listens on, for local use)
//   DATABASE_URL                    Postgres; without it, JSON files under USHER_DATA_DIR
//   USHER_SIGNING_KEY               the token signing key, a private Ed25519 JWK (npm run keygen)
//   USHER_RETIRED_KEYS              JSON array of earlier public JWKs, still published
//   MODEL_API_KEY, BASETEN_API_KEY  model access; USHER_OPEN_MODEL picks the Spark Open id
//   USHER_DAILY_MODEL_BUDGET_USD    hard daily cap on model spend (default 5)
//   USHER_ALLOW_PRIVATE=1           let the map viewer open private addresses, domain claims check local
//                                   origins, and agents' key directories be served over http (local demos only)
//   TRUSTED_PROXY_HOPS              proxies in front whose forwarded headers are trusted (default 2 in
//                                   production: CloudFront, then the ALB; 0 elsewhere)
//   USHER_KEEPER_INTERVAL_MIN       minutes between keeper runs over every known form (default 360; 0 off)
//   USHER_ACCEPT_MAPS=0             stop accepting maps from agents (accepted by default: private to
//                                   their agent until a second agent or the keeper verifies them)
//   USHER_KEEPER_ORIGINS            in production, the only origins the keeper opens (comma-separated;
//                                   none by default)
//   USHER_SEED, USHER_SEED_ORIGIN   seed maps for a demo site (USHER_SEED=mock-site)
//   USHER_DEMO_DASHBOARD_ORIGIN     the demo site whose dashboard anyone can read at /demo/dashboard
//                                   (default USHER_SEED_ORIGIN; "off" for none)
//   USHER_DEMO_KEEP_AGENTS          our own agent ids on it (comma-separated): other agents' sessions
//                                   there are kept 24 hours
//   USHER_HOSTED_MCP=off            no hosted MCP at /mcp (on by default; it opens joined sites in a
//                                   headless browser for usher_fill)
//   USHER_ADMIN_KEY                 signs in to /admin (the front page's interest list); no admin pages without it
//   USHER_CONTACT_EMAIL             named on /privacy and in /.well-known/security.txt
//   USHER_VIEWER=open               let the map viewer open any address (local demos only; refused in
//                                   production, where visitors pick from a fixed list of public forms)
//   USHER_VERSION                   what /status calls this build (the image's git SHA, set at build)
//   NODE_ENV=production             refuses to start without the settings a public deployment needs
//                                   (see production.ts), and never registers or dev-claims a seeded site
//   USHER_DEV_SITE_ORIGIN, USHER_DEV_SITE_KEY, USHER_DEV_SECRET_KEY
//                                   register one site with fixed keys (local development only)

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Browser } from 'playwright';
import { hostedMcp } from '../../mcp/src/hosted.ts';
import { budgeted, compilerModel, modelApi, openModel, type ChatFn, type PrivateJwk, type PublicJwk, type SpendLedger } from '@usher/core';
import { loadDotEnv } from '../../core/src/compile/env.ts';
import { startRegistry } from './http.ts';
import { PostgresStorage } from './postgres.ts';
import { isProduction, productionProblems, proxyHops } from './production.ts';
import { seed } from './seed.ts';
import { pickerForms } from './web/picker.ts';
import { FileStorage, type Storage } from './storage.ts';

loadDotEnv();
const env = process.env;
const production = isProduction(env);
if (production) {
  const problems = productionProblems(env);
  if (problems.length) {
    console.error(`Not starting: NODE_ENV=production needs\n${problems.map((p) => `  - ${p}`).join('\n')}\nSee DEPLOY.md.`);
    process.exit(1);
  }
}

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: env.PORT ?? '4200' },
    host: { type: 'string', default: env.HOST ?? '127.0.0.1' },
    data: { type: 'string', default: env.USHER_DATA_DIR ?? fileURLToPath(new URL('../../../data/registry', import.meta.url)) },
    url: { type: 'string', ...(env.REGISTRY_PUBLIC_URL && { default: env.REGISTRY_PUBLIC_URL }) },
    seed: { type: 'string', ...(env.USHER_SEED && { default: env.USHER_SEED }) },
    'seed-origin': { type: 'string', ...(env.USHER_SEED_ORIGIN && { default: env.USHER_SEED_ORIGIN }) },
    threshold: { type: 'string' },
    'allow-private': { type: 'boolean', default: env.USHER_ALLOW_PRIVATE === '1' },
    'explain-open': { type: 'boolean', default: env.USHER_EXPLAIN_OPEN === '1' },
  },
});

function json<T>(name: string): T | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${name} is not valid JSON.`);
  }
}

const storage: Storage = env.DATABASE_URL ? await PostgresStorage.connect({ connectionString: env.DATABASE_URL }) : new FileStorage(values.data);

// Every model call counts against one daily budget, kept in storage so restarts don't reset it.
const budget = Number(env.USHER_DAILY_MODEL_BUDGET_USD ?? 5);
const ledger: SpendLedger = {
  spent: async (day) => (await storage.getCached<{ usd: number }>('spend', day))?.usd ?? 0,
  add: async (day, usd) => storage.putCached('spend', day, { usd: ((await storage.getCached<{ usd: number }>('spend', day))?.usd ?? 0) + usd }),
};
const capped = (chat: ChatFn) => budgeted(chat, budget, ledger);
const today = () => new Date().toISOString().slice(0, 10);
const spentToday = () => ledger.spent(today());
const spark = env.MODEL_API_KEY ? { chat: capped(modelApi()), model: compilerModel() } : undefined;
const open = env.BASETEN_API_KEY ? { chat: capped(modelApi({ provider: 'baseten' })), model: openModel() } : undefined;

const explainer = values['explain-open'] ? (open ?? spark) : (spark ?? open);
const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
const signingKey = json<PrivateJwk>('USHER_SIGNING_KEY');
const retiredKeys = json<PublicJwk[]>('USHER_RETIRED_KEYS');
// Hosted MCP: one headless browser for every connection (relaunched if it goes), a fresh context per fill.
let browser: Promise<Browser> | undefined;
const hostedBrowser = async () => {
  const current = browser && (await browser.catch(() => undefined));
  if (!current?.isConnected()) browser = import('playwright').then(({ chromium }) => chromium.launch({ headless: true }));
  return browser!;
};
const demoOrigin = (env.USHER_DEMO_DASHBOARD_ORIGIN ?? values['seed-origin'] ?? '').trim().replace(/\/$/, '');
const running = await startRegistry({
  storage,
  ...(demoOrigin && demoOrigin !== 'off' && { publicDemo: { origin: demoOrigin, keepAgents: (env.USHER_DEMO_KEEP_AGENTS ?? '').split(',').map((a) => a.trim()).filter(Boolean) } }),
  ...(env.USHER_HOSTED_MCP !== 'off' && {
    // The registry's own model for pages with no map, within the same daily cap.
    mcp: (registry) => hostedMcp({ registry, version: env.USHER_VERSION || 'dev', browser: hostedBrowser, allowPrivate: values['allow-private'], ...(spark && { fallback: { chat: spark.chat, model: spark.model, logDir: null } }) }),
  }),
  port: Number(values.port),
  host: values.host,
  siteScript,
  proxyHops: proxyHops(env),
  // Agents' maps are shared with every other agent: closed in production unless USHER_ACCEPT_MAPS=1.
  // Agents' maps are accepted and kept private to their agent until verified (USHER_ACCEPT_MAPS=0 closes them).
  acceptMaps: env.USHER_ACCEPT_MAPS !== '0',
  hsts: (values.url ?? '').startsWith('https://'),
  ...(signingKey && { signingKey }),
  ...(retiredKeys && { retiredKeys }),
  ...(values['allow-private'] && { claims: { allowPrivate: true }, directories: { allowHttp: true } }),
  web: {
    // Public addresses only, unless explicitly allowed for a local demo.
    allowPrivate: values['allow-private'],
    ...(env.USHER_ADMIN_KEY && { adminKey: env.USHER_ADMIN_KEY }),
    ...(env.USHER_CONTACT_EMAIL && { contact: env.USHER_CONTACT_EMAIL }),
    // The map viewer: a fixed list of public forms (and owners' own pages); any address only for
    // local demos (USHER_VIEWER=open, refused in production).
    viewer: env.USHER_VIEWER === 'open' || env.USHER_VIEWER === '1' ? 'open' : 'picker',
    forms: pickerForms(env.USHER_SEED_ORIGIN),
    // /status: the image's git SHA (baked in at build) and the spend against the cap.
    status: { version: env.USHER_VERSION || 'dev', spend: { today: spentToday, cap: budget } },
    // The picker refresh loads nothing once today's budget is spent.
    overBudget: async () => (await spentToday()) >= budget,
    // The viewer's second opinion on risk, from Muse Spark Open.
    ...(open && { classifier: open }),
  },
  // Muse Spark compiles maps for the viewer and turns owners' English into policy.
  ...(spark && { chat: spark.chat, model: spark.model }),
  // Session explanations: Muse Spark, or Spark Open (--explain-open, for self-hosters).
  ...(explainer && { explainer }),
  // The keeper: Spark Open triages a changed form, Muse Spark recompiles it when the change is real.
  keeper: {
    intervalMinutes: Number(env.USHER_KEEPER_INTERVAL_MIN ?? 360),
    // In production only the listed origins (our own demo site): it opens pages in a browser.
    ...(production && { origins: (env.USHER_KEEPER_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean) }),
    ...(spark && { compiler: spark }),
    ...(open && { triage: open }),
  },
  ...(values.url && { url: values.url }),
  ...(values.threshold && { threshold: Number(values.threshold) }),
});

if (values.seed) {
  const origin = values['seed-origin'];
  if (!origin) throw new Error('--seed needs the demo site\'s URL: --seed-origin <url> or USHER_SEED_ORIGIN.');
  const maps = await seed(running.registry, values.seed, origin);
  console.log(`seeded ${maps.length} maps for ${origin}`);
  // The demo site's name read afresh on each start (it may have changed with the deploy); never fatal.
  void running.registry.siteName(origin, { fresh: true }).catch(() => undefined);
  // In production a site registers through /sites/new and proves its domain like any other.
  if (!env.USHER_DEV_SITE_ORIGIN && !production) {
    const site = await running.registry.registerSite({ origin });
    if (site.status === 201) {
      // Seeding is for the local mock site: its claim is the development one.
      await running.registry.claimForDevelopment(origin);
      const { site_key, secret_key } = site.body as { site_key: string; secret_key: string };
      console.log(`registered ${origin}\n  site key (script tag, USHER_SITE_KEY): ${site_key}\n  secret key (sessions, dashboard; shown once): ${secret_key}`);
    }
  }
}
if (env.USHER_DEV_SITE_ORIGIN && env.USHER_DEV_SITE_KEY && env.USHER_DEV_SECRET_KEY) {
  // Fixed keys, so a local docker compose setup can wire the mock site without a manual step.
  await running.registry.ensureSite(env.USHER_DEV_SITE_ORIGIN, env.USHER_DEV_SITE_KEY, env.USHER_DEV_SECRET_KEY);
  console.log(`registered ${env.USHER_DEV_SITE_ORIGIN} with the configured development keys`);
}
// Usher's own site (the front page's interest form) proves its origin with the file this server
// serves; re-checked daily like any site's.
const own = await running.registry.ownSite();
if (!own.claim) void running.registry.verifySiteFor(own.origin).catch(() => undefined);
console.log(
  `Usher registry on ${running.url} (listening ${values.host}:${values.port}${production ? '; production' : ''}; storage ${env.DATABASE_URL ? 'postgres' : values.data}; model budget $${budget}/day${spark ? '' : '; no MODEL_API_KEY'}${signingKey ? '; signing key from USHER_SIGNING_KEY' : ''})`,
);

// A daily line in the logs: the model spend against the cap, at start (today so far) and for each
// UTC day once it ends.
const logSpend = async (day: string, final: boolean) =>
  console.log(JSON.stringify({ event: 'daily_model_spend', day, spent_usd: Math.round((await ledger.spent(day)) * 1e4) / 1e4, cap_usd: budget, final }));
let spendDay = today();
void logSpend(spendDay, false).catch(() => undefined);
setInterval(() => {
  if (today() === spendDay) return;
  const ended = spendDay;
  spendDay = today();
  void logSpend(ended, true).catch(() => undefined);
}, 600_000).unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void running.close().finally(() => process.exit(0));
  });
}
