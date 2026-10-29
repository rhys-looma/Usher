// Themes (LU-58): closed lists, checked values, contrast fixed in code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_SURFACE, cardTheme, contrast, nearestPassing, radiusFor, themeTokens, typefaceFor, validateTheme, type SiteTheme } from '../src/theme.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const good = { name: 'Brightwater Insurance', logo: PNG, accent: '#0b6e6e', second: '#1d2433', typeface: 'system', radius: 8, result_fields: ['thumbnail'] };

test('a good theme passes in its one shape; unknown fields are dropped', () => {
  const r = validateTheme({ ...good, css: 'body{display:none}', accent: '#0B6E6E' });
  assert.ok('theme' in r);
  assert.deepEqual(r.theme, { ...good, accent: '#0b6e6e' } as SiteTheme);
  assert.equal('css' in r.theme, false);
  assert.equal((validateTheme({ ...good, accent: '#abc' }) as { theme: SiteTheme }).theme.accent, '#aabbcc');
});

test('anything outside the closed lists is refused', () => {
  const bad = validateTheme({
    name: '<b>Evil</b>'.repeat(20),
    logo: 'javascript:alert(1)',
    accent: 'red; background:url(https://evil.example)',
    second: 'var(--x)',
    typeface: 'Comic Sans", url(x)',
    radius: 999,
    result_fields: ['thumbnail', 'everything'],
  });
  assert.ok('problems' in bad);
  assert.deepEqual(bad.problems.map((p) => p.field).sort(), ['accent', 'logo', 'name', 'radius', 'result_fields', 'second', 'typeface']);
  // A logo must really be a small PNG.
  assert.ok('problems' in validateTheme({ ...good, logo: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }));
  assert.ok('problems' in validateTheme({ ...good, logo: `data:image/png;base64,${Buffer.from('GIF89a not a png at all, really').toString('base64')}` }));
  assert.ok('problems' in validateTheme({ ...good, logo: `data:image/png;base64,${Buffer.alloc(60_000, 1).toString('base64')}` }));
  // Markup in the name is taken out, not kept.
  assert.equal((validateTheme({ ...good, name: 'Bright<script>water' }) as { theme: SiteTheme }).theme.name, 'Brightscriptwater');
});

test('contrast: colours move to the nearest passing one, in light and dark', () => {
  for (const mode of ['light', 'dark'] as const) {
    for (const colour of ['#ffff00', '#0b6e6e', '#000000', '#ffffff', '#7434d3', '#f0f0f0']) {
      const t = themeTokens({ accent: colour, second: colour }, mode);
      assert.ok(contrast(t.accent, CARD_SURFACE[mode]) >= 3, `${mode} ${colour} accent on the card`);
      assert.ok(contrast(t.accent, t.accent_ink) >= 4.5, `${mode} ${colour} text on the accent`);
      assert.ok(contrast(t.band, t.band_ink) >= 4.5, `${mode} ${colour} text on the band`);
    }
  }
  // A colour that passes is kept as it is; one that doesn't moves only as far as it must.
  assert.equal(themeTokens({ accent: '#0b6e6e', second: '#0b6e6e' }, 'light').accent, '#0b6e6e');
  const yellow = nearestPassing('#ffff00', (c) => contrast(c, '#ffffff') >= 3);
  assert.ok(contrast(yellow, '#ffffff') >= 3 && contrast(yellow, '#ffffff') < 3.3, yellow);
});

test('card themes, typefaces and radii', () => {
  const t = cardTheme((validateTheme(good) as { theme: SiteTheme }).theme);
  assert.deepEqual(Object.keys(t).sort(), ['dark', 'light', 'logo', 'name', 'radius', 'result_fields', 'typeface']);
  assert.equal(typefaceFor('"Helvetica Neue", Arial'), 'grotesque');
  assert.equal(typefaceFor('Georgia, serif'), 'serif');
  assert.equal(typefaceFor('"Open Sans", sans-serif'), 'humanist');
  assert.equal(typefaceFor('Montserrat'), 'geometric');
  assert.equal(typefaceFor('system-ui, -apple-system'), 'system');
  assert.equal(radiusFor(6), 4);
  assert.equal(radiusFor(9999), 16);
});
