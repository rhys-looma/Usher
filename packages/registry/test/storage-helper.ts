// The storage tests run against: Postgres when DATABASE_URL is set (a schema per directory, so a
// restart reconnects to the same data), otherwise the JSON-file store.

import { createHash } from 'node:crypto';
import { FileStorage, PostgresStorage, type Storage } from '../src/index.ts';

export async function testStorage(dir: string): Promise<Storage> {
  const url = process.env.DATABASE_URL;
  if (!url) return new FileStorage(dir);
  const schema = `t_${createHash('sha256').update(dir).digest('hex').slice(0, 16)}`;
  return PostgresStorage.connect({ connectionString: url, schema, max: 4 });
}
