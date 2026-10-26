import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { generateAgentIdentity, generateSigningKey, signRequest, signToken } from '../src/index.ts';
import { launch } from './helpers.ts';

// The site script verifies tokens in the browser with the same code: bundle token.ts and
// identity.ts and run them in Chromium.
test('tokens and signed requests verify in Chromium with the same code', async () => {
  const bundle = await build({
    stdin: {
      contents: `export { verifyToken } from './src/token.ts'; export { verifySignedRequest } from './src/identity.ts';`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: 'usherCore',
    write: false,
  });
  const { key } = await generateSigningKey();
  const now = Math.floor(Date.now() / 1000);
  const token = await signToken({ iss: 'http://registry.test', sub: 'a', origin: 'http://localhost:9', intent: 'quote.car_insurance', map: null, sid: 's', iat: now, exp: now + 600, jti: 'jti-browser-0000001' }, key);
  const { identity } = await generateAgentIdentity();
  const request = await signRequest({ usher: '0.1', url: 'http://localhost:9/form' }, identity);

  const browser = await launch();
  try {
    const page = await browser.newPage();
    // WebCrypto needs a secure context: HTTPS or localhost. Routed, so no server is needed.
    await page.route('http://localhost:9/**', (route) => route.fulfill({ body: '<!doctype html><title>t</title>', contentType: 'text/html' }));
    await page.goto('http://localhost:9/');
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    const result = await page.evaluate(
      async ({ token, keys, request }) => {
        const core = (window as unknown as { usherCore: typeof import('../src/token.ts') & typeof import('../src/identity.ts') }).usherCore;
        const good = await core.verifyToken(token, { keys, origin: location.origin, intent: 'quote.car_insurance' });
        const wrongOrigin = await core.verifyToken(token, { keys, origin: 'http://elsewhere.test' });
        const tampered = await core.verifyToken(token.slice(0, -4) + 'AAAA', { keys });
        const signed = await core.verifySignedRequest(request);
        return { good: good.ok, wrongOrigin: !wrongOrigin.ok && wrongOrigin.error, tampered: !tampered.ok && tampered.error, signed: signed.ok };
      },
      { token, keys: { keys: [key.publicJwk] }, request },
    );
    assert.deepEqual(result, { good: true, wrongOrigin: 'wrong_origin', tampered: 'bad_signature', signed: true });
  } finally {
    await browser.close();
  }
});
