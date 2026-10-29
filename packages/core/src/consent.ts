// Cookie banners, shared by the reference agent, usher_fill and the walkthrough: always the least
// consent. The map's ui.dismiss action that rejects or keeps only what's necessary, never one that
// accepts. Some banners have no reject button, only "Customise", which opens a preferences dialog
// (OneTrust's, on LV) whose overlay then covers the page: that dialog is closed the same way, with
// its own least-consent button, before anything on the page is pressed.

import type { Page } from 'playwright';
import { locate } from './fill.ts';
import type { MapAction } from './map.ts';

const LEAST_CONSENT = /\b(reject|decline|refuse|deny|necessary|essential|required only|only necessary|manage|settings|no,? thanks)\b/i;
const MORE_CONSENT = /\b(accept|allow|agree|ok|got it|consent|yes)\b/i;
/** In a preferences dialog, the buttons that keep what's already chosen (nothing beyond necessary, by default). */
const DIALOG_LEAST = /\b(reject all|refuse all|decline all|reject|confirm my choices|confirm choices|save my preferences|save preferences|save settings|save my settings|save my choices|save choices|only necessary|necessary only|essential only)\b/i;
/** A banner's least-consent button found by code, when there's no map yet: never one that accepts. */
const BANNER_LEAST = /\b(reject|decline|refuse|necessary|essential|customi[sz]e|manage|settings|preferences)\b/i;
/** Containers that hold a consent banner or its dialog. */
const CONSENT_CONTAINER = '#onetrust-consent-sdk, #onetrust-pc-sdk, [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], #didomi-host, #CybotCookiebotDialog, [aria-label*="cookie" i], [aria-label*="privacy" i]';

/**
 * The banner action to click: always the least-consent option. Among ui.dismiss actions, one that
 * rejects or keeps only what's necessary; never one that accepts. Null if there's no safe choice.
 */
export function leastConsent(actions: MapAction[]): MapAction | null {
  const dismiss = actions.filter((a) => a.key === 'ui.dismiss');
  return dismiss.find((a) => LEAST_CONSENT.test(a.label)) ?? dismiss.find((a) => !MORE_CONSENT.test(a.label)) ?? null;
}

/**
 * Deals with the page's cookie banner, if the map has one, with the least consent, and then with a
 * preferences dialog that opened. Returns what it pressed, by caption, for the run's events.
 */
export async function dismissConsent(page: Page, actions: MapAction[]): Promise<string[]> {
  const pressed: string[] = [];
  const consentButtons = () => page.locator(CONSENT_CONTAINER).filter({ has: page.getByRole('button') }).getByRole('button');
  // Presses the first visible button inside a consent container whose caption fits, never one that accepts.
  const pressIn = async (fits: RegExp): Promise<boolean> => {
    const candidates = consentButtons().filter({ hasText: fits });
    const count = await candidates.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const b = candidates.nth(i);
      const caption = ((await b.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
      if (!caption || MORE_CONSENT.test(caption.replace(/\bconfirm\b/i, '')) || !(await b.isVisible().catch(() => false))) continue;
      await b.click({ timeout: 5000 }).catch(() => undefined);
      pressed.push(caption);
      return true;
    }
    return false;
  };
  const banner = leastConsent(actions);
  const button = banner ? await locate(page, banner) : null;
  if (banner && button && (await button.first().isVisible().catch(() => false))) {
    await button.first().click({ timeout: 5000 }).catch(() => undefined);
    pressed.push(banner.label);
  } else {
    // No map yet (the walkthrough explores first): the banner's least-consent button, by code.
    await pressIn(BANNER_LEAST);
  }
  // A dialog the banner opened (or that was open already): its least-consent button, only inside it.
  for (let tries = 0; tries < 2; tries++) {
    await page.waitForTimeout(400);
    if (!(await pressIn(DIALOG_LEAST))) break;
  }
  return pressed;
}
