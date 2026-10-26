// npm run agent -- <url> --profile <file> [--intent quote.car_insurance] [--open] [--mcp] [--auto-confirm] [--headed] [--key <file>] [--no-model]
//
// --open uses Muse Spark Open on Baseten (BASETEN_API_KEY) instead of Muse Spark for pages without a map.
//
// Finds the registry from the site's knock notice (or --registry), knocks, fills the form from
// the profile, asks before consequential actions, and prints a one-line summary.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { compilerModel, modelApi, openModel } from '@usher/core';
import { loadDotEnv } from '../../core/src/compile/env.ts';
import { runAgent, summaryLine, type Profile } from './agent.ts';
import { httpTransport, mcpTransport } from './transport.ts';
import { scriptedUser, terminalUser } from './user.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: 'string' },
    registry: { type: 'string' },
    key: { type: 'string' },
    mcp: { type: 'boolean', default: false },
    'auto-confirm': { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
    'no-model': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    intent: { type: 'string', default: 'quote.car_insurance' },
    open: { type: 'boolean', default: false },
  },
});
const url = positionals[0];
if (!url || !values.profile) {
  console.error('Usage: npm run agent -- <url> --profile <file> [--mcp] [--auto-confirm] [--headed] [--key <file>] [--registry <url>] [--no-model]');
  process.exit(2);
}
loadDotEnv();
const profile = JSON.parse(await readFile(values.profile, 'utf8')) as Profile;

// The registry named by the site: its /.well-known/usher.json.
let registryUrl = values.registry;
if (!registryUrl) {
  const res = await fetch(new URL('/.well-known/usher.json', url));
  if (!res.ok) {
    console.error(`${new URL(url).origin} does not publish /.well-known/usher.json; pass --registry.`);
    process.exit(1);
  }
  registryUrl = ((await res.json()) as { registry: string }).registry;
}

const registry = values.mcp ? await mcpTransport(registryUrl, values.key) : await httpTransport(registryUrl, values.key);
const browser = await chromium.launch({ headless: !values.headed });
try {
  const result = await runAgent({
    browser,
    url,
    profile,
    intent: values.intent,
    registry,
    user: values['auto-confirm'] ? scriptedUser(profile) : terminalUser(),
    // The fallback model: Muse Spark, or Muse Spark Open on Baseten with --open.
    ...(!values['no-model'] && values.open && process.env.BASETEN_API_KEY && { fallback: { chat: modelApi({ provider: 'baseten' }), model: openModel() } }),
    ...(!values['no-model'] && !values.open && process.env.MODEL_API_KEY && { fallback: { chat: modelApi(), model: compilerModel() } }),
  });
  if (values.json) console.log(JSON.stringify(result, null, 2));
  console.log(summaryLine(result));
  process.exitCode = result.outcome === 'completed' ? 0 : 1;
} finally {
  await browser.close();
  await registry.close();
}
