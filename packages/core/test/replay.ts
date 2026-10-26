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

export function fixtureUrl(layout: Layout, step: Step): URL {
  return new URL(`./fixtures/labels/${layout}-${step}.json`, import.meta.url);
}

export async function readFixture(layout: Layout, step: Step): Promise<LabelFixture> {
  return JSON.parse(await readFile(fixtureUrl(layout, step), 'utf8'));
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
