// A deterministic morning of agent activity on the mock quote site, for explanation tests.

import type { UsherMap } from '@usher/core';
import { seedMaps, type Session, type SessionEvent } from '../src/index.ts';

export const ORIGIN = 'http://localhost:4100';

export async function maps(): Promise<UsherMap[]> {
  return (await seedMaps('mock-site')).map((m) => ({ ...m, origin: ORIGIN }));
}

const at = (base: number, seconds: number) => new Date(Date.UTC(2026, 9, 27, 9, 0, 0) + base * 600_000 + seconds * 1000).toISOString();

/** Five agents: all stall on occupation; three reach the quote, pause for confirmation and are confirmed. */
export function sessions(): Session[] {
  const driver = ['person.title', 'person.first_name', 'person.last_name', 'person.dob', 'contact.email', 'address.postcode', 'address.line1'];
  return [0, 1, 2, 3, 4].map((i) => {
    let t = 0;
    const ev = (path: string, action: SessionEvent['action'], key?: string, gap = 2, source: SessionEvent['source'] = 'site'): SessionEvent => {
      t += gap;
      return { ts: at(i, t), source, action, path, ...(key && { key }) };
    };
    const events: SessionEvent[] = [
      { ts: at(i, 0), source: 'registry', action: 'knock', path: '/quote/driver', detail: { match: 'exact', score: 1 } },
      ...driver.map((k) => ev('/quote/driver', k === 'person.title' ? 'select' : 'fill', k)),
      ev('/quote/driver', 'select', 'person.occupation', 38 + i * 3),
      ev('/quote/driver', 'choose', 'person.employment_status'),
      ev('/quote/driver', 'choose', 'person.claims.has_any'),
      ev('/quote/driver', 'submit', 'nav.next'),
    ];
    if (i < 3) {
      events.push(
        { ...ev('/quote/cover', 'knock', undefined, 30, 'registry'), detail: { match: 'exact', score: 1 } },
        ev('/quote/cover', 'fill', 'policy.start_date'),
        ev('/quote/cover', 'choose', 'policy.cover_level'),
        ev('/quote/cover', 'handoff', 'consent.declaration'),
        ev('/quote/cover', 'held', 'form.submit'),
        ev('/quote/cover', 'confirm', 'form.submit', 9),
        ev('/quote/cover', 'submit', 'form.submit'),
      );
    }
    return { id: `s_morning${i}aaaaaaaa`, origin: ORIGIN, agent: `agent-${i}`.padEnd(43, 'x'), intent: 'quote.car_insurance', created_at: at(i, 0), events };
  });
}

export const blocked = [{ path: '/quote/cover', reason: 'rate_limited' }];
