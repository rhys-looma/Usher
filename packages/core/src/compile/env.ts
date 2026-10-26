import { fileURLToPath } from 'node:url';

/** Loads .env from the repository root into process.env, if there is one. Existing variables win. */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../../.env', import.meta.url)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
