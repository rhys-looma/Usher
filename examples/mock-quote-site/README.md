# Brightwater Motor (demo)

A fictional three-step car insurance quote form (driver, vehicle, cover, then a made-up price) for developing and demonstrating Usher. Not a real insurer; no data leaves it. No dependencies.

```bash
npm start --prefix examples/mock-quote-site
```

That serves the form on :4100 with no Usher, a plain site.

```bash
USHER_REGISTRY_URL=http://localhost:4200 USHER_SITE_KEY=usp_… npm start --prefix examples/mock-quote-site
```

That runs it with Usher: the script tag, `/.well-known/usher.json`, its claim file at `/.well-known/usher-site.json`, and the server-side check on "Get my quote" and on `POST /api/quote`.

- `/__admin` switches between layouts A and B while it runs, to show drift and the keeper's rebuild.
- `VARIANT=b` starts it on layout B.
- `USHER_REQUIRE_SIGNATURE=1` refuses agent tokens without a Web Bot Auth signature.
