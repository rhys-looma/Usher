// Cookie banners with the least consent, including one whose only alternative to "Accept all" is
// "Customise", which opens a preferences dialog with an overlay over the page (LV's OneTrust).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from 'playwright';
import { dismissConsent, type MapAction } from '../src/index.ts';
import { launch } from './helpers.ts';

let browser: Browser;
before(async () => (browser = await launch()));
after(() => browser.close());

const PAGE = `<!doctype html><html><body>
  <p>Choose your type of cover</p><div><button type="button" id="level">Level</button><button type="button">Decreasing</button></div>
  <div id="onetrust-consent-sdk">
    <div id="onetrust-banner-sdk" style="position:fixed;inset:0;background:rgba(255,255,255,.9)">
      <button id="customise" onclick="document.getElementById('onetrust-pc-sdk').style.display='block';document.getElementById('veil').style.display='block'">Customise cookies</button>
      <button onclick="window.accepted=true;this.parentElement.remove()">Accept all cookies</button>
    </div>
    <div id="veil" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5)"></div>
    <div id="onetrust-pc-sdk" style="display:none;position:fixed;top:10%;left:10%;width:80%;background:#fff">
      <button onclick="window.accepted=true">Allow all</button>
      <button onclick="document.getElementById('onetrust-consent-sdk').remove()">Save my preferences</button>
    </div>
  </div>
</body></html>`;

const action = (id: string, label: string): MapAction => ({ id, key: 'ui.dismiss', label, risk: 'safe', locators: [{ by: 'id', value: 'customise' }] });

for (const [name, actions] of [['from the map', [action('e9', 'Customise cookies')]], ['by code, before there is a map', []]] as const) {
  test(`a "Customise" banner and its dialog are closed with the least consent, ${name}`, async () => {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    assert.equal(await page.locator('#level').click({ trial: true, timeout: 1000 }).then(() => true, () => false), false, 'the banner covers the page');
    const pressed = await dismissConsent(page, [...actions]);
    assert.deepEqual(pressed, ['Customise cookies', 'Save my preferences']);
    assert.equal(await page.evaluate(() => (window as unknown as { accepted?: boolean }).accepted ?? false), false, 'nothing that accepts');
    assert.equal(await page.locator('#level').click({ trial: true, timeout: 1000 }).then(() => true, () => false), true, 'the page can be used');
    await page.close();
  });
}

test('a page with no banner is left alone', async () => {
  const page = await browser.newPage();
  await page.setContent('<p>Your gender</p><div><button type="button">Male</button><button type="button">Female</button></div>');
  assert.deepEqual(await dismissConsent(page, []), []);
  await page.close();
});
