// npm run check:urls: fails if a local or production URL is written into the code or docs. The
// registry's public address comes from REGISTRY_PUBLIC_URL; local addresses are derived from what a
// server actually listens on. Only tests and the Compose file may name one.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?![\w.-])|usher\.run/i;

// Tests (and what only tests read: fixtures, recordings), the Compose file, and the untracked report.
// @usher-run/mcp is the published client for the public registry: its manifest and README name it.
// Recorded results of runs against the live deployment name it, as fixtures do.
const ALLOWED = [/^packages\/mcp\/(package\.json|README\.md)$/, /^examples\/browser-use\/results\.jsonl$/, /^REPORT\.md$/, /(^|\/)test\//, /\.test\.[cm]?[jt]s$/, /(^|\/)fixtures\//, /^docker-compose\.ya?ml$/, /^scripts\/check-urls\.mjs$/, /^package-lock\.json$/];

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const found = [];
for (const file of files) {
  if (ALLOWED.some((a) => a.test(file))) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  text.split('\n').forEach((line, i) => {
    if (PATTERN.test(line)) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 140)}`);
  });
}
if (found.length) {
  console.error(`${found.length} hard-coded URL${found.length === 1 ? '' : 's'} (use REGISTRY_PUBLIC_URL, or derive the address from the server):\n${found.join('\n')}`);
  process.exit(1);
}
console.log('No hard-coded localhost or usher.run URLs outside tests and docker-compose.yml.');
