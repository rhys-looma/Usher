// Adds maps built elsewhere to a registry as its own (POST /admin/maps): for instance the Aviva life
// captures mapped by Muse Spark (packages/core/test/fixtures/real/aviva-life/*.map.json). Structure
// only. Then list the site for hosted Usher at /admin/sites if it hasn't joined.
//
//   USHER_ADMIN_KEY=… npm run maps:import -- <registry URL> <file.map.json>…
//
// The admin key comes from the environment only; it is never printed.

import { readFileSync } from 'node:fs';

const [registry, ...files] = process.argv.slice(2);
const key = process.env.USHER_ADMIN_KEY;
if (!registry || !files.length || !key) {
  console.error('Usage: USHER_ADMIN_KEY=… npm run maps:import -- <registry URL> <file.map.json>…');
  process.exit(2);
}
const maps = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
const res = await fetch(`${registry.replace(/\/$/, '')}/admin/maps`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ maps }) });
console.log(`HTTP ${res.status} ${(await res.text()).slice(0, 600)}`);
process.exit(res.ok ? 0 : 1);
