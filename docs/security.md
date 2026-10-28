# Security

Usher lets a website decide what AI agents may do on its forms and gives agents that follow the rules a faster way in. This page covers what could go wrong, what stops it, and what Usher does not try to do.

Three parties are involved. The **site** runs a script tag and a server-side check. The **registry** holds maps, issues tokens and keeps the log. The **agent** knocks before it fills a form.

## What Usher keeps

- Nothing you type is stored. Usher fills the form and forgets it.
- Maps describe forms, not answers. The site's log holds field names and your decisions, never the values.
- Medical questions are filled only if the site allows it, and only with your own answer, which you confirm.

The front page and the privacy notice say the same, word for word. In code: `usher_fill` holds the person's values in the fill's own job only, and drops the job when the fill completes, is cancelled or times out. `packages/mcp/test/forget.test.ts` runs a completed, a cancelled and a timed-out fill and finds none of the values in any file the registry writes, in what the process prints, or in any Postgres table. Medical questions have their own vocabulary keys (`health.*`, sensitive), and the site decides. By default they are the person's alone: an agent never fills them, and `usher_fill` stops on a page that requires one, leaving it to the person. A site's rules may permit them (`"health.condition": "confirm"`; see spec/policy.md): then `usher_fill` reads the person's own answer from what they said, enters it as they said it, and puts it back to them on the decision card before anything is submitted; if they say it isn't right, nothing is submitted. A plan never carries their values. `packages/mcp/test/permitted.test.ts` checks both.

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
- **A shared map is private until verified.** An agent's map is schema-checked, stored unverified, and served only to the agent that shared it. It becomes verified, and public, in one of two ways:
  - a second identity's own map of the same structure has the same key on every element, and that agent then completes a run through the page;
  - or the keeper, on a site it visits, rebuilds the form from the live page and gets the same map.
- **Who verified it is visible.** The map page and the site's dashboard show whether a map is verified, by whom and when. An unverified map doesn't appear on public map pages at all.
- **Disagreement is recorded, never served.** Another agent whose map differs is counted against the shared one; neither is served to anyone else. On a site the keeper visits, the keeper's own map replaces one it disagrees with, so a bad first submission can't hold a form's fast path.
- **Submissions are limited** to 20 an hour per agent identity.
- **Two keys can't simply agree with themselves.** The confirming agent must have an established identity:
  - it publishes its keys (Web Bot Auth with a `Signature-Agent` directory); or
  - it has completed a run on another site before.

  A key made a moment ago for the purpose has neither.
- **The keeper always wins where it visits.** On those sites, agents' agreement never verifies a map. Only the keeper's own rebuild does, and it replaces maps it disagrees with.
- **What's left:** an attacker who builds up an identity elsewhere first, then agrees with themselves on a site the keeper doesn't visit. That buys a public map only on a form both runs completed, still with risk floored and the server-side check enforcing the real action (below).
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

## Hosted MCP

The registry's hosted MCP endpoint (`/mcp`) runs `usher_fill` in our browser, for anyone who adds the URL. Its controls:

- **Where it acts.** Only on sites that have joined (a proved origin) and on the demo site. Anywhere else, the reply points to the local server and says why. A joined site can still block hosted agents as a class (`agents.hosted: "block"`).
- **Requests.** Every request a fill's browser makes, including redirects, scripts and frames, must reach a public address. That's the same check the map viewer uses, so a joined domain pointed at a private address gets nowhere.
- **Identity.**
  - Each connection gets its own key, minted on first use and held in memory only. Its public key isn't stored either.
  - The registry knocks for the connection in-process and marks the session `hosted`. It signs the token with `act: { "sub": "hosted" }`.
  - Nothing over HTTP can claim to be hosted.
- **Limits.**
  - Per connection: 60 requests a minute and 10 fills an hour.
  - Per address: a high ceiling, because assistants share their provider's addresses.
  - At most three fills at once, 500 open connections, and idle connections closed after 30 minutes.
  - Model fallback stays within the registry's daily spend cap.
- **Values.** They pass from the assistant's call into the site's form, in a fresh browser context closed when the fill ends. They are never logged or stored (see "What Usher keeps" above). A `needs_user` answer that isn't sensitive, such as whether the person smokes, is entered only as they said it and put back to them on the decision card before anything is submitted: if they say it isn't right, nothing is submitted.

## Other controls

- **Rate limits** on every registry endpoint, per address and per key, plus the site's own limits per agent (for example, five quotes an hour).
- **A daily cap on model spend.**
- **Outbound requests to addresses outsiders choose:** a site's claim file, an agent's key directory (in the registry and in the site middleware), and robots.txt. These go only to public internet addresses, checked on the address actually connected to, so a hostname that resolves or re-resolves to a private address is refused. They never follow redirects, and responses are capped.
- **Locked down for launch** (see DEPLOY.md, "Locked down for now"):
  - The map viewer no longer takes an address from the public (see "The map viewer" below).
  - The keeper opens only the origins in `USHER_KEEPER_ORIGINS` (our own demo site), for the same reason.
  - Maps submitted by agents are accepted again, behind the verification ladder above: private to their agent until a second agent or the keeper confirms them. `USHER_ACCEPT_MAPS=0` closes submissions entirely.
- **Security headers:** a strict Content-Security-Policy on every page, and CORS open only on the few endpoints the site script calls.
- **The registry's signing key** can be rotated, with old public keys kept published until their tokens expire.

## The map viewer

The viewer loads a page in a browser on Usher's server, maps its form with the model, and shows the map.

**Why the open endpoint was removed.** It used to take any address. That made it a tool for probing other people's sites from Usher's servers:
- anyone could make Usher load pages they chose, as often as the rate limits allowed, and read the result;
- its browser followed redirects and ran each page's own requests, so a public address could lead it on to private ones behind the first check. We confirmed this with a redirect to a local service.

**What replaced it:**
- **Visitors pick, they don't type.** They choose one of eleven forms (the demo site's two journeys and nine public forms) from a fixed list (`packages/registry/src/web/picker.ts`) by its id, and no address reaches the server. Results are cached by fingerprint digest and refreshed after each keeper run. A form that hasn't changed reuses its labels, so a refresh costs no model call. All of it is within the daily model budget.
- **Owners map their own pages.** A site owner signed in to the dashboard can map any page on the origin they have proved they control, and no other.
- **Every request is checked.** Whatever the page, every request the viewer's browser makes (the page, redirects, scripts, frames) is checked against the address it resolves to, and stopped if that is private.
- **Open mode is local only.** `USHER_VIEWER=open`, for local demos, and production refuses it.

**Why there is no CAPTCHA.** There's nothing left for a CAPTCHA to protect:
- the public can only choose from eleven cached forms, so a request costs Usher nothing new;
- the one open input belongs to authenticated owners, and only reaches their own site.

A CAPTCHA would also mean a third party's script and cookies on the front page, contradicting the privacy notice and the "no cookie banner" promise. We would revisit it only if the rate limits proved not enough.

## Considered and rejected: maps published in the page

For a day (PR #65), the site script wrote each form's map into the page as `<script type="application/usher+json">`, and the site's middleware pointed at it with a `Link: rel="usher-map"` header. Agents, the executor and `usher_fill` preferred that map to the registry's, and the knock returned only rules and a token. It made the knock smaller and let a changed form be relabelled on the spot.

We removed it (PR #67) because it is a trust problem:
- **Anything that can write into the page can rewrite the map.** That includes an injected script, a compromised third-party tag, a browser extension or user-generated content that reaches the DOM. A rewritten map can point a key at the wrong field, lower a risk so an agent submits without asking, or hide a field from the user.
- **The page can't sign it.** The registry signs tokens, and its maps are verified by a second identity or the keeper before any agent but their author sees them. A map in the page carries no signature an agent could check, and the site script can't hold a key the page itself can't read.
- **Clamping isn't enough.** We floored each key's risk at its vocabulary default, but a swapped key or a hidden field passes any floor.

Now:
- Agents get maps only from the registry, in the knock response (the map or a plan, with the rules and the token).
- The site script still extracts the live structure, compares it with the registry's map and reports drift, which triggers the keeper to rebuild and verify the map.
- A test serves every quote page with a tampered in-page map and a `Link` to another, and checks that the reference agent and `usher_fill` ignore both (`packages/mcp/test/page-content.test.ts`).

## What Usher does not do

**It does not detect agents that never identify themselves.** An automated browser that never knocks, never signs and sends no agent header looks like a person to the site, and Usher lets it through as one. Usher is a front door for agents that want to behave, not bot detection. For agents that won't knock, a site still needs its usual defences: rate limits, CAPTCHAs, fraud checks.

It also doesn't replace the site's own security. Sessions, CSRF protection and payment checks still apply. The script in the page is advisory: anything running in the page can ignore it, which is why enforcement lives on the server.
