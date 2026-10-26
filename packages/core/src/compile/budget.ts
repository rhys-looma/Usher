// A hard daily cap on model spend (LU-52). Wraps any ChatFn: once the day's spend reaches the cap,
// calls fail with BudgetExceeded until the next UTC day.

import { costUsd, type ChatFn } from './model.ts';

export class BudgetExceeded extends Error {
  constructor(readonly limitUsd: number) {
    super(`Today's model budget ($${limitUsd.toFixed(2)}) is used up. Try again tomorrow (UTC).`);
    this.name = 'BudgetExceeded';
  }
}

/** Where spend is kept, by UTC day (YYYY-MM-DD). */
export interface SpendLedger {
  spent(day: string): Promise<number>;
  add(day: string, usd: number): Promise<void>;
}

export function budgeted(chat: ChatFn, limitUsd: number, ledger: SpendLedger, now: () => Date = () => new Date()): ChatFn {
  return async (request) => {
    const day = now().toISOString().slice(0, 10);
    if ((await ledger.spent(day)) >= limitUsd) throw new BudgetExceeded(limitUsd);
    const result = await chat(request);
    await ledger.add(day, costUsd(request.model, result.usage) ?? 0);
    return result;
  };
}
