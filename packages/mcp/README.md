# @usher-run/mcp

Usher for AI agents. An MCP server that lets your agent **knock** before it fills a web form. In return it gets:
- the form's **map**: every field by meaning, with how risky each action is;
- the **site's rules**;
- a short-lived **pass**.

Sites that use Usher let agents that knock straight in, while agents that don't are held at the door.

No signup. Your agent's key is its identity: it is made on first run and kept on your machine.

```sh
npx @usher-run/mcp --check     # knocks on the Brightwater demo form and prints what came back
```

`--check` prints your knock's session id and a link to the demo site's live dashboard, [usher.run/demo/dashboard](https://usher.run/demo/dashboard): the site's view of your agent, read-only and open to anyone. Run `usher_fill` on the demo quote and your agent's session appears there within seconds, every step by meaning and never the values.

**No install at all:** assistants such as claude.ai, Claude Desktop, ChatGPT and Cursor can add `https://usher.run/mcp` as a remote MCP server instead. It has the same tools, less `submit_map`. Hosted Usher acts on sites that have joined Usher; this package acts on any site, with your own key. See [docs/hosted-mcp.md](https://github.com/rhys-looma/Usher/blob/main/docs/hosted-mcp.md).

## Add it to your agent

### Claude Desktop

In `claude_desktop_config.json` (Settings → Developer → Edit Config):

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

Restart Claude Desktop. The Usher tools appear under "usher".

### Cursor

In `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

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

### Any MCP client

Run `npx -y @usher-run/mcp` as a **stdio** server. Set its environment if you need to:

| Variable | Default | Meaning |
| --- | --- | --- |
| `USHER_REGISTRY_URL` | `https://usher.run` | The registry to knock on. Set it for a self-hosted registry. |
| `USHER_AGENT_KEY_FILE` | `~/.usher/agent-key.json` | The agent's private key (Ed25519). Created on first run, readable only by you. Keep it: it is who your agent is. |

For example:

```json
{
  "command": "npx",
  "args": ["-y", "@usher-run/mcp"],
  "env": { "USHER_REGISTRY_URL": "https://registry.example" }
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `knock` | Before filling a form. Returns the map, the site's rules and a short-lived token to bind in the page (`window.usher.bind(token)`). Pass `confirmed` with the keys your user just approved (for example `form.submit`) when knocking right before acting on them. |
| `get_map` | The map for a page, by fingerprint or by digest. |
| `get_plan` | Every step of a multi-page journey, and every input it will ask for by meaning, so you can check your user's data before starting. |
| `submit_map` | Share a map you built for a page that had none. It serves only you until a second agent or the registry's keeper confirms it, then every agent. |
| `report_run` | Tell the site how the run went: structure and timings, never values. |
| `usher_fill` | Fill a whole form journey for you. Say it as the person did: `site` (a name such as "Brightwater", an address or any URL on it), `task` ("car insurance quote") and `details` in their own words, which Muse Spark reads against the form's own fields (one call, needs `MODEL_API_KEY`). Or exactly: `url`, `intent` and `values` keyed by meaning (for example `person.first_name`); these win when both are given. It runs the site's own lookups (a car from its registration), so make, model and year are optional when there is one. It runs in its own headless browser and fills every page. Before consents and submissions it pauses once, returning every decision it knows of for the rest of the journey (`decisions`, each a required or optional consent, the submit, or a missing value) with the page's own words as verbatim `blocks`, and an `id`. Values in the wrong format come back first, by key, and nothing runs. |
| `usher_confirm` | Submits for your user. Answer every decision for `id` at once: the person's reply word for word as `confirmation` ("Confirm: declaration yes, marketing no, get my quote yes"), or `answers` by key, `true`/`false` for consents and the submit, the value for a missing value. Returns the outcome: the result page's `title`, its figures as verbatim `facts`, the final URL, a screenshot, and what was `submitted`, by key. It pauses again only if a later page shows something new. |
| `usher_cancel` | Abandon the fill for `id`. Nothing more is entered or submitted. |

`usher_fill` never fills a field the map marks as the user's own to decide; it asks. The tool descriptions tell the agent to put every decision to its user, to show every verbatim block word for word (a consent's exact wording and the terms it links to, the text beside "Get my quote", the quote's figures), and never to answer for the user. The session log records which blocks were shown, by key and a hash of the text, never the text. The response shape is in [spec/knock.md](https://github.com/rhys-looma/Usher/blob/main/spec/knock.md#8-filling-for-a-user-decision-sets-and-verbatim-blocks). On a page with no map it reads the page with a model (when `MODEL_API_KEY` is set, capped by `USHER_DAILY_MODEL_BUDGET_USD`, default $1 a day) and says which pages it read that way. The first `usher_fill` installs Playwright's Chromium if it isn't there.

In clients that support MCP Apps (Claude, ChatGPT), `knock`, `usher_fill` and `usher_confirm` also render as small cards: the decision card (the site's consent wording with real checkboxes and one Confirm, whose answers go back to your assistant for `usher_confirm`), the "Admit one agent" ticket, and the result card. The text results are unchanged, and nothing depends on the cards. See [docs/mcp-apps.md](https://github.com/rhys-looma/Usher/blob/main/docs/mcp-apps.md).

Every request is signed with your agent's key (Web Bot Auth, RFC 9421). Maps hold structure, never values: nothing anyone types is read, sent or stored.

## Options

```sh
npx @usher-run/mcp            # serve over stdio (what MCP clients run)
npx @usher-run/mcp --check    # knock on the demo site and print the result
npx @usher-run/mcp --version
```

Needs Node 20 or later.

## Licence

Apache-2.0. Source, specifications and the self-hosted registry: https://github.com/rhys-looma/Usher
