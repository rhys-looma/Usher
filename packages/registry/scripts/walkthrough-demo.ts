// The "watch Usher map a site" scene: starts a walkthrough of the public demo site as the operator,
// then opens the public live view (/demo/walkthrough) in a visible browser window to record.
//
//   USHER_ADMIN_KEY=… npm run demo:walkthrough -- --registry <registry url> [--start /health/about] [--no-open]
//
// The demo site's own daily limit applies (USHER_WALKTHROUGH_DAILY_LIMIT on the registry). The admin
// key is read from the environment and only ever sent to the registry named here.

import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { loadDotEnv } from '../../core/src/compile/env.ts';

const { values } = parseArgs({ options: { registry: { type: 'string' }, start: { type: 'string', default: '/health/about' }, 'no-open': { type: 'boolean', default: false } } });
loadDotEnv();
const registry = (values.registry ?? process.env.USHER_REGISTRY_URL ?? '').replace(/\/$/, '');
const key = process.env.USHER_ADMIN_KEY;
if (!registry || !key) {
  console.error('Needs --registry <url> (or USHER_REGISTRY_URL) and USHER_ADMIN_KEY in the environment.');
  process.exit(2);
}

const login = await fetch(`${registry}/admin/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ key }) });
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (login.status !== 303 || !cookie) {
  console.error(`Admin sign-in refused (HTTP ${login.status}).`);
  process.exit(1);
}
const path = values.start!.startsWith('http') ? new URL(values.start!).pathname : values.start!;
const started = await fetch(`${registry}/admin/walkthrough`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie }, body: new URLSearchParams({ path }) });
if (started.status !== 303) {
  const text = await started.text();
  console.error(`Not started (HTTP ${started.status}): ${text.match(/class="card error">([^<]*)/)?.[1] ?? 'see the registry log'}`);
  process.exit(1);
}
const watch = `${registry}/demo/walkthrough`;
console.log(`Walkthrough started. Live view: ${watch}`);
if (!values['no-open']) {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(watch);
  console.log('Close the window when the scene is done.');
  await new Promise<void>((resolve) => browser.on('disconnected', () => resolve()));
}
