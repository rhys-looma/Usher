# Ways to connect

Three ways an agent can use Usher. Each one fills the same journeys with the same maps and stops for the same decisions.

The demo site, Brightwater, offers two journeys: a health insurance quote (the example everywhere in these docs) and a car insurance quote.

> Get me a health insurance quote from Brightwater. I'm Sam Taylor, born 2 April 1988, WR14 1AA, just me, non-smoker, comprehensive cover with a £250 excess.

## In an assistant: hosted

Add `https://usher.run/mcp` as a remote MCP server (a custom connector). There's nothing to install, and setup for each assistant is in [hosted-mcp.md](hosted-mcp.md).

- **Acts on** sites that have joined Usher, and the demo site.
- **Your details** pass from the assistant into the site's form, in a browser on Usher's servers that is closed when the fill ends. Usher fills the form and forgets it: nothing you type is stored ([security.md](security.md), "What Usher keeps").

## On your own machine: the local server

```json
{ "mcpServers": { "usher": { "command": "npx", "args": ["-y", "@usher-run/mcp"] } } }
```

`npx -y @usher-run/mcp` runs Usher's MCP server where your agent runs. It fills forms in a browser on your machine, so **your details stay on your machine**: they go only into the site's own form. Usher's registry sees only the knock, the map lookup and the session log, by key. (If you give your details as prose rather than by key, the local server sends that text to the model, with your own `MODEL_API_KEY`, to read it against the form.)

- **Acts on** any site, with your agent's own key (`~/.usher/agent-key.json`).
- **Use it for** frameworks and your own agents, or whenever you'd rather your details stayed on your computer.

Setup for Claude Desktop, Cursor and other clients is in [packages/mcp](../packages/mcp/README.md).

## In your own code: the reference agent

```bash
npm run agent -- "$SITE_URL/health/about" --profile packages/agent/profiles/test-health.json --mcp --auto-confirm
```

[`packages/agent`](../packages/agent/) knocks, fills by key from a profile and asks before anything consequential. It's the code the benchmark runs.

## What every way has in common

- The person decides. Consents, the submit, and answers that are theirs alone (whether they smoke) are put to them in the site's own words, unticked.
- Medical questions (`health.*`) are never filled. The insurer asks the person those, on its own site, usually after the quote.
- The site sees each agent's session by key on its dashboard, never the values.
