// Seed maps: the compiled mock-site maps (layout A), rewritten to the mock site's origin.

import { readFile, readdir } from 'node:fs/promises';
import type { UsherMap, UsherPolicy } from '@usher/core';
import type { Registry } from './registry.ts';

export const SEED_DIR = new URL('../seed/', import.meta.url);

export async function seedMaps(name: string): Promise<UsherMap[]> {
  const dir = new URL(`${name}/`, SEED_DIR);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.map.json')).sort();
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(new URL(f, dir), 'utf8')) as UsherMap));
}

/** The site's rules in plain words, beside a seed's policy.json. */
const SEED_RULES = 'Assistants may fill the quote. Your user confirms their smoking answer, the declaration and "Get my quote" in Brightwater\'s own words before you act. Health answers, card and bank details and passwords are theirs alone.';

export async function seed(registry: Registry, name: string, origin: string): Promise<UsherMap[]> {
  const maps = (await seedMaps(name)).map((m) => ({ ...m, origin }));
  for (const map of maps) await registry.addMap(map);
  // The seed's policy, unless the site's owner has set their own since (a seeded one is replaced).
  const policy = await readFile(new URL(`${name}/policy.json`, SEED_DIR), 'utf8').then((t) => JSON.parse(t) as UsherPolicy, () => undefined);
  if (policy) await registry.seedPolicy({ ...policy, origin }, SEED_RULES);
  // How each journey is picked up afterwards on the site (the plans' resume), as the seed says.
  const resume = await readFile(new URL(`${name}/resume.json`, SEED_DIR), 'utf8').then((t) => JSON.parse(t) as Record<string, unknown>, () => undefined);
  for (const [intent, entry] of Object.entries(resume ?? {})) await registry.setSiteResume(origin, intent, entry);
  // The demo site's assistant app is on, unless its owner has set it otherwise.
  if (policy && !(await registry.storage.getCached('site-app', origin))) await registry.setSiteApp(origin, { enabled: true });
  return maps;
}
