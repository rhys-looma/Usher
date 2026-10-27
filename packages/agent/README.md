# @usher/agent

A reference agent. For each page it:

1. finds the knock notice;
2. fingerprints the form and knocks, over HTTP or the MCP server;
3. binds the token in the page;
4. fills fields by semantic key from a profile.

It also:

- **Asks its user first.** It pauses before consequential actions and knocks again once its user confirms. Fields only the user may fill are left to them.
- **Checks data before filling.** Values are checked against the map, or the journey's plan, before anything is filled. When the site rejects a step, it gets `{ key, message }` back.
- **Signs its browser's requests to the site** with its key (Web Bot Auth).
- **Reads pages without a map.** With no map, it reads the page with Muse Spark (or Muse Spark Open with `--open`) and shares the map it built.

```bash
npm run agent -- "$SITE_URL/quote/driver" --profile packages/agent/profiles/test-driver.json [--mcp] [--auto-confirm] [--open] [--no-model] [--headed]
```

Also here, in `scripts/`:

| Command | What |
| --- | --- |
| `npm run demo [-- scene] [--now] [--once]` | The video's six scenes at `/demo` on a local registry (it prints the address; local only, `USHER_DEMO=1`). Scenes: `locked`, `says-yes`, `race`, `rules-hold`, `site-sees`, `stays-fresh`, or `all`. |
| `npm run benchmark [-- --runs 5] [--live]` | The same journeys with no Usher, with maps, and with a plan: [reports/benchmark.md](../../reports/benchmark.md). In a fresh clone the httpbin journey is left out until one `--live` run (about $0.03) records its responses. |
| `npm run demo:drift` | A form changes; the keeper rebuilds; agents are fast again: [reports/drift-demo.md](../../reports/drift-demo.md). |
| `npm run e2e:remote` | The end-to-end check against a running registry and demo site (Docker compose). |

Model calls in the demo and benchmark are replayed from recordings at their recorded latency unless `--live` is given.

```bash
npm test --workspace packages/agent
```
