// An agent's key pair on disk. The private key stays on the agent's machine.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateAgentIdentity, importAgentIdentity, type AgentIdentity } from '@usher/core/identity';
import type { PrivateJwk } from '@usher/core/token';

export const DEFAULT_KEY_FILE = join(homedir(), '.usher', 'agent-key.json');

/** Loads the agent's key, creating one (readable only by the user) on first use. */
export async function loadOrCreateIdentity(path: string = DEFAULT_KEY_FILE): Promise<AgentIdentity> {
  try {
    return await importAgentIdentity(JSON.parse(await readFile(path, 'utf8')) as PrivateJwk);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const { identity, privateJwk } = await generateAgentIdentity();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(privateJwk)}\n`, { mode: 0o600 });
  return identity;
}
