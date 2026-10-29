# Usher

An open protocol and script tag that lets websites control AI agents on their forms, and gives agents a fast, trusted way in.

**Usher makes sites with complex forms agent-ready without integrating new systems, standards or products.** Multi-step quote forms, applications and bookings stay exactly as they are. There's no API to build, no MCP server to run and no new standard to adopt. The site adds one script tag, plus a server-side check where it matters. The description agents need is built from the live page itself and kept up to date when the form changes.

> **Status:** built during the Meta Global AI Developer Hackathon (26 Oct – 4 Nov 2026). See [HACKATHON.md](HACKATHON.md).

## Map, knock, log

Agents can read any page. Forms are different: that's where agents act, and where sites carry the risk. Usher gives both sides three things.

- **Map.** A description of a form: each field and button by what it means (`person.dob`, `form.submit`), how risky it is to act on, and how to find it on the page. Meta's Muse Spark builds it from the page, code checks it, and it is shared. A map never holds anything a person typed.
- **Knock.** Before an agent fills a form, it knocks and says who it is, signing with its own key (Web Bot Auth). It gets back the map, the site's rules for that form, and short-lived signed permission. The site's page and server check that permission on their own.
- **Log.** While a knocked agent works, the site sees each step by meaning ("filled date of birth", "asked the user before *Get my quote*"), never the values. People using the site are never logged.

**For sites: the control layer for AI agents on your forms. No integration required.**
- **No changes to your systems.** One script tag on the pages you already have. Agents come through the same forms your customers use.
- **You set the terms.** Which forms, which actions need a person, how often, which agents. Written in plain English, enforced on every visit.
- **Every agent action on the record.** Who the agent was and what it did, step by step, by meaning. Your customers' data is never captured.

**For agents: Usher gives you the plan and the rules; you drive. No signup: your agent's key is its identity.** `get_plan` hands an assistant that drives its own browser the journey as Usher mapped it: what to ask the person first, each field by meaning and where to find it, and the stops where the site's own words go to the person. `prepare_run` puts the person's answers in the site's format and, on a site that has joined, returns an entry URL with the token. The assistant fills and stops where the rules say; Usher never touches the site with the person's values. No browser? `usher_fill` in [`@usher-run/mcp`](packages/mcp) fills the form for you.

**Not another declaration to write.** Proposals like WebMCP ask each site to declare its forms as tools in the page and keep those declarations in step with every redesign. With Usher, sites don't write declarations: Usher derives them from the live form and verifies them before any agent acts on them. The tag on the page watches for changes and reports drift, and agents get the map only from the registry, never from page content ([why](docs/security.md#considered-and-rejected-maps-published-in-the-page)).

**An agent that doesn't knock** is treated as it is today, except where the site's server requires a knock, for example on "Get my quote" or its API.

## Quickstart: a site

1. Get your keys at `/sites/new` on the registry: enter your site's address and you get a public site key and a secret key, shown once, with a download. No password. (Or by API: `curl -X POST "$REGISTRY_PUBLIC_URL/sites" -H 'Content-Type: application/json' -d '{"origin":"https://quote.example"}'`.)
2. Prove you control the origin. Publish `{"usher_site":"0.1","site_key":"usp_…"}` at `/.well-known/usher-site.json`, or a DNS TXT record `usher-site=usp_…` at `_usher.quote.example`, then press "Check now". The dashboard opens, signed in. Lost the secret key later? `/sites/lost` issues a new one after the same check.
3. Add one tag to your pages:

   ```html
   <script src="https://registry.example/usher.js" data-usher-registry="https://registry.example" data-usher-site-key="usp_…" defer></script>
   ```

Then lock consequential endpoints on your server with [`@usher/site-middleware`](packages/site-middleware/). The script in the page is a convenience; the server is the lock.

## Quickstart: an agent

**In an assistant** (claude.ai, Claude Desktop, ChatGPT, Cursor), add the public registry's `/mcp` address as a remote MCP server. There's nothing to install. Hosted Usher acts on sites that have joined Usher, such as the demo site, Brightwater; setup for each assistant is in [docs/hosted-mcp.md](docs/hosted-mcp.md), and the ways to connect are compared in [docs/integrations.md](docs/integrations.md). Then ask in plain words:

> Get me a health insurance quote from Brightwater. I'm Sam Taylor, born 2 April 1988, WR14 1AA, just me, non-smoker, comprehensive cover with a £250 excess.

Usher fills the safe fields, asks the person to confirm the smoker answer and the declaration in the insurer's own words, and leaves medical questions to the person unless the site allows them. Brightwater's car insurance quote works the same way.

**In a framework or your own agent,** run it locally. It acts on any site, with your own key. Add one MCP server entry: [`@usher-run/mcp`](packages/mcp/) on npm. It gives the agent `knock`, `get_map`, `get_plan`, `submit_map` and `report_run`, signed with its own key, which is created at `~/.usher/agent-key.json` on first use:

```json
{
  "mcpServers": {
    "usher": {
      "command": "npx",
      "args": ["-y", "@usher-run/mcp"]
    }
  }
}
```

It knocks on the public registry by default. For your own registry, add `"env": { "USHER_REGISTRY_URL": "https://registry.example" }` with its `REGISTRY_PUBLIC_URL`; the registry's front page shows the entry already filled in. `npx @usher-run/mcp --check` knocks on the demo site and prints what came back. The MCP server runs where the agent runs, because it holds the agent's private key; only the registry URL is shared. Setup for Claude Desktop, Cursor and other clients is in [packages/mcp](packages/mcp/README.md).

## Try it

You need Node 20+ and a fresh clone:

```bash
npm install
npm test
```

`npm test` builds everything, installs Chromium for Playwright, and runs the suite offline from recorded model responses.

**The demo**, scene by scene against the live registry and demo site: each scene resets the demo site, opens its windows and prints the numbers it shows. Scenes 1 to 8, or `all`; `--once` closes the windows when done.

```bash
npm run demo -- 3
```

`npm run demo:local` is the first video's six scenes on a local registry and demo site, at `/demo` on the registry.

**Each piece by hand.** Set two addresses first: `REGISTRY_PUBLIC_URL`, where the registry will be reached (it listens on port 4200), and `SITE_URL`, the demo site (port 4100). Then start the registry with demo maps (it prints the demo site's keys), the demo site, and the agent:

```bash
npm run registry -- --seed mock-site --seed-origin "$SITE_URL" --allow-private
```

```bash
USHER_REGISTRY_URL="$REGISTRY_PUBLIC_URL" USHER_SITE_KEY=usp_… npm start --prefix examples/mock-quote-site
```

```bash
npm run agent -- "$SITE_URL/health/about" --profile packages/agent/profiles/test-health.json --mcp --auto-confirm
npm run agent -- "$SITE_URL/quote/driver" --profile packages/agent/profiles/test-driver.json --mcp --auto-confirm
```

- The dashboard, at `/dashboard` on the registry, signed in with the secret key, shows the session, lets you write rules in English, and lists blocked attempts.
- The front page builds a map for any public form.
- `/__admin` on the demo site switches the form's layout, to watch the map go stale and rebuild.

Live model calls need `MODEL_API_KEY` (Meta Model API) and `BASETEN_API_KEY` (Muse Spark Open) in `.env`. Without them, everything runs from recordings.

**With Docker:** `docker compose up --build`, then `npm run e2e:remote`. The addresses are in `docker-compose.yml`. [DEPLOY.md](DEPLOY.md) covers hosting.

## What Usher can fill

The model labels each field by meaning; the code locates it and fills it from the person's value, written one way by key (dates YYYY-MM-DD, answers by meaning).

| Control | How it is filled | Since |
| --- | --- | --- |
| Text, email, phone, number, text area | Typed as given | 26 Oct |
| Date picker | YYYY-MM-DD as given | 26 Oct |
| Date as text in the site's format (DD/MM/YYYY, MM/YYYY …) | Written in the format the field's placeholder, label or pattern shows | 28 Oct |
| Date split into day, month and year | Each part (`part` in the map) from the one date | 28 Oct |
| Select and radio group | The option the value means: by value, label, yes/no, or the one number it carries ("250" is "£250", "12,000" is "Up to 12,000 a year"), a year included; else Muse Spark picks one of the labels | 28 Oct (by value only before) |
| Radios styled as cards (hidden input, visible label) | The radio, or its label when the input can't be checked | 28 Oct |
| Checkbox | Ticked or not; consents only from the person's own answer | 26 Oct |
| Fields shown only after an answer (`shown_if`) | Filled when their condition holds | 26 Oct |
| Lookup (`lookup.vehicle`, `lookup.address`) | Run first from the registration or postcode; what it fills is left as it filled it; a list of results gets the entry for the first address line | 28 Oct |
| An answer that is the person's alone but not sensitive (`person.smoker`) | Entered only as they said it, and shown back to them on the decision card with the submit: if it isn't right, nothing is submitted | 28 Oct |
| Medical questions (`health.*`, sensitive) | The site decides. By default they're left to the person, and Usher stops on a page that requires one. Where the site's rules allow them (`confirm`), from what the person said, put back to them on the decision card | 28 Oct (site rules 29 Oct) |
| Combobox, custom dropdown | Not yet: none of the real journeys checked so far needed one | |

## Benchmark

The same journeys three ways, five runs each, with model latency replayed from recordings. These are medians; [reports/benchmark.md](reports/benchmark.md) has the method and ranges.

| Journey | Without Usher (reads every page) | With maps (knock or lookup) | With a plan, then maps |
| --- | --- | --- | --- |
| Brightwater Health, 3 steps (demo site) | 17.09 s · $0.030 (Muse Spark) / 62.82 s · $0.024 (Spark Open) | 3.07 s / 3.07 s · $0 | 3.05 s / 3.06 s · $0 |
| Brightwater car quote, 3 steps (demo site) | 17.42 s · $0.036 / 24.12 s · $0.024 | 2.88 s / 2.90 s · $0 | 2.89 s / 2.92 s · $0 |
| httpbin.org/forms/post, 1 page | 11.22 s · $0.012 / 7.77 s · $0.008 | 2.53 s / 2.57 s · $0 | 2.53 s / 2.55 s · $0 |

Spark Open's times are its recorded calls, made on 28 October while Baseten was slow (up to a minute a page). With a map, an agent spends no model tokens on the form at all. The map is built once, by the registry's keeper or by agents, and kept fresh by the keeper. An agent's map serves only that agent until it is verified: a second, independent agent builds the same map and completes the form, or the keeper rebuilds the form and gets the same result. Then it serves every agent.

## Documents

| | |
| --- | --- |
| [spec/](spec/) | The specifications, with JSON Schemas: [map](spec/map.md), [vocabulary](spec/vocabulary.md), [knock](spec/knock.md) (including Web Bot Auth and domain claims), [policy](spec/policy.md), [plan](spec/plan.md) |
| [DEPLOY.md](DEPLOY.md) | Deploying to AWS (CloudFront, ALB, ECS Fargate, RDS), the pre-deploy dry run, configuration, backups |
| [docs/security.md](docs/security.md) | Threats, controls, and what Usher does not do |
| [docs/finetune.md](docs/finetune.md) | A small labeller: the short list and retrieval few-shot (no training, measured), the per-element dataset, and how Muse Glimmer would be tuned |
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
| [`examples/mock-quote-site/`](examples/mock-quote-site/) | Brightwater, a fictional insurer: a health insurance quote and a car insurance quote, each three steps, for development and the demo |

## Open by design

The map schema, knock protocol, policy format, site script and middleware are open, and anyone can run a registry. Code is under the [Apache License 2.0](LICENSE); the specifications in [`spec/`](spec/) are CC BY 4.0.

Built by Rhys at Looma.
