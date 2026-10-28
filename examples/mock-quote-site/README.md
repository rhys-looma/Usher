# Brightwater (demo)

A fictional insurer with two quote journeys, for developing and demonstrating Usher. Brightwater is not a real insurer; no data leaves it. No dependencies.

- **Health insurance** at `/health/*`, the headline example: a private medical insurance quick quote in three steps (about you, your cover, the declaration), then a made-up monthly premium. It uses a split date of birth, an address lookup with a list, card radios (who is covered, whether you smoke, the hospital list, payment) and a text start date. There are no medical questions: the declaration says plainly that Brightwater asks about medical history after the quote.
- **Car insurance** at `/quote/*`: driver, vehicle, cover, then a made-up price.

The home page lists both.

```bash
npm start --prefix examples/mock-quote-site
```

That serves the form on :4100 with no Usher, a plain site.

```bash
USHER_REGISTRY_URL="$REGISTRY_PUBLIC_URL" USHER_SITE_KEY=usp_… npm start --prefix examples/mock-quote-site
```

That runs it with Usher: the script tag, `/.well-known/usher.json`, its claim file at `/.well-known/usher-site.json`, and the server-side check on "Get my quote" (each journey's own intent) and on `POST /api/health-quote` and `POST /api/quote`.

- `/__admin` switches between layouts A, B and C while it runs, to show drift and the keeper's rebuild. Layout B renames and rewords both journeys; layout C changes the car journey's controls (the health journey already uses them, so C shows it as A does).
- `/help` has four forms (a site search, a callback request, a message form and a newsletter box), for choosing the form by intent. Nothing on it is processed.
- `VARIANT=b` starts it on layout B.
- `USHER_REQUIRE_SIGNATURE=1` refuses agent tokens without a Web Bot Auth signature.
