// Renders the front page's sharing image (assets/og.png, 1200 by 630) from its sentence: plain type
// on a plain background, no illustration. Run: npm run og-image
//   node --import tsx packages/registry/scripts/og-image.ts

import { chromium } from 'playwright';
import { SENTENCE, SUBLINE } from '../src/web/landing.ts';

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(`<!doctype html><html><body style="margin:0;width:1200px;height:630px;background:#fbfbfa;color:#1c2230;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;flex-direction:column;justify-content:center;padding:0 90px;box-sizing:border-box">
<div style="font-weight:700;font-size:34px;color:#0b6e6e;margin-bottom:34px">Usher</div>
<div style="font-weight:700;font-size:58px;line-height:1.18;letter-spacing:-0.01em;max-width:1000px">${esc(SENTENCE)}</div>
<div style="font-size:30px;color:#626a7a;margin-top:30px">${esc(SUBLINE)}</div>
</body></html>`);
await page.screenshot({ path: new URL('../assets/og.png', import.meta.url).pathname });
await browser.close();
console.log('packages/registry/assets/og.png');
