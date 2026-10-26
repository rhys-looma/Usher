// Builds the bundles that run outside tsx: the server-side check (for the mock site, which
// has no dependencies) and the site script.

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

// The site script: one file sites load with a single tag.
await build({
  absWorkingDir: root,
  entryPoints: ['packages/site-script/src/main.ts'],
  outfile: 'packages/site-script/dist/usher.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  banner: { js: '/* Usher site script. Apache-2.0. https://github.com/rhys-looma/Usher */' },
  logLevel: 'warning',
});
console.log('built packages/site-script/dist/usher.js');
