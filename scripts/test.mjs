// Root test runner: starts the mock quote site in layouts A and B on free ports, runs every
// workspace's tests against them, then stops both. Exits with the tests' exit code.

import { withMockSites } from './test/mock-sites.mjs';

await withMockSites(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test', '--workspaces', '--if-present']);
