// Records explanations of the test morning from Muse Spark and Muse Spark Open (needs both keys).
//   node --import tsx packages/registry/scripts/record-explanations.ts

import { writeFile } from 'node:fs/promises';
import { compilerModel, modelApi, openModel } from '@usher/core';
import { loadDotEnv } from '../../core/src/compile/env.ts';
import { recordingChat, type RecordedAttempt } from '../../core/test/replay.ts';
import { explainFacts, formFacts } from '../src/index.ts';
import { blocked, maps, sessions } from '../test/explain-data.ts';

loadDotEnv();
const all = await maps();
const facts = Object.fromEntries(all.map((m) => [m.path, formFacts(m, sessions(), blocked)]));
for (const [name, chat, model] of [['spark', modelApi(), compilerModel()], ['open', modelApi({ provider: 'baseten' }), openModel()]] as const) {
  const attempts: RecordedAttempt[] = [];
  const texts: Record<string, string> = {};
  // Forms nobody used are not explained, as in the registry.
  for (const m of all.filter((m) => (facts[m.path]!.sessions as number) > 0)) texts[m.path] = (await explainFacts(recordingChat(chat, attempts), model, facts[m.path]!)).text;
  // One session on its own, as the dashboard's session page asks.
  const one = sessions()[0]!;
  const pages = [...new Set(one.events.map((e) => e.path!))];
  const sessionFacts = { one_agent_session: true, pages: pages.map((p) => formFacts(all.find((m) => m.path === p)!, [one], [])) };
  texts['session 0'] = (await explainFacts(recordingChat(chat, attempts), model, sessionFacts)).text;
  await writeFile(new URL(`../test/fixtures/explanations/${name}.json`, import.meta.url), `${JSON.stringify({ model, recorded_at: new Date().toISOString(), attempts }, null, 2)}\n`);
  console.log(`${name} (${model}):`);
  for (const [path, text] of Object.entries(texts)) console.log(`  ${path}: ${text}`);
}
