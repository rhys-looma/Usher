// How the agent reaches its user: a terminal prompt, or a scripted user for tests.

import { createInterface } from 'node:readline/promises';
import type { Page } from 'playwright';
import type { MapAction, MapField } from '@usher/core';
import { fillField, type Correction, type Profile, type UserChannel } from './agent.ts';

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
    async correct(problem: Correction) {
      const answer = await ask(`"${problem.label}" (${problem.key}): ${problem.message}${problem.expected ? ` Expected: ${problem.expected}.` : ''} Corrected value (Enter to skip): `);
      if (!answer.trim()) return null;
      return /^(true|false)$/i.test(answer.trim()) ? answer.trim().toLowerCase() === 'true' : answer.trim();
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
      // The person's own answer, as a person would give it: a consent ticked, a choice such as
      // whether they smoke. Never a sensitive key (health.*): those stay with the person.
      const answer = profile[field.key];
      if (field.sensitive || answer === undefined) return;
      if (field.control === 'checkbox') {
        if (answer === true) await page.getByLabel(field.label, { exact: true }).check();
      } else await fillField(page, field, answer);
    },
  };
}
