// The registry server. Configured by environment (for deployment) with flags as local shortcuts.
//
//   npm run registry -- [--port 4200] [--data data/registry] [--seed mock-site --seed-origin http://localhost:4100] [--allow-private]
//
// Environment (see DEPLOY.md):
//   PORT, HOST                      where to listen (default 4200, 127.0.0.1; 0.0.0.0 in containers)
//   REGISTRY_PUBLIC_URL             the URL agents and sites use; the token issuer
//   DATABASE_URL                    Postgres; without it, JSON files under USHER_DATA_DIR
//   USHER_SIGNING_KEY               the token signing key, a private Ed25519 JWK (npm run keygen)
//   USHER_RETIRED_KEYS              JSON array of earlier public JWKs, still published
//   MODEL_API_KEY, BASETEN_API_KEY  model access; USHER_OPEN_MODEL picks the Spark Open id
//   USHER_DAILY_MODEL_BUDGET_USD    hard daily cap on model spend (default 5)
//   USHER_ALLOW_PRIVATE=1           let the map viewer open private addresses (local demos only)
//   USHER_TRUST_PROXY=1             take the client address from X-Forwarded-For (behind a proxy)
//   USHER_SEED, USHER_SEED_ORIGIN   seed maps for a demo site (USHER_SEED=mock-site)
//   USHER_DEV_SITE_ORIGIN, USHER_DEV_SITE_KEY, USHER_DEV_SECRET_KEY
//                                   register one site with fixed keys (local development only)

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { budgeted, compilerModel, modelApi, openModel, type ChatFn, type PrivateJwk, type PublicJwk, type SpendLedger } from '@usher/core';
import { loadDotEnv } from '../../core/src/compile/env.ts';
import { startRegistry } from './http.ts';
import { PostgresStorage } from './postgres.ts';
import { seed } from './seed.ts';
import { FileStorage, type Storage } from './storage.ts';

loadDotEnv();
const env = process.env;

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: env.PORT ?? '4200' },
    host: { type: 'string', default: env.HOST ?? '127.0.0.1' },
    data: { type: 'string', default: env.USHER_DATA_DIR ?? fileURLToPath(new URL('../../../data/registry', import.meta.url)) },
    url: { type: 'string', ...(env.REGISTRY_PUBLIC_URL && { default: env.REGISTRY_PUBLIC_URL }) },
    seed: { type: 'string', ...(env.USHER_SEED && { default: env.USHER_SEED }) },
    'seed-origin': { type: 'string', default: env.USHER_SEED_ORIGIN ?? 'http://localhost:4100' },
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
const spark = env.MODEL_API_KEY ? { chat: capped(modelApi()), model: compilerModel() } : undefined;
const open = env.BASETEN_API_KEY ? { chat: capped(modelApi({ provider: 'baseten' })), model: openModel() } : undefined;

const explainer = values['explain-open'] ? (open ?? spark) : (spark ?? open);
const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
const signingKey = json<PrivateJwk>('USHER_SIGNING_KEY');
const retiredKeys = json<PublicJwk[]>('USHER_RETIRED_KEYS');
const running = await startRegistry({
  storage,
  port: Number(values.port),
  host: values.host,
  siteScript,
  trustProxy: env.USHER_TRUST_PROXY === '1',
  hsts: (values.url ?? '').startsWith('https://'),
  ...(signingKey && { signingKey }),
  ...(retiredKeys && { retiredKeys }),
  web: {
    // Public addresses only, unless explicitly allowed for a local demo.
    allowPrivate: values['allow-private'],
    // The viewer's second opinion on risk, from Muse Spark Open.
    ...(open && { classifier: open }),
  },
  // Muse Spark compiles maps for the viewer and turns owners' English into policy.
  ...(spark && { chat: spark.chat, model: spark.model }),
  // Session explanations: Muse Spark, or Spark Open (--explain-open, for self-hosters).
  ...(explainer && { explainer }),
  ...(values.url && { url: values.url }),
  ...(values.threshold && { threshold: Number(values.threshold) }),
});

if (values.seed) {
  const origin = values['seed-origin'];
  const maps = await seed(running.registry, values.seed, origin);
  console.log(`seeded ${maps.length} maps for ${origin}`);
  if (!env.USHER_DEV_SITE_ORIGIN) {
    const site = await running.registry.registerSite({ origin });
    if (site.status === 201) {
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
console.log(
  `Usher registry on ${running.url} (listening ${values.host}:${values.port}; storage ${env.DATABASE_URL ? 'postgres' : values.data}; model budget $${budget}/day${spark ? '' : '; no MODEL_API_KEY'}${signingKey ? '; signing key from USHER_SIGNING_KEY' : ''})`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void running.close().finally(() => process.exit(0));
  });
}
