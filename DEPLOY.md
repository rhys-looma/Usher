# Deploying Usher

Host-neutral: two container images, environment variables, a Postgres database. Anything that runs containers and gives you HTTPS in front of them will do.

## What runs

| Image | Dockerfile | Port | What |
| --- | --- | --- | --- |
| Registry | `Dockerfile.registry` | 4200 | HTTP API (knock, maps, sessions, rules), the map viewer and the site dashboard, `/usher.js`. Includes Chromium for the viewer's compiles. |
| Mock site | `Dockerfile.mock-site` | 4100 | The fictional quote site, for demos. Optional. |
| Postgres | any Postgres 14+ | 5432 | All registry state. |

The MCP server is not hosted: it holds the agent's private key, so it runs where the agent runs (see the README's quickstart), pointed at the registry's public URL.

## Local stack

```sh
docker compose up --build -d
npm run e2e:remote            # 12 checks against the stack, recorded model responses
docker compose down -v        # stop and delete the local database
```

Registry on http://localhost:4200 (dashboard: origin `http://localhost:4100`, secret `uss_localdevelopmentonly00000000`), quote site on http://localhost:4100. The keys in `docker-compose.yml` are for local use only.

## Configuration (registry)

All configuration is by environment variable. Nothing secret is in the image or the repository.

| Variable | Required | Meaning |
| --- | --- | --- |
| `REGISTRY_PUBLIC_URL` | yes | The HTTPS URL agents and sites use, e.g. `https://registry.example`. It is the token issuer, so it must not change once sites trust it. |
| `DATABASE_URL` | yes | `postgres://user:password@host:5432/db`. Migrations run on start. |
| `USHER_SIGNING_KEY` | yes | The token signing key: a private Ed25519 JWK. Generate with `npm run keygen` and keep it in your secrets manager. Without it the registry generates one and stores it in the database, which is fine for a demo but not for production. |
| `USHER_RETIRED_KEYS` | no | JSON array of earlier public JWKs to keep publishing after a rotation (for at least 10 minutes, a token's lifetime). |
| `MODEL_API_KEY` | for compiles, rules, explanations | Meta Model API key (Muse Spark). |
| `BASETEN_API_KEY` | for the classifier, Spark Open | Baseten key (Muse Spark Open). `USHER_OPEN_MODEL` overrides the model id. |
| `USHER_DAILY_MODEL_BUDGET_USD` | no | Hard daily cap on model spend across all models (default 5). Once reached, compiles and rules return "Today's model budget is used up" until midnight UTC; cached maps keep working. |
| `USHER_TRUST_PROXY` | behind a proxy | `1` to take the client address from `X-Forwarded-For` for rate limits. Only set it when a proxy you control sets that header. |
| `USHER_ALLOW_PRIVATE` | no | `1` lets the map viewer open private addresses. Leave it off in public deployments. |
| `PORT`, `HOST` | no | Defaults 4200 and 0.0.0.0 in the image. |

Generate a signing key:

```sh
npm run keygen   # prints one line of JSON: put it in USHER_SIGNING_KEY, never in the repository
```

Rotate by moving the old key's public half (`kty`, `crv`, `x`, `kid`) into `USHER_RETIRED_KEYS` and setting a new `USHER_SIGNING_KEY`.

## Configuration (a site, or the mock site)

| Variable | Meaning |
| --- | --- |
| `USHER_REGISTRY_URL` | The registry's public URL. |
| `USHER_SITE_KEY` | The site's public key from `POST /sites`; it goes in the script tag. |
| `USHER_REGISTRY_INTERNAL_URL` | Optional: how the site's server reaches the registry if not by its public URL. |

## Steps

1. **Postgres.** Create a database and a user that owns it. Note the connection string.
2. **Keys.** `npm run keygen` once; store the output as `USHER_SIGNING_KEY`. Store the model keys.
3. **Registry.** Build `Dockerfile.registry`, run it with the variables above, and put HTTPS in front (the registry sends HSTS when `REGISTRY_PUBLIC_URL` is https). Check `GET /healthz` returns `{"ok":true,"storage":"postgres",…}`.
4. **DNS.** Point the registry's hostname (and the mock site's, if deployed) at your host or load balancer.
5. **Register a site.** `curl -X POST https://registry.example/sites -H 'Content-Type: application/json' -d '{"origin":"https://quote.example"}'` returns a site key and a secret key, shown once. For the mock site, then seed its maps if you want agents to skip the model on first run: `DATABASE_URL=… npm run db -- seed --origin https://quote.example`.
6. **Mock site.** Build `Dockerfile.mock-site`, run with `USHER_REGISTRY_URL` and `USHER_SITE_KEY`.

The site script can be included at `/usher.js` (cached 5 minutes) or at its versioned path from `GET /usher/version.json` (cached for a year, immutable).

## Hardening in place

- Rate limits per client address: knocks 120/min, drift reports 60/min, session events 1,200/min, other writes 300/min, reads 600/min; per site key on drift and blocked reports; per client and overall on viewer compiles (10/hour, 100/hour). Addresses are used in memory only, never stored.
- A hard daily cap on model spend.
- JSON bodies up to 256 KB; form bodies up to 20 KB.
- The viewer refuses private and loopback addresses unless `USHER_ALLOW_PRIVATE=1`.
- CORS only on the endpoints the site script calls (`/maps/current`, `/maps/lookup`, `/drift`, `/sessions/:id/events`, the key set, blocked reports).
- HTML pages send a strict Content Security Policy (no scripts at all), `X-Frame-Options: DENY`; every response sends `nosniff` and `Referrer-Policy`; HSTS over HTTPS.
- Secret keys are stored as SHA-256 hashes; dashboard cookies are signed, HttpOnly, SameSite=Lax.

## Smoke test on a clean machine

With the stack deployed at `https://registry.example` (registry) and `https://quote.example` (mock site):

- [ ] `curl https://registry.example/healthz` is `ok: true`, `storage: postgres`.
- [ ] `curl https://registry.example/.well-known/usher-keys.json` lists one key whose `kid` matches your signing key.
- [ ] **Knock from an MCP client.** Add the MCP entry from the README with `USHER_REGISTRY_URL=https://registry.example` and call `knock` with `{"url":"https://quote.example/quote/driver"}`; you get a token and (once seeded) a map.
- [ ] **Viewer on a real URL.** Open https://registry.example/viewer and build the map for `https://httpbin.org/forms/post`; a junk address gives a plain reason.
- [ ] **Dashboard.** Sign in at https://registry.example/dashboard with the site's origin and secret key.
- [ ] **Agent run.** `npm run e2e:remote -- --registry https://registry.example --site https://quote.example --secret uss_…` passes (recorded model responses; add `--live` to use the models).
- [ ] An unknocked `POST https://quote.example/api/quote` returns 403 `knock_required` and appears under blocked attempts on the dashboard.
