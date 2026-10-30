// Builds the bundles that run outside tsx: the server-side check (for the mock site, which
// has no dependencies) and the site script.

import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

// @usher-run/mcp: the MCP server as one file for npm, every dependency bundled in.
const mcp = JSON.parse(await readFile(new URL('../packages/mcp/package.json', import.meta.url), 'utf8'));
await build({
  absWorkingDir: root,
  entryPoints: ['packages/mcp/src/cli.ts'],
  outfile: 'packages/mcp/dist/cli.js',
  minify: true,
  // The browser for usher_fill: installed with the package (a dependency), never bundled.
  external: ['playwright', 'playwright-core', 'chromium-bidi'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  // Bundled CommonJS dependencies call require; give them one.
  // Node 20 calls Ed25519 in WebCrypto experimental and says so on stderr; MCP clients show that
  // as noise, so only that warning is dropped.
  banner: {
    js: [
      '#!/usr/bin/env node',
      '// @usher-run/mcp. Apache-2.0. https://github.com/rhys-looma/Usher',
      "import { createRequire as __usherRequire } from 'node:module';",
      'const require = __usherRequire(import.meta.url);',
      "{ const shown = process.listeners('warning'); process.removeAllListeners('warning'); process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') for (const show of shown) show(w); }); }",
    ].join('\n'),
  },
  define: {
    USHER_MCP_VERSION: JSON.stringify(mcp.version),
    USHER_DEFAULT_REGISTRY: JSON.stringify(mcp.usher.defaultRegistry),
    USHER_DEMO_FORM: JSON.stringify(mcp.usher.demoForm),
  },
  logLevel: 'warning',
});
console.log('built packages/mcp/dist/cli.js');

// The demo sites built as apps (examples/sites): Kestrel in React, Hollyhock in Vue. Served by
// the sites' own server from public/, so the strict CSP holds. Skipped where the sites aren't
// copied in (the registry's image).
for (const [entry, out] of [
  ['examples/sites/apps/kestrel.jsx', 'examples/sites/public/kestrel.app.js'],
  ['examples/sites/apps/hollyhock.js', 'examples/sites/public/hollyhock.app.js'],
]) {
  if (!existsSync(new URL(`../${entry}`, import.meta.url))) continue;
  await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    minify: true,
    jsx: 'automatic',
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'false', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
    logLevel: 'warning',
  });
  console.log(`built ${out}`);
}
