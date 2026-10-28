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
| `usher_fill` | Fill a whole form journey for you: `url`, `intent` and `values` keyed by meaning (for example `person.first_name`). Runs in its own headless browser, fills every page, and stops at the first thing your user must decide (a consent, or a consequential action such as "Get my quote"), returning what it is about to do and an `id`. Values that won't fit come back first, by key, and nothing runs. |
| `usher_confirm` | Answer the pause for `id` (`answer`, default yes) and carry on. Returns the next pause, or the outcome, the session id and every action taken by key. |
| `usher_cancel` | Abandon the fill for `id`. Nothing more is entered or submitted. |

`usher_fill` never fills a field the map marks as the user's own to decide; it asks. On a page with no map it reads the page with a model (when `MODEL_API_KEY` is set, capped by `USHER_DAILY_MODEL_BUDGET_USD`, default $1 a day) and says which pages it read that way. The first `usher_fill` installs Playwright's Chromium if it isn't there.

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
