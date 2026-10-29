# Site apps

A site app is a site's own assistant app, hosted by Usher. A site that has joined Usher gets an MCP server at `/mcp/<its host>` on the registry. People add it to Claude, ChatGPT or any assistant that speaks MCP. In the assistant, the app carries the site's name and look. Each journey the site has mapped becomes one tool, and the app runs those journeys on the site's own form under the site's rules.

The demo insurer, Brightwater, is one. Its health insurance quote goes like this:

> Get me a health insurance quote from Brightwater. I'm Sam Taylor, born 2 April 1988, WR14 1AA, just me, non-smoker, comprehensive cover with a £250 excess.

The assistant calls Brightwater's `get_health_insurance_quote`, and Usher fills the safe fields on Brightwater's site. The questions that are the person's are shown to them in Brightwater's own wording, word for word: whether they smoke, and the declaration. The person ticks them and confirms. Usher then presses "Get my quote" and hands back:

- the quote as the site shows it;
- its reference;
- a "Continue on Brightwater Insurance" link to the site's own page for finishing.

## The twenty minutes

The owner works from `/dashboard/app`. Its setup strip shows each step: done, with when, or a link to do it.

1. **Join.** Get keys at `/sites/new`, prove the origin (a file at `/.well-known/usher-site.json` or a DNS record), and add the script tag.
2. **Map.** The [walkthrough](walkthrough.md) ("Map my site"), or compile and review: each journey's pages, every field and button by meaning. The owner publishes the maps. Maps hold structure, never values.
3. **Rules.** Written in plain English. Muse Spark turns them into policy, which the owner confirms. The rules say which questions are the person's alone, which actions need their yes, and how often.
4. **Look.** Usher reads the site's name, logo, colours, typeface and corners from the site's own pages. Muse Spark chooses among them, and the owner accepts or changes the result at `/dashboard/theme`. The [cards](mcp-apps.md) carry it.
5. **Publish.** One switch. It refuses while no journey is mapped.

Once the app is published, the strip shows "Joined to published" and how long it took. Brightwater, run as a fresh site with the real Muse Spark, took **79.1 s** of machine time and $0.10 in model calls:

| Step | Done at |
| --- | --- |
| Mapped (three health pages) | 63.2 s |
| Rules | 73.6 s |
| Look | 79.1 s |
| Published | 79.1 s |

The rest of the twenty minutes is the owner reading and clicking. The measurement is in [reports/log-2026-10-29.md](../reports/log-2026-10-29.md).

## What the owner controls

- **Whether the app answers at all.** Switched off, the endpoint answers no one, including assistants already connected.
- **Its name and look.** The accepted theme's name is the app's name everywhere: the MCP server, the tool descriptions, the cards and the directory pack. A derived theme is only a proposal until the owner accepts it. Themes are data from closed lists, never CSS or markup.
- **Its tools.** One per mapped journey. The owner can rename each one, describe it or hide it. Usher's own tool names, malformed names, duplicates and descriptions over 600 characters are refused, and markup is taken out. Hidden tools aren't offered.
- **The rules.** What the app may fill, which questions are the person's, which actions need confirming, and rate limits.
- **The record.** Every session is on the owner's dashboard: which fields were filled, what the person was shown, and what they confirmed. Never the values.
- **The directory pack.** A Markdown or JSON download with what Claude's and ChatGPT's app directories ask for. It lists what the owner still has to add: a contact, a privacy policy and screenshots. Submitting is the owner's to do.

## What Usher never stores

- **What anyone typed.** The person's details pass from the assistant's call into the site's form, in a fresh browser context that is closed when the fill ends. Usher fills the form and forgets it: no value is logged or stored.
- **Values in maps.** Maps describe forms, never answers. Extraction never reads an input's value.
- **Values in the theme or the tools.** Both are built from the site's structure and the owner's settings.
- **The pass.** The token is never shown on a card or in a result.

See [security.md](security.md), "What Usher keeps".

## Where it acts

- **Only on sites that joined, at the site's instruction.** Hosted filling runs only on sites that have joined Usher and switched their app on. A site app's endpoint acts only on its own origin.
- **Nothing on a third-party site.** Usher never submits to a site that hasn't joined.
- **No reaching across sites.** A connection to one site's app can't reach another site.
- **Rate limits.** Each site app has its own hourly allowance of fills, whoever the callers are. On the public demo, `form.submit` is limited to five per agent an hour.

## The other path: the plan

An assistant that drives its own browser can use the general endpoint at `/mcp`, or the local server, [`@usher-run/mcp`](../packages/mcp/). `get_plan` hands it the journey and the rules. `prepare_run` puts the person's answers in the site's format and, on a joined site, returns an entry URL with the token. The assistant then fills the form itself and stops where the rules say. See [integrations.md](integrations.md).
