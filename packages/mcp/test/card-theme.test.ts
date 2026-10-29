// A site's theme on Usher's card (LU-58): it changes how the card looks (the band with the site's
// name and logo, the accent, typeface and corners) and never what the card does. The same decision
// renders the same questions, unticked, with the same Usher mark, and the same Confirm sends the
// same words, with no theme, a good one, or a hostile one; anything outside the closed lists is no
// theme at all, and markup in a name is shown as text.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { cardTheme, validateTheme, type CardTheme, type SiteTheme } from '@usher/core';
import { CARD_HTML } from '../../registry/src/web/card-page.ts';
import { previewSamples } from '../../registry/src/web/theme.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const good = cardTheme((validateTheme({ name: 'Brightwater Insurance', logo: PNG, accent: '#0b6e6e', second: '#0b6e6e', typeface: 'serif', radius: 12, result_fields: [] }) as { theme: SiteTheme }).theme);
const samples = previewSamples('https://brightwater.example', { title: 'health insurance quote', start: '/health/about' });

let browser: Browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});

const HOST = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<iframe id="v" sandbox="allow-scripts" style="width:520px;height:900px;border:0"></iframe>
<script>
var f = document.getElementById('v');
window.msgs = []; window.ready = false;
window.addEventListener('message', function (e) {
  var m = e.data;
  if (!m || m.jsonrpc !== '2.0') return;
  window.msgs.push(m);
  if (m.method === 'ui/initialize') f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: { hostCapabilities: { message: { text: {} } }, hostContext: { theme: 'light' } } }, '*');
  else if (m.method === 'ui/notifications/initialized') window.ready = true;
  else if (m.id != null && m.method) f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result: {} }, '*');
});
window.show = function (r) { f.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: r }, '*'); };
</script></body></html>`;

async function render(result: { structuredContent: Record<string, unknown>; content?: unknown[] }, theme?: unknown): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 560, height: 900 } })).newPage();
  await page.setContent(HOST);
  await page.evaluate((h) => ((document.getElementById('v') as HTMLIFrameElement).srcdoc = h), CARD_HTML);
  await page.waitForFunction('window.ready === true');
  await page.evaluate((r) => (window as unknown as { show: (r: unknown) => void }).show(r), { ...result, structuredContent: { ...result.structuredContent, ...(theme !== undefined && { theme }) } });
  await page.frameLocator('#v').locator('.card').waitFor();
  return page;
}

/** What the decision card does: its controls and their state, its marks, and what Confirm sends. */
async function behaviour(page: Page) {
  const card = page.frameLocator('#v');
  const controls = await card.locator('input, select, button, textarea, a').evaluateAll((els) =>
    els.map((e) => [e.tagName, (e as HTMLInputElement).type, (e as HTMLInputElement).name, e.getAttribute('data-key'), e.getAttribute('data-kind'), (e as HTMLInputElement).checked, e.textContent?.trim()].join('|')),
  );
  const asking = await card.locator('.asking').textContent();
  const verbatim = await card.locator('.verbatim').allTextContents();
  await card.locator('input[data-key="person.smoker"][value="yes"]').check();
  await card.locator('input[data-key="consent.declaration"]').check();
  await card.locator('input[data-key="form.submit"]').check();
  await card.locator('button#go').click();
  await card.locator('text=Sent as your message:').waitFor();
  const msgs = (await page.evaluate('window.msgs')) as { method?: string; params?: { content?: { text: string }[] } }[];
  const sent = msgs.filter((m) => m.method === 'ui/message').map((m) => m.params!.content![0]!.text);
  const scripts = await card.locator('script').count();
  return { controls, asking, verbatim, sent, scripts };
}

test('a theme changes how the decision card looks, never what it does', async () => {
  const plain = await render(samples.decision);
  const themed = await render(samples.decision, good);
  const card = themed.frameLocator('#v');
  // The look: the site's band with its name, its logo and the fixed mark; the accent on the button.
  assert.equal(await card.locator('.band .name').textContent(), 'Brightwater Insurance');
  assert.equal(await card.locator('.band .via').textContent(), 'via Usher');
  assert.equal(await card.locator('.band img').getAttribute('src'), PNG);
  assert.equal(await card.locator('button#go').evaluate((b) => getComputedStyle(b).backgroundColor), 'rgb(11, 110, 110)');
  assert.equal(await card.locator('.card').evaluate((c) => getComputedStyle(c).borderTopLeftRadius), '12px');
  assert.match(await card.locator('body').evaluate((b) => getComputedStyle(b).fontFamily), /Charter|Georgia/);
  assert.equal(await plain.frameLocator('#v').locator('.band').count(), 0, 'no theme, no band');
  // What it does: identical.
  const [a, b] = [await behaviour(plain), await behaviour(themed)];
  assert.deepEqual(b, a);
  assert.equal(a.asking, 'Usher is asking you, not the agent');
  assert.ok(a.controls.some((c) => c.startsWith('INPUT|checkbox|') && c.includes('consent.declaration|consent|false')), 'the declaration starts unticked');
  assert.deepEqual(a.sent, ['Confirm: smoker yes, declaration yes, marketing no, get my quote yes']);
});

test('a hostile theme is no theme at all, or text: never style, markup or behaviour', async () => {
  const plain = await behaviour(await render(samples.decision));
  const hostile: unknown[] = [
    { ...good, light: { ...good.light, accent: 'red;}body{display:none}' } },
    { ...good, typeface: 'url(https://evil.example/x)' },
    { ...good, radius: 9999 },
    { ...good, dark: { ...good.dark, band: 'expression(alert(1))' } },
    { ...good, name: 'x'.repeat(61) },
    'not a theme',
    { name: 'No tokens' },
  ];
  for (const theme of hostile) {
    const page = await render(samples.decision, theme);
    const card = page.frameLocator('#v');
    assert.equal(await card.locator('.band').count(), 0, JSON.stringify(theme).slice(0, 80));
    assert.equal(await page.frameLocator('#v').locator('#brand').evaluate((s) => s.textContent), '', 'no style set');
    assert.deepEqual(await behaviour(page), plain);
  }
  // Valid otherwise: a name with markup is text; a logo that isn't a PNG data URL is left out.
  const page = await render(samples.decision, { ...good, name: '<img src=x onerror=alert(1)>Bright', logo: 'javascript:alert(1)' } satisfies CardTheme);
  const card = page.frameLocator('#v');
  assert.equal(await card.locator('.band .name').textContent(), '<img src=x onerror=alert(1)>Bright');
  assert.equal(await card.locator('.band img').count(), 0);
  assert.equal(await card.locator('img').count(), 0);
  assert.deepEqual(await behaviour(page), plain);
});

test('the result card shows the parts the theme chooses; the headline and "via Usher" always', async () => {
  const result = { ...samples.result, content: [{ type: 'image', mimeType: 'image/png', data: PNG.split(',')[1] }] };
  const bare = (await render(result, good)).frameLocator('#v');
  assert.equal(await bare.locator('.facts li').count(), 1);
  assert.equal(await bare.locator('.facts li').first().textContent(), '£66.92 a month');
  assert.equal(await bare.locator('img.thumb').count(), 0);
  assert.equal(await bare.locator('.band .via').textContent(), 'via Usher');
  const full = (await render(result, { ...good, result_fields: ['more_facts', 'thumbnail'] })).frameLocator('#v');
  assert.equal(await full.locator('.facts li').count(), 3);
  assert.equal(await full.locator('img.thumb').count(), 1);
  // The ticket carries the band too, and stays read-only.
  const ticket = (await render(samples.ticket, good)).frameLocator('#v');
  assert.equal(await ticket.locator('.band .via').textContent(), 'via Usher');
  assert.equal(await ticket.locator('text=Admit one agent').count(), 1);
  assert.equal(await ticket.locator('input, button').count(), 0);
});

test('the result card: the reference, and "Continue on" only for a page on the result\'s own site, opened by the host', async () => {
  const origin = 'https://brightwater.example';
  const withContinue = (url: string) => ({ structuredContent: { ...samples.result.structuredContent, result: { ...(samples.result.structuredContent.result as object), facts: ['£66.92 a month', 'Quote reference BWH-1A2B3C4D'], reference: 'BWH-1A2B3C4D', continue: { url, label: 'Find your quote', site: 'brightwater.example', asks: ['your quote reference', 'your date of birth'] } } } });
  const page = await render(withContinue(`${origin}/retrieve?reference=BWH-1A2B3C4D`), good);
  const card = page.frameLocator('#v');
  assert.equal(await card.locator('.ref b').textContent(), 'BWH-1A2B3C4D');
  assert.equal(await card.locator('a.button').textContent(), 'Continue on Brightwater Insurance');
  assert.match((await card.locator('.note').first().textContent()) ?? '', /Find your quote asks for your quote reference and your date of birth/);
  await card.locator('a.button').click();
  await page.waitForFunction("window.msgs.some(function (m) { return m.method === 'ui/open-link'; })");
  const opened = ((await page.evaluate('window.msgs')) as { method?: string; params?: { url: string } }[]).find((m) => m.method === 'ui/open-link')!;
  assert.equal(opened.params!.url, `${origin}/retrieve?reference=BWH-1A2B3C4D`);
  for (const url of ['https://evil.example/retrieve', 'javascript:alert(1)']) {
    const other = (await render(withContinue(url))).frameLocator('#v');
    assert.equal(await other.locator('a.button').count(), 0, url);
    assert.equal(await other.locator('.ref b').textContent(), 'BWH-1A2B3C4D');
  }
});
