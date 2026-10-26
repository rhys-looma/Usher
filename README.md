# Usher

An open protocol and script tag that lets websites control AI agents on their forms, and gives agents a fast, trusted way in.

> **Status:** being built during the Meta Global AI Developer Hackathon (26 Oct – 4 Nov 2026). See [HACKATHON.md](HACKATHON.md).

## The idea

Agents can read any page. Forms are different: that's where agents act, and where sites carry the risk.

1. A site adds one script tag. Its forms now carry a machine-readable notice: *this form has an agent lane, knock here*.
2. An agent **knocks**: a signed request with the URL and what it's trying to do.
3. The registry returns a **map** of the form (fields, steps, which actions are consequential), the **site's rules**, and a short-lived **token**.
4. The site's script unlocks the form under those rules and logs the agent's actions. It never tracks human visitors.
5. The site's server checks the token on consequential submits. That's the real lock.
6. No map, or a plan that breaks? The agent falls back to reading the page, exactly as today. Usher can only make things faster and safer.

**For agents:** a shared map of the form instead of a 20k-token DOM, a plan that runs in seconds, and a trusted lane through the front door.
**For sites:** see which agents use your forms and what they do, and set the rules: which forms, what needs a human, how often.

## How it works

Three things: a **map**, a **knock** and a **log**.

- **Map.** A description of a form: each field and button by what it means (`person.dob`, `form.submit`), how risky it is to act on, and how to find it on the page. Built by Meta's Muse Spark from the page itself, checked by code, and shared. A map never holds anything a person typed.
- **Knock.** Before an agent fills a form it knocks, saying who it is. It gets back the map, the site's rules for that form, and short-lived signed permission to use it. The site's page and server can check that permission on their own, without asking anyone.
- **Log.** While a knocked agent works, the site sees each step by meaning ("filled date of birth", "asked the user before *Get my quote*"), never the values. People using the site are never logged.

An agent that knocks gets a fast, trusted path: on the demo quote form, three pages take about 2.7 s with a map against about 15 s reading each page with the model. An agent that doesn't knock is treated as it is today, except where a site requires a knock (for example on its API).

## Quickstart

**A site** adds one tag to its pages:

```html
<script src="https://registry.example/usher.js" data-usher-registry="https://registry.example" defer></script>
```

Optionally, it checks knocks on consequential endpoints on its server with [`@usher/site-middleware`](packages/site-middleware/), and publishes `/.well-known/usher.json` naming its registry.

**An agent** adds one MCP server entry, which gives it `knock`, `get_map`, `submit_map` and `report_run`, signed with its own key (created at `~/.usher/agent-key.json` on first use):

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

**Try it locally** (Node 20+):

```sh
npm install && npm run build
npm run registry -- --seed mock-site                                    # registry on :4200 with the demo maps
USHER_REGISTRY_URL=http://localhost:4200 npm start --prefix examples/mock-quote-site   # demo site on :4100
npm run agent -- http://localhost:4100/quote/driver --profile packages/agent/profiles/test-driver.json --mcp
```

The agent asks before *Get my quote* and leaves declarations to you. Switch the demo site's layout at `http://localhost:4100/__admin` to see the site script report the change.

## Open by design

The map schema, knock protocol, policy format, site script and middleware are open. Anyone can run a registry. Maps hold structure only, never the values anyone typed.

- Code: [Apache License 2.0](LICENSE)
- Specifications in [`spec/`](spec/): CC BY 4.0

## Repository layout

| Path | What |
| --- | --- |
| [`spec/`](spec/) | Map schema, field vocabulary, knock protocol (policy format to follow) |
| [`packages/core/`](packages/core/) | Form extractor, locators, fingerprint, label validator and the Muse Spark map compiler |
| [`packages/registry/`](packages/registry/) | The registry: knocks, maps, logs; HTTP and MCP |
| [`packages/site-script/`](packages/site-script/) | The one-tag site script |
| [`packages/site-middleware/`](packages/site-middleware/) | The server-side check |
| [`packages/agent/`](packages/agent/) | A reference agent (Playwright, Muse Spark when there's no map) |
| [`examples/mock-quote-site/`](examples/mock-quote-site/) | A fictional multi-step quote form used for development and the demo |

Built by Rhys at Looma.
