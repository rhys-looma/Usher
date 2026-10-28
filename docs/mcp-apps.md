# Usher's cards (MCP Apps)

In clients that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (SEP-1865, spec revision 2026-01-26), Usher's tool results render as small cards in the chat:

- **The decision card** (`usher_fill` or `usher_confirm` paused). It shows the site and page it's for, the line "Usher is asking you, not the agent", and the site's consent wording word for word with a real checkbox for each required consent. Optional opt-ins are yes/no. The submit is named as the site names it ("Yes, press "Get my quote" for me"), with the text the site shows beside it. A missing value gets a text box. There is one **Confirm**.
- **The ticket** (`knock`). "Admit one agent": the agent's identity, the map for the page (fields by meaning), the house rules and how long the pass is valid. It's read-only.
- **The result card** (`usher_confirm` completed). The outcome, the result page's figures word for word (amounts, reference, validity), a screenshot thumbnail and a link to the page.

| Decision card | Result card | Ticket |
| --- | --- | --- |
| ![Decision card](mcp-apps/decision-card.png) | ![Result card](mcp-apps/result-card.png) | ![Ticket](mcp-apps/ticket.png) |

These screenshots are from the test harness ([`packages/mcp/test/apps.test.ts`](../packages/mcp/test/apps.test.ts), `USHER_CARD_SHOTS=docs/mcp-apps`) against a local Brightwater, which is why they show a localhost address.

**Nothing depends on the card.** The tool results are unchanged: the same text and structured content as before, which is what the model reads. A client without MCP Apps shows the text, and the conversation works exactly as it did.

## How it works

- **One resource for all three cards.** `ui://usher/card.html` (`text/html;profile=mcp-app`) draws whichever card the result calls for. `knock`, `usher_fill` and `usher_confirm` point at it with `_meta.ui.resourceUri`, plus ChatGPT's alias `openai/outputTemplate` with the same value.
- **Self-contained.** One HTML document, styles and script inline, system fonts. No external resources, no network calls and no tracking. Its CSP declares no domains (`csp: {}`), so hosts apply their strictest default. The only image is the screenshot, sent as a `data:` URL.
- **The protocol, without the SDK.** The card speaks the protocol directly over `postMessage`:
  - `ui/initialize`, then `ui/notifications/initialized`;
  - it receives `ui/notifications/tool-result`;
  - it sends `ui/notifications/size-changed` as its height changes, and follows the host's light or dark theme.
- **Answers go back to the model, never to a tool.** On Confirm, the decision card:
  - sends `ui/update-model-context` with the answers as structured content: `{ usher_confirm: { id, answers } }`;
  - sends `ui/message` (role user) with the same answers as text, asking the model to pass them to `usher_confirm` as they are.

  The card never calls a tool itself. ChatGPT doesn't let a card call tools, so this one path works everywhere.
- **Links** in the cards (to the result page, or to the terms a consent links to) go through `ui/open-link`, so the host decides how to open them.
- **What the card shows:** the site's own words and the user's own result. It never shows the pass (the token) or a value the user didn't supply.

## Set it up

### Claude (claude.ai and Claude Desktop), hosted

Add `https://usher.run/mcp` as a custom connector (Settings → Connectors → Add custom connector), as in [hosted-mcp.md](hosted-mcp.md). Then ask: "Get me a car insurance quote on brightwater.usher.run for this profile", followed by the profile.

**Claude's domain.** Claude gives each server's views a dedicated origin: the first 32 hex characters of the SHA-256 of the server's URL, under `claudemcpcontent.com`. For `https://usher.run/mcp`, the hosted endpoint returns this as `_meta.ui.domain` on the card when the client is Claude (its `clientInfo.name` contains "claude"). Other clients get no `domain`, and their default applies.

### Claude Desktop, local

Add the local server to `claude_desktop_config.json` and restart Claude Desktop:

```json
{ "mcpServers": { "usher": { "command": "npx", "args": ["-y", "@usher-run/mcp"] } } }
```

To try an unpublished build, use `"command": "node", "args": ["<repo>/packages/mcp/dist/cli.js"]`. A local server has no URL, so it sends no `domain`, and Claude's default origin applies.

### ChatGPT

Turn on developer mode and create a connector for `https://usher.run/mcp` with no authentication, as in [hosted-mcp.md](hosted-mcp.md#chatgpt). ChatGPT renders the card from `_meta.ui.resourceUri` (or `openai/outputTemplate`). Confirm's answers arrive as your next message, and the model calls `usher_confirm` with them.

## Per-client notes and quirks

- **ChatGPT: no tool calls from the card.** Every card hands its answers back to the model instead (above), in every client.
- **Claude: a domain is required** for a stable origin. It's computed from the server URL, not signed by a key, so it only applies to the hosted URL. A local stdio server can't have one.
- **`ui/message` content.** The spec's prose example shows `content` as a single block. The SDK's schema (`@modelcontextprotocol/ext-apps` 1.7.5) requires an array, and its `AppBridge` rejects a single block. The card sends an array.
- **No form submission.** Hosts sandbox the card, and a sandbox without `allow-forms` drops form submits silently. Confirm is a plain button.
- **No named helpers in in-page code.** The page-reading code that builds the verbatim blocks runs through `page.evaluate`, where tsx's `__name` wrapper on named inner functions breaks it. Only inline functions are used there.

## Verified so far

- **A host harness** (the test): a page that answers `ui/initialize` and passes real tool results from a full Brightwater journey.
  - All three cards render.
  - The decision card's Confirm sends `ui/update-model-context` and `ui/message` with `{ consent.declaration: true, consent.marketing: false, form.submit: true }`, and sends no `tools/call`.
  - Those answers complete the quote through `usher_confirm`, and the result card shows £… a year, the reference and the validity line word for word.
- **The official host bridge** (`AppBridge` from `@modelcontextprotocol/ext-apps` 1.7.5, in a page). The card's handshake is accepted, the tool result renders, and both `ui/update-model-context` and `ui/message` are accepted, after the array fix above.
- **Claude Desktop and ChatGPT:** not yet. Neither client is signed in where these tests ran. See the report for the steps to run.
