import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MapAction } from '@usher/core';
import { leastConsent } from '../src/index.ts';

const action = (id: string, label: string, key = 'ui.dismiss'): MapAction => ({ id, key, label, kind: 'button', risk: 'safe', locators: [{ by: 'css', value: `#${id}` }] });

test('cookie banners: always the least-consent option', () => {
  assert.equal(leastConsent([action('e1', 'Accept all cookies'), action('e2', 'Essential cookies only')])?.id, 'e2');
  assert.equal(leastConsent([action('e1', 'Allow all'), action('e2', 'Reject all')])?.id, 'e2');
  assert.equal(leastConsent([action('e1', 'Close')])?.id, 'e1', 'a plain close is fine');
  assert.equal(leastConsent([action('e1', 'Accept cookies')]), null, 'never accept');
  assert.equal(leastConsent([action('e1', 'Continue', 'nav.next')]), null);
});
