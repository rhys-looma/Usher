// Screenshots of the walkthrough pages (live and finished) with the stand-in labeller, for review.
//   node --import tsx packages/registry/test/walkthrough-shots.ts <out dir>
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { ChatFn } from '@usher/core';
import { startMockSite } from '../../site-middleware/test/mock-site.ts';
import { seedMaps, startRegistry } from '../src/index.ts';
import { Walkthroughs } from '../src/walkthrough.ts';
import { registerSite, type SiteKeys } from './sites.ts';
import { testStorage } from './storage-helper.ts';

const out = process.argv[2]!;
const seeded = await seedMaps('mock-site');
const labeller: ChatFn = async (request) => {
  const user = request.messages.find((m) => m.role === 'user')!;
  const text = typeof user.content === 'string' ? user.content : user.content.map((c) => ('text' in c ? c.text : '')).join('');
  const x = JSON.parse(text.slice(text.indexOf('Extraction:\n') + 12)) as { page: { path: string }; elements: { id: string; kind: string; label: string; candidates: string[] }[] };
  const map = seeded.find((m) => m.path === x.page.path) ?? seeded[0]!;
  const all = seeded.flatMap((m) => [...m.fields, ...m.actions]);
  const elements = x.elements.map((e) => {
    const k = all.find((a) => a.label === e.label);
    return { id: e.id, key: k?.key ?? e.candidates[0] ?? 'custom.thing', risk: k?.risk ?? 'safe', shown_if: null };
  });
  const adv = elements.find((e) => ['nav.next', 'form.submit'].includes(e.key) && x.elements.find((y) => y.id === e.id)?.kind === 'action');
  await new Promise((r) => setTimeout(r, 1500));
  return { content: JSON.stringify({ form: { purpose: map.form.purpose, intent: map.form.intent }, elements, advance_action_id: adv?.id ?? null }), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_tokens: 0 }, latency_ms: 1, response: {} };
};
const browser = await chromium.launch();
let keys!: SiteKeys;
let walk!: Walkthroughs;
const running = await startRegistry({ storage: await testStorage(await mkdtemp(join(tmpdir(), 'wt-shots-'))), siteScript: fileURLToPath(new URL('../../site-script/dist/usher.js', import.meta.url)), web: { allowPrivate: true }, walkthroughs: (registry) => (walk = new Walkthroughs({ registry, browser: async () => browser, compiler: { chat: labeller, model: 'muse-spark-1.3' }, spend: { today: async () => 0, cap: 5 }, allowPrivate: true, logDir: null })) });
const site = await startMockSite({ registry: running.url, register: async (o) => (keys = await registerSite(running, o)).site_key });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.request.post(`${running.url}/dashboard/login`, { form: { origin: keys.origin, secret: keys.secret_key } });
await page.goto(`${running.url}/dashboard`);
await page.screenshot({ path: join(out, 'wt-overview.png'), fullPage: true });
await page.goto(`${running.url}/dashboard/walkthrough/new`);
await page.screenshot({ path: join(out, 'wt-start.png'), fullPage: true });
await page.request.post(`${running.url}/dashboard/walkthrough`, { form: { start: `${site.url}/health/about`, generated: '1' } });
await page.goto(`${running.url}/dashboard/walkthrough`);
await page.waitForTimeout(6000);
await page.screenshot({ path: join(out, 'wt-live.png') });
while ((await walk.get(site.url))?.status === 'running') await new Promise((r) => setTimeout(r, 300));
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, 'wt-done-live-page.png') });
await page.goto(`${running.url}/dashboard/walkthrough`);
await page.screenshot({ path: join(out, 'wt-result.png'), fullPage: true });
await page.hover('.box.needs_user, .box.consequential').catch(() => undefined);
await page.screenshot({ path: join(out, 'wt-hover.png') });
await site.stop();
await running.close();
await browser.close();
process.exit(0);
