// How the agent reaches its user: a terminal prompt, or a scripted user for tests.

import { createInterface } from 'node:readline/promises';
import type { Page } from 'playwright';
import type { MapAction, MapField } from '@usher/core';
import type { Profile, UserChannel } from './agent.ts';

/** Asks in the terminal. needs_user fields are completed by the user in the (headed) browser. */
export function terminalUser(): UserChannel {
  const ask = async (question: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
  return {
    async confirm(action: MapAction | MapField) {
      const answer = await ask(`The agent is about to act on "${action.label}" (${action.key}, ${action.risk}). Go ahead? [y/N] `);
      return /^y(es)?$/i.test(answer.trim());
    },
    async handoff(field: MapField) {
      await ask(`Over to you: "${field.label}" (${field.key}) is yours to answer in the browser. Press Enter when done. `);
    },
  };
}

/**
 * A scripted user for tests and --auto-confirm: confirms every consequential action, and
 * answers needs_user fields from the profile as the user would, in the page.
 */
export function scriptedUser(profile: Profile, options: { confirm?: boolean } = {}): UserChannel & { confirmations: string[]; handoffs: string[] } {
  const confirmations: string[] = [];
  const handoffs: string[] = [];
  return {
    confirmations,
    handoffs,
    async confirm(action: MapAction | MapField) {
      confirmations.push(action.key);
      return options.confirm ?? true;
    },
    async handoff(field: MapField, page: Page) {
      handoffs.push(field.key);
      if (field.control === 'checkbox' && profile[field.key] === true) await page.getByLabel(field.label, { exact: true }).check();
    },
  };
}
