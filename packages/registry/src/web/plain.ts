// Owners' words for what the protocol calls things: who decides a field, what a key means, who an
// agent is and what it did. The codes stay in the technical view; owners read these.

import { vocabulary, type UsherMap } from '@usher/core';
import { html, type Raw } from './html.ts';
import type { Session, SessionEvent } from '../storage.ts';

const WHO: Record<string, string> = { safe: 'Agent fills', consequential: 'Person confirms', needs_user: 'Person only' };
const RULE: Record<string, string> = { allow: 'Allowed', confirm: 'Person confirms', forbid: 'Not allowed' };

/** Who decides a field or button, as a badge. */
export const whoBadge = (risk: string): Raw => html`<span class="badge risk-${risk}">${WHO[risk] ?? risk}</span>`;
/** What a rule does to it, as a badge. */
export const ruleWords = (rule: string): Raw => html`<span class="badge rule-${rule}">${RULE[rule] ?? rule}</span>`;

/** A custom key as words: custom.housing_status is "Housing status". */
const spoken = (key: string) => key.replace(/^[a-z]+\./, '').replace(/[._]/g, ' ').replace(/^(.)/, (c) => c.toUpperCase());

/** What a key means: the vocabulary's words where it has them, otherwise its own. */
export const keyMeaning = (key: string): string => vocabulary.entries.find((v) => v.key === key)?.meaning ?? spoken(key);

/** What each key is called on these maps, as the site words it. */
export function labelsOf(maps: UsherMap[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of maps) for (const e of [...m.fields, ...m.actions]) if (e.label && !out.has(e.key)) out.set(e.key, e.label);
  return out;
}

/** A page by its own name: "Mortgage agreement in principle: about you" is "About you". */
export function pageName(map: UsherMap | undefined, path: string | undefined): string {
  const purpose = map?.form.purpose;
  const name = purpose?.includes(':') ? purpose.slice(purpose.indexOf(':') + 1).trim() : purpose;
  return name ? name.replace(/^(.)/, (c) => c.toUpperCase()) : (path ?? 'this page');
}

/** The owner's own mapping run, not an agent acting for someone. */
export const isMappingRun = (s: Pick<Session, 'agent'>): boolean => s.agent.startsWith('walkthrough:');

/** Who a session was, in words. */
export function whoRan(s: Session): string {
  if (isMappingRun(s)) return 'Your mapping run';
  if (s.identity?.method === 'hosted') return 'An assistant, through Usher';
  return s.identity?.method === 'web-bot-auth' ? 'An agent that proved who it is' : 'An agent with its own key';
}

const FILLED = new Set(['fill', 'select', 'choose']);
const NEXT = new Set(['nav.next', 'nav.back']);

/** One event in words, or nothing when it's plumbing. */
function eventWords(e: SessionEvent, name: (key: string) => string): string | null {
  const what = e.key ? `“${name(e.key)}”` : '';
  switch (e.action) {
    case 'check': return `Ticked ${what}`;
    case 'uncheck': return `Unticked ${what}`;
    case 'click': return e.key ? `Pressed ${what}` : 'Pressed a button';
    case 'submit': return !e.key || NEXT.has(e.key) ? 'Went on to the next page' : `Pressed ${what}`;
    case 'held': return `Waited for the person at ${what}`;
    case 'confirm': return `The person said yes to ${what}`;
    case 'handoff': return `Left ${what} for the person to answer`;
    case 'shown': return e.key ? `Showed the person ${what}, word for word` : 'Showed the person the result, word for word';
    case 'invalid': return `The site didn't accept ${what}`;
    case 'run': return !e.detail?.outcome || e.detail.outcome === 'completed' ? 'Finished' : `Stopped: ${String(e.detail.outcome)}`;
    default: return null;
  }
}

/** What happened, page by page, by what the site calls things. Never a value: events hold none. */
export function plainLog(events: SessionEvent[], maps: UsherMap[]): Raw {
  const byPath = new Map(maps.map((m) => [m.path, m]));
  const labels = labelsOf(maps);
  const name = (key: string) => labels.get(key) ?? keyMeaning(key);
  const groups: { path: string | undefined; lines: string[]; filled: string[] }[] = [];
  const flush = (g: (typeof groups)[number]) => {
    if (g.filled.length) g.lines.push(`Filled in ${g.filled.join(', ')}`);
    g.filled = [];
  };
  for (const e of events) {
    let group = groups.at(-1);
    if (!group || (e.path && e.path !== group.path)) {
      if (group) flush(group);
      group = { path: e.path, lines: [], filled: [] };
      groups.push(group);
    }
    if (FILLED.has(e.action) && e.key) {
      if (!group.filled.includes(name(e.key))) group.filled.push(name(e.key));
      continue;
    }
    const words = eventWords(e, name);
    if (!words) continue;
    flush(group);
    if (group.lines.at(-1) !== words) group.lines.push(words);
  }
  const last = groups.at(-1);
  if (last) flush(last);
  const shown = groups.filter((g) => g.lines.length || g.path);
  if (!shown.length) return html`<p class="muted">Nothing has happened yet.</p>`;
  return html`<div class="plain-log">${shown.map((g) => html`<h3>${pageName(g.path ? byPath.get(g.path) : undefined, g.path)}</h3>${g.lines.length ? html`<ul>${g.lines.map((l) => html`<li>${l}</li>`)}</ul>` : html`<p class="small muted">Opened this page.</p>`}`)}</div>`;
}
