import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagPage } from '../src/web/signup.ts';

const page = (origin?: string) => tagPage({ url: 'https://registry.example', siteKey: 'usp_key', ...(origin && { origin }) });

test('the tag page links a local demo site to its settings, and no other site', () => {
  assert.match(page('http://localhost:4301'), /href="http:\/\/localhost:4301\/__settings"/);
  assert.doesNotMatch(page('https://quote.example'), /__settings/);
  assert.doesNotMatch(page(), /__settings/);
});
