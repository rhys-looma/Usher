// node scripts/with-mock-sites.mjs <command> [args…]: runs a command with the mock site
// started in layouts A and B (URLs in USHER_MOCK_A and USHER_MOCK_B).

import { withMockSites } from './mock-sites.mjs';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('Usage: node scripts/with-mock-sites.mjs <command> [args…]');
  process.exit(2);
}
await withMockSites(command === 'node' ? process.execPath : command, args);
