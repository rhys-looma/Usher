# Mock quote site: Brightwater Motor

A fictional, three-step car insurance quote form for developing and demonstrating Usher. Brightwater Motor is not a real company, and every page says so.

```sh
cd examples/mock-quote-site
npm start            # http://localhost:4100
```

No dependencies; Node 20 or later.

## What it has

| Path | What |
| --- | --- |
| `/quote/driver` | Step 1: personal details, a 173-option occupation list, a conditional claims sub-form |
| `/quote/vehicle` | Step 2: registration with a "Find car" lookup, usage, overnight location |
| `/quote/cover` | Step 3: cover options and a required declaration; "Get my quote" is the consequential action |
| `/quote/result` | The (made-up) price |
| `GET /api/vehicle?registration=AB12CDE` | Vehicle lookup used by the "Find car" button |
| `POST /api/quote` | The same quote request as JSON, so the demo can show an agent skipping the form |
| `/__admin` | Switch the form layout live |

Pages are separate requests with a server session, like real quote journeys, and the server validates every step.

## With Usher

Set `USHER_REGISTRY_URL` to turn Usher on (run `npm run build` at the repository root first):

```sh
USHER_REGISTRY_URL=http://localhost:4200 npm start
```

- Every page loads the site script from the registry (`<script src="…/usher.js" data-usher-registry="…">`), which adds the knock notice to the form, binds agent tokens and reports drift.
- `/.well-known/usher.json` names the registry.
- `POST /quote/cover` (requesting the quote) checks a token from requests that identify as agents: an `Authorization: Usher …` or `X-Usher-Token` header, a `usher_token` form field, or an `Usher-Agent` header. People using the form are not checked.
- `POST /api/quote` is for software, so every call needs a token. Without one it answers `403` with `{"error":"knock_required", …}` and a `Link` header pointing at the knock URL.

## Layouts A and B

Layout B behaves like a site redesign: every field id and name changes, some labels are reworded, contact fields move to the top, and "Continue" becomes "Next". Switch at `/__admin` while the site is running, or start with `npm run start:b`. This is what the drift-detection and healing demo runs against.

## `POST /api/quote`

```json
{
  "driver": { "title": "mr", "first_name": "Sam", "last_name": "Taylor", "dob": "1988-04-02", "email": "sam@example.com", "postcode": "WR14 1AA", "address_line1": "1 High Street", "occupation": "teacher", "employment_status": "employed", "has_claims": "no" },
  "vehicle": { "registration": "AB12CDE", "make": "Ford", "model": "Fiesta", "year": 2018, "annual_mileage": 8000, "use": "social-and-commuting", "overnight": "driveway", "modified": "no" },
  "cover": { "start_date": "2026-11-15", "cover_level": "comprehensive", "excess": "250", "ncd_years": "5", "payment": "monthly", "declaration": "yes" }
}
```
