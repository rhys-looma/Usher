// Re-records the model's labels for every mock-site step and layout (needs MODEL_API_KEY).

import { withMockSites } from './mock-sites.mjs';

await withMockSites(process.execPath, ['--import', 'tsx', 'packages/core/scripts/record-fixtures.ts']);
