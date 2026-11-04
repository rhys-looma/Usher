// Started by npm run local: node --import tsx packages/agent/scripts/chat/cli.ts
// USHER_CHAT_REGISTRY is the local portal; USHER_CHAT_SITES, a JSON list of { name, origin }.

import { compilerModel, modelApi } from '@usher/core';
import { loadDotEnv } from '../../../core/src/compile/env.ts';
import { startChat, type ChatSite } from './server.ts';

loadDotEnv();
const running = await startChat({
  registryUrl: process.env.USHER_CHAT_REGISTRY!,
  sites: JSON.parse(process.env.USHER_CHAT_SITES!) as ChatSite[],
  chat: modelApi(),
  model: compilerModel(),
  port: Number(process.env.CHAT_PORT ?? 4400),
});
console.log(`Chat tester on ${running.url}`);
