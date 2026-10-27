// Re-records the model's labels for every mock-site step and layout (needs MODEL_API_KEY, or
// BASETEN_API_KEY with --open).

import { withMockSites } from './test/mock-sites.mjs';

await withMockSites(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'packages/core/scripts/record-fixtures.ts', ...process.argv.slice(2)]);
