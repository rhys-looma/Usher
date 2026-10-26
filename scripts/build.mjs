// Builds the bundles that run outside tsx: the server-side check (for the mock site, which
// has no dependencies) and, later, the site script.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: ['packages/site-middleware/src/index.ts'],
  outfile: 'packages/site-middleware/dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
});
console.log('built packages/site-middleware/dist/index.js');
