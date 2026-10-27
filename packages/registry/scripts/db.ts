// Database tasks for a Postgres registry (DATABASE_URL):
//   npm run db -- migrate
//   npm run db -- seed --origin <url>     the compiled mock-site maps, for the demo site at <url> (or USHER_SEED_ORIGIN)
import { parseArgs } from 'node:util';
import { PostgresStorage, Registry, seed } from '../src/index.ts';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { origin: { type: 'string', ...(process.env.USHER_SEED_ORIGIN && { default: process.env.USHER_SEED_ORIGIN }) } } });
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL.');
  process.exit(2);
}
const storage = await PostgresStorage.connect({ connectionString: url });
try {
  if (positionals[0] === 'migrate') {
    console.log('migrations are up to date');
  } else if (positionals[0] === 'seed') {
    if (!values.origin) throw new Error('seed needs the demo site\'s URL: --origin <url> or USHER_SEED_ORIGIN.');
    const maps = await seed(new Registry({ storage, url: 'http://unused' }), 'mock-site', values.origin);
    console.log(`seeded ${maps.length} mock-site maps for ${values.origin}`);
  } else {
    console.error('Usage: npm run db -- migrate | seed [--origin …]');
    process.exitCode = 2;
  }
} finally {
  await storage.close();
}
