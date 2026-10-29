# Ways to connect

Three ways an agent can use Usher. Each one fills the same journeys with the same maps and stops for the same decisions.

The demo site, Brightwater, offers two journeys: a health insurance quote (the example everywhere in these docs) and a car insurance quote.

> Get me a health insurance quote from Brightwater. I'm Sam Taylor, born 2 April 1988, WR14 1AA, just me, non-smoker, comprehensive cover with a £250 excess.

## In an assistant: hosted

Add `https://usher.run/mcp` as a remote MCP server (a custom connector). There's nothing to install, and setup for each assistant is in [hosted-mcp.md](hosted-mcp.md).

Usher gives your assistant the plan and the rules; your assistant drives its own browser.

1. **get_plan** with the site's page: the journey as Usher mapped it, the rules in plain words, what to ask you for first, the steps with each field by meaning and where to find it, and the stops where the site's own wording is shown to you. In assistants that show MCP Apps cards, the questions and the declaration appear as Usher's card.
2. **prepare_run** with your answers: they come back in the site's own format against each field (options as the site names them, dates as it wants them), with anything the site won't take named by key. On a site that has joined, it also returns an entry URL carrying the token for your session.
3. Your assistant opens the entry URL, fills each page in order, runs the lookups, stops at every stop for you, and submits only after you say yes.

- **Plans exist** for sites Usher has mapped: those that have joined (and walked their journey with "Map my site"), the demo site, and sites Usher's admin has mapped read-only. For any other site, get_plan says so and your assistant fills by sight.
- **Your details** never reach the site through Usher on this path: your own browser fills the form. Usher holds them only inside the prepare_run call, to put them in the site's format, and keeps none of them ([security.md](security.md), "What Usher keeps").
- **No browser?** `usher_fill` fills the form for you, on sites that have joined, in a browser on Usher's servers that is closed when the fill ends.

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
- Medical questions (`health.*`) are the site's to decide. By default the person answers them on the site; where the site's rules allow it, Usher fills them from what the person said, and the person confirms each answer.
- The site sees each agent's session by key on its dashboard, never the values.
