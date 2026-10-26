// Database tasks for a Postgres registry (DATABASE_URL):
//   npm run db -- migrate
//   npm run db -- seed [--origin http://localhost:4100]     the compiled mock-site maps
import { parseArgs } from 'node:util';
import { PostgresStorage, Registry, seed } from '../src/index.ts';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { origin: { type: 'string', default: 'http://localhost:4100' } } });
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
    const maps = await seed(new Registry({ storage, url: 'http://unused' }), 'mock-site', values.origin);
    console.log(`seeded ${maps.length} mock-site maps for ${values.origin}`);
  } else {
    console.error('Usage: npm run db -- migrate | seed [--origin …]');
    process.exitCode = 2;
  }
} finally {
  await storage.close();
}
