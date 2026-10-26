// Seed maps: the compiled mock-site maps (layout A), rewritten to the mock site's origin.

import { readFile, readdir } from 'node:fs/promises';
import type { UsherMap } from '@usher/core';
import type { Registry } from './registry.ts';

export const SEED_DIR = new URL('../seed/', import.meta.url);

export async function seedMaps(name: string): Promise<UsherMap[]> {
  const dir = new URL(`${name}/`, SEED_DIR);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.map.json')).sort();
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(new URL(f, dir), 'utf8')) as UsherMap));
}

export async function seed(registry: Registry, name: string, origin: string): Promise<UsherMap[]> {
  const maps = (await seedMaps(name)).map((m) => ({ ...m, origin }));
  for (const map of maps) await registry.addMap(map);
  return maps;
}
