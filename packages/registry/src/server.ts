// npm run registry -- [--port 4200] [--data data/registry] [--seed mock-site --seed-origin http://localhost:4100]

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startRegistry } from './http.ts';
import { seed } from './seed.ts';
import { FileStorage } from './storage.ts';
import { compilerModel, modelApi, openModel } from '@usher/core';
import { loadDotEnv } from '../../core/src/compile/env.ts';

loadDotEnv();

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.PORT ?? '4200' },
    data: { type: 'string', default: fileURLToPath(new URL('../../../data/registry', import.meta.url)) },
    url: { type: 'string' },
    seed: { type: 'string' },
    'seed-origin': { type: 'string', default: 'http://localhost:4100' },
    threshold: { type: 'string' },
    'allow-private': { type: 'boolean', default: false },
    'explain-open': { type: 'boolean', default: false },
  },
});

const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
const running = await startRegistry({
  storage: new FileStorage(values.data),
  port: Number(values.port),
  siteScript,
  // The map viewer opens only public sites unless --allow-private (for the local demo).
  web: {
    allowPrivate: values['allow-private'],
    // The viewer's second opinion on risk, from Muse Spark Open, when a Baseten key is set.
    ...(process.env.BASETEN_API_KEY && { classifier: { chat: modelApi({ provider: 'baseten' }), model: openModel() } }),
  },
  // Muse Spark turns owners' plain-English rules into policy, when a key is set.
  ...(process.env.MODEL_API_KEY && { chat: modelApi(), model: compilerModel() }),
  // Session explanations: Muse Spark, or Muse Spark Open on Baseten with --explain-open.
  ...(values['explain-open'] && process.env.BASETEN_API_KEY
    ? { explainer: { chat: modelApi({ provider: 'baseten' }), model: openModel() } }
    : process.env.MODEL_API_KEY && { explainer: { chat: modelApi(), model: compilerModel() } }),
  ...(values.url && { url: values.url }),
  ...(values.threshold && { threshold: Number(values.threshold) }),
});
if (values.seed) {
  const origin = values['seed-origin'];
  const maps = await seed(running.registry, values.seed, origin);
  console.log(`seeded ${maps.length} maps for ${origin}`);
  const site = await running.registry.registerSite({ origin });
  if (site.status === 201) {
    const { site_key, secret_key } = site.body as { site_key: string; secret_key: string };
    console.log(`registered ${origin}\n  site key (script tag, USHER_SITE_KEY): ${site_key}\n  secret key (sessions, dashboard; shown once): ${secret_key}`);
  }
}
console.log(`Usher registry on ${running.url}  (data ${values.data})`);
