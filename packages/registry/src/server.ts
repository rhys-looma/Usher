// npm run registry -- [--port 4200] [--data data/registry] [--seed mock-site --seed-origin http://localhost:4100]

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startRegistry } from './http.ts';
import { seed } from './seed.ts';
import { FileStorage } from './storage.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.PORT ?? '4200' },
    data: { type: 'string', default: fileURLToPath(new URL('../../../data/registry', import.meta.url)) },
    url: { type: 'string' },
    seed: { type: 'string' },
    'seed-origin': { type: 'string', default: 'http://localhost:4100' },
    threshold: { type: 'string' },
  },
});

const siteScript = fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url));
const running = await startRegistry({
  storage: new FileStorage(values.data),
  port: Number(values.port),
  siteScript,
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
