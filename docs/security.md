# Security

Usher lets a website decide what AI agents may do on its forms and gives agents that follow the rules a faster way in. This page covers what could go wrong, what stops it, and what Usher does not try to do.

Three parties are involved. The **site** runs a script tag and a server-side check. The **registry** holds maps, issues tokens and keeps the log. The **agent** knocks before it fills a form.

## What could go wrong, and what stops it

**An agent that doesn't knock.** It fills the form and submits anyway.
The site's server is the lock, not the page. On a consequential endpoint (getting a quote, placing an order, an API) the server-side check wants a token from a knock, and refuses with `403 knock_required` and where to knock. The token must be signed by the registry, unexpired, for this origin and this intent, and must allow this action. Actions the site's rules say need the user's confirmation are refused unless the agent knocked again saying its user confirmed. The demo's "locked" and "rules hold" scenes show both refusals.

**A stolen or replayed token.** Someone copies a token from a request or a page and uses it again.
- Tokens last 10 minutes.
- Each one names its site and intent.
- The site keeps every token id it has accepted until expiry and refuses a second use.
- Each token carries the agent's public key (`cnf`), and agents sign their requests with that key (Web Bot Auth, RFC 9421). When a request is signed, the site checks that the signer is the agent the token was issued to, so a copied token is useless without the agent's private key. A site can require signatures outright.

**A poisoned map.** An agent shares a map that mislabels a form, for example marking "Buy now" as harmless.
- Maps are kept per origin: a map for one site can never be served for another.
- A map only matches a page whose structure gives the same fingerprint.
- Shared maps are schema-checked, marked unverified, and the dashboard shows which agent shared each one.
- A map can't weaken the lock. The server-side check enforces the action the endpoint itself performs (say `form.submit`), using the token's rules and the vocabulary's floor for that action, never the map's label for a button.
- Risk is floored by key. The registry raises every element of a shared map to at least its key's default risk, so a map can't call `form.submit` safe.
- When the form changes, the keeper rebuilds from the live page with its own model, not from what anyone sent.

**Drift spam.** Someone floods the registry with reports that a form has changed.
Drift reports need the site's key and are limited to 60 a minute per site. The registry scores the reported fingerprint itself rather than believing the reporter. A report only triggers a check: the keeper then looks at the real page, respecting robots.txt. So a false report costs a check, never a wrong map, and an unchanged form costs no model call.

**Session snooping.** Someone reads another site's agent sessions, or writes to them.
- **Reads** need the site's secret key. The registry stores only its hash and compares in constant time. The dashboard's sign-in cookie is HMAC-signed, HttpOnly and SameSite.
- **Writes:** events can be added to a session only with that session's token.
- **Claiming the origin.** Before a site sees anything, it must prove it controls its origin, with a file at `/.well-known/usher-site.json` or a DNS record at `_usher.<domain>`. This is re-checked daily. An unclaimed registration can be taken over after a day, so nobody can squat on someone else's domain.

**Leaking credentials or what people typed.** This is the one that matters most.
- **Maps hold structure, never values.** Extraction never reads what is in a field: no `.value`, no typed text, no selected option, no file name.
- **Screenshots** sent to the model have every typeable field masked.
- **The log records actions by semantic key**, such as "filled `person.dob`", never the value. When a site rejects a step, its error messages go only to the agent; the log records just which key was rejected, because a message can repeat what was typed.
- **Model API keys and the signing key** are read from the environment only and never logged. A site's secret key is shown once.
- **People are never beaconed.** The site script logs only sessions an agent has bound with a token. A person filling the same form sends nothing to the registry.

## Other controls

- **Rate limits** on every registry endpoint, per address and per key, plus the site's own limits per agent (for example, five quotes an hour).
- **A daily cap on model spend.**
- **Outbound requests to addresses outsiders choose:** a site's claim file, an agent's key directory (in the registry and in the site middleware), and robots.txt. These go only to public internet addresses, checked on the address actually connected to, so a hostname that resolves or re-resolves to a private address is refused. They never follow redirects, and responses are capped.
- **Locked down for launch** (see DEPLOY.md, "Locked down for now"):
  - The map viewer is off, and production refuses `USHER_VIEWER=1`. Its browser follows redirects, and the page's own requests can reach private addresses behind its address check.
  - The keeper opens only the origins in `USHER_KEEPER_ORIGINS` (our own demo site), for the same reason.
  - Maps submitted by agents are not accepted (`USHER_ACCEPT_MAPS`). A hostile agent could otherwise mislabel a form for every other agent.
- **Security headers:** a strict Content-Security-Policy on every page, and CORS open only on the few endpoints the site script calls.
- **The registry's signing key** can be rotated, with old public keys kept published until their tokens expire.

## What Usher does not do

**It does not detect agents that never identify themselves.** An automated browser that never knocks, never signs and sends no agent header looks like a person to the site, and Usher lets it through as one. Usher is a front door for agents that want to behave, not bot detection. For agents that won't knock, a site still needs its usual defences: rate limits, CAPTCHAs, fraud checks.

It also doesn't replace the site's own security. Sessions, CSRF protection and payment checks still apply. The script in the page is advisory: anything running in the page can ignore it, which is why enforcement lives on the server.
