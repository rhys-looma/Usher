# @usher/site-middleware

The server-side check: the real lock on a site's consequential endpoints. It verifies, offline, the token an agent got by knocking, against the registry's published keys.

```js
import { createUsherCheck } from '@usher/site-middleware';

const usher = createUsherCheck({
  registry: 'https://registry.example',
  intent: 'quote.car_insurance',
  origin: 'https://quote.example',
  siteKey: 'usp_…', // optional: report refusals to your dashboard
});

// In a handler for a consequential endpoint:
const check = await usher.check(req, { form: params, action: 'form.submit', body: rawBody });
if (check.status === 'knock_required') return usher.reject(req, res, check, 'form.submit'); // 403, with where to knock
```

- **Who is checked:** requests that identify as agents (a token, an `Usher-Agent` or `Signature-Agent` header, a Web Bot Auth signature), and every request when `always: true`, as for an API. People using the normal form pass through as `{ status: 'human' }`.
- **The token** must be signed by your registry, unexpired, for your origin and intent, and unused: each token id is accepted once.
- **The action** must be allowed. It is refused if the site's rules forbid it, or if it needs the user's confirmation the agent didn't state. The vocabulary's default risk is the floor.
- **The signature.** If the request is signed (Web Bot Auth), it must be from the key the token was issued to, so a copied token is useless. `requireSignature: true` refuses unsigned tokens.

See section 7 of [spec/knock.md](../../spec/knock.md). Built to `dist/index.js` by `npm run build`.

```bash
npm test --workspace packages/site-middleware
```
