// Recorded model responses, so the compiler tests run offline with no API key.

import { readFile } from 'node:fs/promises';
import { requestHash, type ChatFn, type Usage } from '../src/index.ts';
import type { Layout, Step } from './helpers.ts';

export interface RecordedAttempt {
  /** Hash of the request without the screenshot; a change means the prompt changed. */
  request_sha256: string;
  content: string;
  usage: Usage;
  latency_ms: number;
}

export interface LabelFixture {
  model: string;
  recorded_at: string;
  layout: Layout;
  step: Step;
  attempts: RecordedAttempt[];
}

/** Recorded sets: Muse Spark on the Meta Model API, and Muse Spark Open on Baseten. */
export type FixtureSet = 'labels' | 'labels-open';

export function fixtureUrl(layout: Layout, step: Step, set: FixtureSet = 'labels'): URL {
  return new URL(`./fixtures/${set}/${layout}-${step}.json`, import.meta.url);
}

export async function readFixture(layout: Layout, step: Step, set: FixtureSet = 'labels'): Promise<LabelFixture> {
  return JSON.parse(await readFile(fixtureUrl(layout, step, set), 'utf8'));
}

/** Wraps a chat function and records each exchange into `attempts`. */
export function recordingChat(chat: ChatFn, attempts: RecordedAttempt[]): ChatFn {
  return async (request) => {
    const result = await chat(request);
    attempts.push({ request_sha256: requestHash(request), content: result.content, usage: result.usage, latency_ms: result.latency_ms });
    return result;
  };
}

/** Replays a fixture's responses in order, failing if the request differs from the recording. */
export function replayChat(fixture: LabelFixture): ChatFn {
  let next = 0;
  return async (request) => {
    const recorded = fixture.attempts[next++];
    const name = `${fixture.layout}-${fixture.step}`;
    if (!recorded) throw new Error(`Fixture ${name} has no response for attempt ${next}.`);
    if (requestHash(request) !== recorded.request_sha256) {
      throw new Error(`The request for ${name} attempt ${next} no longer matches the recording (prompt or extraction changed). Run npm run fixtures:record.`);
    }
    return { content: recorded.content, usage: recorded.usage, latency_ms: recorded.latency_ms, response: { replayed: name } };
  };
}

/**
 * Replays whichever recorded response matches each request, across fixtures, for runs that
 * compile several pages. With simulateLatency it waits as long as the model took when recorded,
 * so timings compare honestly with runs that skip the model.
 */
export function replayAny(fixtures: LabelFixture[], options: { simulateLatency?: boolean } = {}): ChatFn {
  const byHash = new Map(fixtures.flatMap((f) => f.attempts.map((a) => [a.request_sha256, { fixture: f, attempt: a }] as const)));
  return async (request) => {
    const found = byHash.get(requestHash(request));
    if (!found) throw new Error('No recorded response matches this request (prompt or page changed). Run npm run fixtures:record.');
    if (options.simulateLatency) await new Promise((r) => setTimeout(r, found.attempt.latency_ms));
    const name = `${found.fixture.layout}-${found.fixture.step}`;
    return { content: found.attempt.content, usage: found.attempt.usage, latency_ms: found.attempt.latency_ms, response: { replayed: name } };
  };
}
