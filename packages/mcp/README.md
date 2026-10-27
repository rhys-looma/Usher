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
