# Usher

An open protocol and script tag that lets websites control AI agents on their forms, and gives agents a fast, trusted way in.

**Usher makes sites with complex forms agent-ready without integrating new systems, standards or products.** Multi-step quote forms, applications and bookings stay exactly as they are. There's no API to build, no MCP server to run and no new standard to adopt. The site adds one script tag, plus a server-side check where it matters. The description agents need is built from the live page itself and kept up to date when the form changes.

> **Status:** built during the Meta Global AI Developer Hackathon (26 Oct – 4 Nov 2026). See [HACKATHON.md](HACKATHON.md).

## Map, knock, log

Agents can read any page. Forms are different: that's where agents act, and where sites carry the risk. Usher gives both sides three things.

- **Map.** A description of a form: each field and button by what it means (`person.dob`, `form.submit`), how risky it is to act on, and how to find it on the page. Meta's Muse Spark builds it from the page, code checks it, and it is shared. A map never holds anything a person typed.
- **Knock.** Before an agent fills a form, it knocks and says who it is, signing with its own key (Web Bot Auth). It gets back the map, the site's rules for that form, and short-lived signed permission. The site's page and server check that permission on their own.
- **Log.** While a knocked agent works, the site sees each step by meaning ("filled date of birth", "asked the user before *Get my quote*"), never the values. People using the site are never logged.

**For agents:** a map instead of a 20k-token page, and a trusted lane through the front door. On the demo quote form, three pages take 2.7 s with maps against 14 s reading each page with a model.

**For sites:** see which agents use your forms and what they do, and set the rules in plain English: which forms, what needs the user's yes, and how often.

**An agent that doesn't knock** is treated as it is today, except where the site's server requires a knock, for example on "Get my quote" or its API.

## Quickstart: a site

1. Register your origin with a registry. You get a public site key and a secret key, shown once:

   ```bash
   curl -X POST http://localhost:4200/sites -H 'Content-Type: application/json' -d '{"origin":"https://quote.example"}'
   ```

2. Prove you control the origin. Publish `{"usher_site":"0.1","site_key":"usp_…"}` at `/.well-known/usher-site.json`, or a DNS TXT record `usher-site=usp_…` at `_usher.quote.example`. Then press "Check now" in the dashboard.
3. Add one tag to your pages:

   ```html
   <script src="https://registry.example/usher.js" data-usher-registry="https://registry.example" data-usher-site-key="usp_…" defer></script>
   ```

Then lock consequential endpoints on your server with [`@usher/site-middleware`](packages/site-middleware/). The script in the page is a convenience; the server is the lock.

## Quickstart: an agent

Add one MCP server entry, pointed at a registry. It gives the agent `knock`, `get_map`, `get_plan`, `submit_map` and `report_run`, signed with its own key, which is created at `~/.usher/agent-key.json` on first use:

```json
{
  "mcpServers": {
    "usher": {
      "command": "npx",
      "args": ["tsx", "/path/to/Usher/packages/registry/src/mcp.ts"],
      "env": { "USHER_REGISTRY_URL": "http://localhost:4200" }
    }
  }
}
```

The MCP server runs where the agent runs, because it holds the agent's private key. Only the registry URL is shared.

## Try it

You need Node 20+ and a fresh clone:

```bash
npm install
npm test
```

`npm test` builds everything, installs Chromium for Playwright, and runs the suite offline from recorded model responses.

**The demo**, as in the video: six scenes on a local registry and the demo site, at http://localhost:4200/demo. Press 1 to 6, or 0 for all of them.

```bash
npm run demo
```

**Each piece by hand.** Start the registry with demo maps (it prints the demo site's keys), then the demo site, then the agent:

```bash
npm run registry -- --seed mock-site --allow-private
```

```bash
USHER_REGISTRY_URL=http://localhost:4200 USHER_SITE_KEY=usp_… npm start --prefix examples/mock-quote-site
```

```bash
npm run agent -- http://localhost:4100/quote/driver --profile packages/agent/profiles/test-driver.json --mcp --auto-confirm
```

- The dashboard at http://localhost:4200/dashboard, signed in with the secret key, shows the session, lets you write rules in English, and lists blocked attempts.
- http://localhost:4200/viewer builds a map for any public form.
- http://localhost:4100/__admin switches the demo form's layout, to watch the map go stale and rebuild.

Live model calls need `MODEL_API_KEY` (Meta Model API) and `BASETEN_API_KEY` (Muse Spark Open) in `.env`. Without them, everything runs from recordings.

**With Docker:** `docker compose up --build`, then `npm run e2e:remote`. [DEPLOY.md](DEPLOY.md) covers hosting.

## Benchmark

The same journeys three ways, five runs each, with model latency replayed from recordings. These are medians; [reports/benchmark.md](reports/benchmark.md) has the method and ranges.

| Journey | Without Usher (reads every page) | With maps (knock or lookup) | With a plan, then maps |
| --- | --- | --- | --- |
| Demo quote site, 3 steps | 14.22 s · $0.031 (Muse Spark) / 14.01 s · $0.026 (Spark Open) | 2.68 s / 2.71 s · $0 | 2.69 s / 2.69 s · $0 |
| httpbin.org/forms/post, 1 page | 11.12 s · $0.011 / 9.56 s · $0.013 | 2.53 s / 2.58 s · $0 | 2.54 s / 2.58 s · $0 |

With a map, an agent spends no model tokens on the form at all. The map is built once, by the first agent or the registry, and kept fresh by the keeper.

## Documents

| | |
| --- | --- |
| [spec/](spec/) | The specifications, with JSON Schemas: [map](spec/map.md), [vocabulary](spec/vocabulary.md), [knock](spec/knock.md) (including Web Bot Auth and domain claims), [policy](spec/policy.md), [plan](spec/plan.md) |
| [DEPLOY.md](DEPLOY.md) | Running a registry: Docker, Postgres, keys, configuration |
| [docs/security.md](docs/security.md) | Threats, controls, and what Usher does not do |
| [docs/finetune.md](docs/finetune.md) | The per-element fine-tuning set and how a small model would be tuned and scored |
| [reports/](reports/) | [Benchmark](reports/benchmark.md), [drift and rebuild](reports/drift-demo.md), [map accuracy](reports/accuracy.md), [classifier agreement](reports/classifier-agreement.md) |
| [HACKATHON.md](HACKATHON.md) | Build log and the Meta models used |

## Repository

| Path | What |
| --- | --- |
| [`packages/core/`](packages/core/) | Extraction, locators, fingerprints, tokens, signatures, and the Muse Spark map compiler |
| [`packages/registry/`](packages/registry/) | The registry: knocks, maps, rules, logs, dashboard, keeper; HTTP and MCP |
| [`packages/site-script/`](packages/site-script/) | The one-tag site script |
| [`packages/site-middleware/`](packages/site-middleware/) | The server-side check |
| [`packages/agent/`](packages/agent/) | A reference agent, the benchmark and the demo runner |
| [`examples/mock-quote-site/`](examples/mock-quote-site/) | A fictional multi-step quote form, for development and the demo |

## Open by design

The map schema, knock protocol, policy format, site script and middleware are open, and anyone can run a registry. Code is under the [Apache License 2.0](LICENSE); the specifications in [`spec/`](spec/) are CC BY 4.0.

Built by Rhys at Looma.
