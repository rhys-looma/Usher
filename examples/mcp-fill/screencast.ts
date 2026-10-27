// A screencast of what a site owner sees after an agent used usher_fill: the dashboard, then the
// session step by step. Runs a local registry and the Brightwater mock site, fills the quote through
// the MCP tools (answering yes to the declaration and Get my quote, no to marketing), then records
// the dashboard.
//
//   node --import tsx examples/mcp-fill/screencast.ts [out.webm]

import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { chromium } from 'playwright';
import { seed, startRegistry } from '@usher/registry';
import { createMcpServer } from '../../packages/registry/src/mcp.ts';
import { startMockSite } from '../../packages/site-middleware/test/mock-site.ts';
import { registerSite, type SiteKeys } from '../../packages/registry/test/sites.ts';
import { testStorage } from '../../packages/registry/test/storage-helper.ts';
import { registerFillTools } from '../../packages/mcp/src/fill.ts';

const out = resolve(process.argv[2] ?? 'usher-fill-dashboard.webm');
const root = new URL('../../', import.meta.url);
const { _comment, 'consent.declaration': _d, 'consent.marketing': _m, ...values } = JSON.parse(await readFile(new URL('packages/agent/profiles/test-driver.json', root), 'utf8'));

const dir = await mkdtemp(join(tmpdir(), 'usher-screencast-'));
const registry = await startRegistry({ storage: await testStorage(join(dir, 'registry')), siteScript: fileURLToPath(new URL('packages/site-script/dist/usher.js', root)), web: {} });
let keys!: SiteKeys;
const site = await startMockSite({ registry: registry.url, register: async (o) => (keys = await registerSite(registry, o)).site_key });
await seed(registry.registry, 'mock-site', site.url);
const browser = await chromium.launch();

const server = await createMcpServer(registry.url, join(dir, 'agent-key.json'), 'screencast');
const tools = registerFillTools(server, { registryUrl: registry.url, keyFile: join(dir, 'agent-key.json'), browser: async () => browser });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: 'screencast', version: '0' });
await client.connect(b);
type Reply = { status: string; id: string; decision?: { key: string }; session?: string };
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent as unknown as Reply;
let reply = await call('usher_fill', { url: `${site.url}/quote/driver`, intent: 'quote.car_insurance', values });
while (reply.status === 'needs_decision') reply = await call('usher_confirm', { id: reply.id, answer: reply.decision!.key !== 'consent.marketing' });
console.log(`fill ${reply.status}, session ${reply.session}`);

const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir, size: { width: 1280, height: 800 } } });
const page = await context.newPage();
const pause = (ms: number) => page.waitForTimeout(ms);
await page.goto(`${registry.url}/dashboard`);
await pause(800);
await page.locator('input[name=origin]').pressSequentially(keys.origin, { delay: 25 });
await page.locator('input[name=secret]').fill(keys.secret_key);
await pause(400);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForLoadState();
await pause(1500);
const sessions = page.locator('#sessions');
await sessions.scrollIntoViewIfNeeded();
await pause(2000);
await page.locator(`a[href="/dashboard/sessions/${reply.session}"]`).first().click();
await page.waitForLoadState();
await pause(1500);
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, 350);
  await pause(700);
}
await pause(1000);
const video = page.video();
await context.close();
await rename((await video!.path()), out);
console.log(out);

await client.close();
await tools.close();
await browser.close();
await site.stop();
await registry.close();
await rm(dir, { recursive: true });
