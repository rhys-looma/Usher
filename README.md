# Usher

An open protocol and script tag that lets websites control AI agents on their forms, and gives agents a fast, trusted way in.

> **Status:** being built during the Meta Global AI Developer Hackathon (26 Oct – 4 Nov 2026). See [HACKATHON.md](HACKATHON.md).

## The idea

Agents can read any page. Forms are different: that's where agents act, and where sites carry the risk.

1. A site adds one script tag. Its forms now carry a machine-readable notice: *this form has an agent lane, knock here*.
2. An agent **knocks**: a signed request with the URL and what it's trying to do.
3. The registry returns a **map** of the form (fields, steps, which actions are consequential), the **site's rules**, and a short-lived **token**.
4. The site's script unlocks the form under those rules and logs the agent's actions. It never tracks human visitors.
5. The site's server checks the token on consequential submits. That's the real lock.
6. No map, or a plan that breaks? The agent falls back to reading the page, exactly as today. Usher can only make things faster and safer.

**For agents:** a shared map of the form instead of a 20k-token DOM, a plan that runs in seconds, and a trusted lane through the front door.
**For sites:** see which agents use your forms and what they do, and set the rules: which forms, what needs a human, how often.

## Open by design

The map schema, knock protocol, policy format, site script and middleware are open. Anyone can run a registry. Maps hold structure only, never the values anyone typed.

- Code: [Apache License 2.0](LICENSE)
- Specifications in [`spec/`](spec/): CC BY 4.0

## Repository layout

| Path | What |
| --- | --- |
| [`spec/`](spec/) | Map schema, field vocabulary (knock protocol and policy format to follow) |
| [`packages/core/`](packages/core/) | Form extractor, locators and fingerprint, running in Node and in the page |
| [`examples/mock-quote-site/`](examples/mock-quote-site/) | A fictional multi-step quote form used for development and the demo |

Built by Rhys at Looma.
