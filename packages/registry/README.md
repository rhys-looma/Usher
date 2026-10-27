# @usher/registry

The registry. It holds maps per origin, answers knocks with a map, the site's rules and a signed token, and keeps each agent session as a log by semantic key.

- **HTTP API** (`http.ts`):
  - `POST /knock`, `/maps/lookup`, `/maps` and `/runs`, and `GET /plans`;
  - `/sites` (register, verify the domain claim, rules, blocked reports);
  - `/sessions` and `/drift`;
  - `/.well-known/usher-keys.json`, and the site script at `/usher.js`.
- **Web pages** (`web/`):
  - the front page (`/`): what Usher is, the map viewer inline, both quickstarts with this registry's address, the numbers from `reports/`, and an interest form that carries Usher's own tag and is locked to agents that didn't knock, like any site's;
  - the site dashboard (sessions, rules in plain English, blocked attempts, drift), which shows a site nothing until it has claimed its origin;
  - `/spec/`, the specifications, with this registry's address in their examples, and `/admin` (with `USHER_ADMIN_KEY`), the interest list.
- **Usher's own site:** the registry registers its own origin, serves its claim file at `/.well-known/usher-site.json`, and runs the server-side check on its interest form (`contact.interest`).
- **MCP server** (`mcp.ts`), run where the agent runs, since it holds the agent's key. It offers the tools `knock`, `get_map`, `get_plan`, `submit_map` and `report_run`.
- **The keeper** (`keeper.ts`): re-checks known forms, and rebuilds a map when a form really changed. Muse Spark Open triages the change; Muse Spark recompiles.
- **Storage:** JSON files by default, or Postgres when `DATABASE_URL` is set, with migrations in `migrations/`.

Agents prove who they are with Web Bot Auth (HTTP Message Signatures) or a signed body; see [spec/knock.md](../../spec/knock.md).

Commands, from the repository root:

```bash
npm run registry -- --seed mock-site --seed-origin "$SITE_URL" --allow-private
```

That serves the registry on :4200 with the demo site's maps; configuration is in `src/server.ts` and [DEPLOY.md](../../DEPLOY.md).

```bash
npm run keygen
npm test --workspace packages/registry
```

`npm run keygen` makes a token signing key for `USHER_SIGNING_KEY`, printed to standard output; keep it out of the repository. The tests run on files, or on Postgres with `DATABASE_URL`.
