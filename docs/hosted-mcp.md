# Hosted MCP: Usher in your assistant, nothing to install

`https://usher.run/mcp` is Usher's MCP server, hosted. Add the URL to your assistant as a remote MCP server (a "custom connector") and ask it to fill a form on a site that has joined Usher. Try it on the demo quote site: *"Get me a car insurance quote on brightwater.usher.run"*. Then watch your session appear on the [demo site's dashboard](https://usher.run/demo/dashboard).

It has the same tools as the local server ([`@usher-run/mcp`](../packages/mcp/)): `usher_fill`, `usher_confirm` and `usher_cancel` to fill a whole journey, plus `knock`, `get_map`, `get_plan` and `report_run`. The only one it leaves out is `submit_map`.

## Hosted or local

| | Hosted (`usher.run/mcp`) | Local (`npx -y @usher-run/mcp`) |
| --- | --- | --- |
| For | Assistants: claude.ai, Claude Desktop, ChatGPT, Cursor | Frameworks and your own agents |
| Install | Nothing: add a URL | Node 20+, one MCP server entry |
| Acts on | Sites that have joined Usher (and the demo site) | Any site |
| Identity | A key minted for each connection, held in memory, gone when it closes; shown to sites as `hosted:<thumbprint>` | Your agent's own key, kept at `~/.usher/agent-key.json` |
| Browser | Usher's, on our servers: a fresh browser context for each fill | Yours, on your machine |

Hosted Usher only acts where a site has said yes. Anywhere else it refuses, and its reply names the local server. A site that has joined can still turn hosted agents away as a class (see [For sites](#for-sites)).

## Add it

### claude.ai and Claude Desktop

Both use the same connectors, so adding it once covers both.

1. Open **Settings → Connectors**. In newer versions this is **Customize → Connectors**.
2. Choose **Add custom connector**.
3. Name it `Usher` and set the URL to `https://usher.run/mcp`. Leave Advanced settings empty: there is no sign-in.
4. In a chat, turn Usher on from the tools menu and ask for a quote on brightwater.usher.run.

Claude connects to the server from Anthropic's cloud, not from your computer. On Team and Enterprise plans an owner adds the connector under **Organization settings → Connectors**, and members connect to it.

### ChatGPT

1. Open **Settings → Apps & Connectors → Advanced settings** and turn on **Developer mode**. It's available on paid plans, and the menu names vary by release.
2. Create a connector with the server URL `https://usher.run/mcp` and authentication **No authentication**. Confirm you trust it.
3. In a chat, turn on the Usher connector from the developer mode tools.

### Cursor

Add this to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "usher": { "url": "https://usher.run/mcp" }
  }
}
```

### Anything else

Any client that supports MCP's streamable HTTP transport can connect to `https://usher.run/mcp` with no authentication. For Claude Code:

```bash
claude mcp add --transport http usher https://usher.run/mcp
```

## What it does with your data

- **Values:** the values your assistant passes to `usher_fill` go into the site's form in a fresh browser context, which is closed when the fill ends. They are never logged or stored.
- **What the site logs:** the session, by meaning, never values. It's the same log every Usher site gets.
- **Your key:** each connection's key lives in memory and is gone when the connection closes or sits idle for 30 minutes.
- **The registry's role:** it signs each token as acting for a hosted connection (`act: { "sub": "hosted" }`).

## Limits

Per connection:
- 60 requests a minute.
- 10 fills an hour.

Shared:
- Three fills run at once across everyone. Beyond that you're told to try again shortly, or to run the server locally.
- Assistants connect from their provider's addresses, so the per-address limits are a high ceiling shared by many users.
- Pages with no map fall back to the registry's model, within the registry's daily spend cap. Joined sites have maps, so this rarely happens.

## For sites

A site's rules can block hosted agents:

- **In plain English:** "no hosted agents".
- **In the policy:** `"agents": { "hosted": "block" }` (see the [policy spec](../spec/policy.md)).

Agents with their own key are unaffected. On the dashboard, hosted agents show as `hosted:<thumbprint>` with a **hosted** badge.
