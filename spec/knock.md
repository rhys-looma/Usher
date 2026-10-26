# Usher knock protocol, draft 0.1

A site tells agents where to **knock**. An agent knocks at the site's registry with a signed request and gets back a **map** of the form, the site's **rules** for it, and a short-lived **token**. The site's script and server check that token without calling the registry, and agent actions are recorded in a **log** that the site owner can read.

The normative shapes are in [`knock.schema.json`](knock.schema.json). Maps are defined in [`map.md`](map.md).

## Roles

| Role | What it is |
| --- | --- |
| Site | A website with forms. Installs the site script and, for consequential submits, the server-side check. |
| Registry | Holds maps and site rules, issues tokens, keeps logs. Anyone can run one; a site names the one it trusts. |
| Agent | Software acting for a user. Has its own Ed25519 key pair and agent id. |
| User | The person the agent acts for. Only the user does `needs_user` actions. |

## 1. Discovery

A site that uses Usher publishes two things.

**`/.well-known/usher.json`** at the site's origin:

```json
{
  "usher": "0.1",
  "registry": "https://registry.example",
  "knock_url": "https://registry.example/knock",
  "keys_url": "https://registry.example/.well-known/usher-keys.json"
}
```

**A notice on every form**, added by the site script:

- `data-usher-knock="<knock_url>"` on the `<form>` element;
- `data-usher-state="locked"` on the `<form>` until a token is bound, then `"unlocked"`;
- inside the form, a visually hidden element with `role="note"` and `data-usher-note`, whose text says the form has an agent lane and gives the knock URL.

Nothing in the notice is visible to people using the page, and it does not change how the form behaves for them.

### Registering a site

A site registers its origin with its registry (`POST <registry>/sites` with `{"origin": "…"}`) and gets two keys, once:

- a **site key** (`usp_…`), which is public and goes in the script tag as `data-usher-site-key`, for drift reports;
- a **secret key** (`uss_…`), which the site keeps private and sends as `Authorization: Bearer <secret key>` to read its sessions and use its dashboard. The registry stores only a hash of it.

Proving control of the origin (DNS or a well-known file) is a later addition; until then registration is first come, first served.

## 2. Agent identity

An agent has an Ed25519 key pair. Its **agent id** is the [RFC 7638](https://www.rfc-editor.org/rfc/rfc7638) JWK thumbprint of its public key: base64url of the SHA-256 of `{"crv":"Ed25519","kty":"OKP","x":"…"}`. The id therefore certifies the key, and a registry can accept a new agent without prior registration.

### Signed requests

Knocks and other agent writes (submitting a map, reporting a run) are **signed requests**: a JSON object with these members plus the request's own fields.

| Member | Meaning |
| --- | --- |
| `agent.id` | The agent id |
| `agent.jwk` | The agent's public JWK. Required the first time an agent uses a registry; optional after |
| `ts` | Time of signing, RFC 3339 UTC |
| `signature` | base64url Ed25519 signature |

The signature covers the UTF-8 bytes of `usher-sig-v1` and a newline, followed by the **canonical JSON** of the whole object without `signature`: object members sorted by key (code-unit order), no insignificant whitespace, strings and numbers as `JSON.stringify` writes them. Canonical JSON makes the signature independent of transport, so the same request can travel over HTTP or as an MCP tool call.

A registry rejects a signed request when the signature does not verify, when `agent.jwk` is present and its thumbprint is not `agent.id`, when it has never seen the agent and `agent.jwk` is missing, or when `ts` is more than 5 minutes from its clock.

This scheme is deliberately small. It can be replaced by HTTP Message Signatures ([RFC 9421](https://www.rfc-editor.org/rfc/rfc9421)) with Web Bot Auth key directories without changing anything else in the protocol: only how the registry learns `agent.id` changes.

## 3. Knock

`POST <knock_url>` with `Content-Type: application/json` and a signed request:

| Member | Required | Meaning |
| --- | --- | --- |
| `usher` | yes | `"0.1"` |
| `url` | yes | The page the agent is on: origin and path. No query string or fragment |
| `intent` | no | What the agent is trying to do, e.g. `quote.car_insurance`. Defaults to the map's intent |
| `fingerprint` | no | The page's `usher-fp-1` fingerprint ([map.md](map.md)), computed by the agent from the live page. Used to find the map |
| `session` | no | A session id from an earlier knock, to continue a multi-step journey in one log |
| `confirmed` | no | Keys the agent states its user has just confirmed (e.g. `["form.submit"]`), when knocking right before acting on them. This is where the site's [policy](policy.md) refuses forbidden actions and counts rate limits |
| `agent`, `ts`, `signature` | yes | As above |

The registry then:

1. verifies the signed request;
2. finds the map, among the maps for the page's origin: an **exact** match on `fingerprint.digest`; otherwise the **near** match with the highest signature similarity at or above the registry's threshold (0.3 by default), preferring the same path; otherwise the best-scoring map for the same **path** (also used when the knock has no fingerprint). Every lookup and its scores are logged;
3. applies the site's rules for the form. If the site does not allow agents, it answers `403 {"error":"agents_not_allowed"}`;
4. creates a session (or continues `session`) and records the knock in its log;
5. signs a token.

### Response

`200 OK`:

```json
{
  "usher": "0.1",
  "session": "s_6c1f…",
  "token": "eyJhbGciOiJFZERTQSIs…",
  "expires_at": "2026-10-27T10:10:00Z",
  "keys_url": "https://registry.example/.well-known/usher-keys.json",
  "events_url": "https://registry.example/sessions/s_6c1f…/events",
  "match": { "kind": "exact", "score": 1, "digest": "sha256:13c4…", "drifted": false },
  "map": { "usher": "0.1", "…": "…" },
  "plan": null,
  "rules": { "agents": "allowed", "confirm": ["consequential"], "human_only": ["needs_user"] }
}
```

- `match.kind` is `exact`, `near`, `path` or `none`; `score` is the signature similarity (1 for exact; 0 without a fingerprint). A `path` match is the map for this path whose structure no longer matches well: treat it as a hint, not a plan. `map` is `null` when nothing matched; the agent then reads the page as it would without Usher.
- `drifted` is true when the site script has reported that the live page no longer matches this map.
- `plan` is reserved for multi-step plans (a later spec).
- `rules`: from the site's [policy](policy.md) for this form. `actions` gives the effective rule (`allow`, `confirm` or `forbid`) for every key on the form, the policy raised to the floor each element's risk sets; `confirm` and `human_only` restate the risk-level defaults.

Errors use `{"error": "<code>", "message": "…"}`: `400 invalid_request`, `401 bad_signature`, `401 unknown_agent`, `401 stale_request`, `403 agents_not_allowed`, `403 agent_blocked`, `403 action_forbidden`, `429 rate_limited`.

## 4. Token

A token is three base64url segments, `header.payload.signature`, signed by the registry with Ed25519 (a compact JWS).

Header: `{"alg":"EdDSA","typ":"usher+jwt","kid":"<key id>"}`.

| Claim | Meaning |
| --- | --- |
| `iss` | Registry URL |
| `kid` | Signing key id, the same as the header's |
| `sub` | Agent id |
| `origin` | The site origin the token is for (its audience) |
| `intent` | The intent the token allows |
| `map` | Digest of the matched map, or `null` |
| `sid` | Session id, so the site script can log to the right session |
| `iat`, `exp` | Issued and expiry times, seconds since the epoch. Tokens live 10 minutes |
| `jti` | Unique token id |
| `confirm`, `forbid` | Keys on the form that need the user's confirmation, and keys agents may not act on (from the policy) |
| `confirmed` | Keys the agent stated its user confirmed, when it knocked |

The registry publishes its public keys at `/.well-known/usher-keys.json` as a JWK set: `{"keys":[{"kty":"OKP","crv":"Ed25519","x":"…","kid":"…","alg":"EdDSA","use":"sig"}]}`. Sites cache it and verify tokens offline; they refetch only when they meet an unknown `kid`. Old keys stay published until every token they signed has expired.

A verifier accepts a token only when the signature verifies with the key named by `kid`, `iss` is a registry it trusts, `exp` has not passed and `iat` is not in the future (allowing 60 seconds of clock skew), `origin` is its own origin, and `intent` is the intent it protects. A server also keeps the `jti`s it has accepted until they expire and refuses a `jti` it has seen: a token is good for one consequential submit.

## 5. Binding a token in the page

The agent hands the token to the site script in the page, in either of two ways:

- `await window.usher.bind(token)`, which resolves to `{ ok: true, session }` or `{ ok: false, error }`;
- `window.postMessage({ type: "usher:bind", token }, location.origin)`, answered with a `{ type: "usher:bound", ok, error? }` message.

The script verifies the token as above against the cached keys (signature, issuer, expiry, origin; and intent when it knows the form's map). Once bound, for that page:

- the form is unlocked: `data-usher-state="unlocked"`;
- the site's rules apply: a submit that is `consequential` is held (`data-usher-state="awaiting_confirmation"`) until the agent calls `window.usher.confirm(key?)` after asking its user (an agent may confirm before it clicks, naming the action's key);
- agent actions are logged to the session (below);
- on submit, the script adds the token to the form as a hidden `usher_token` field, so the site's server can check it on an ordinary form post.

A binding lasts for one page load. On a multi-step form the agent knocks on each page, passing `session`, and binds the new token.

## 6. The log

The site script and the agent append events to the session with `POST <events_url>`, sending the session's token as `Authorization: Usher <token>`:

```json
{ "events": [{ "ts": "2026-10-27T10:01:12Z", "source": "site", "action": "fill", "key": "person.first_name", "element": "e2", "path": "/quote/driver" }] }
```

`action` is one of `knock`, `fill`, `select`, `choose`, `check`, `uncheck`, `click`, `submit`, `held`, `confirm`, `handoff`, `run`. `key` is the element's semantic key from the map. **Events never carry values**: not what was typed, not which option was chosen. The site script logs nothing for page loads without a bound token, so people using the site are never logged.

The script also checks the live form against the registry's map, without telling the registry about the visit: it fetches the current map digest for the page (`GET <registry>/maps/current?origin=…&path=…`, no cookies) at most once an hour per browser, compares it with the live form's fingerprint locally, and only on a mismatch sends a **drift report** (`POST /drift` with the site key in `Usher-Site-Key`, the map digest, the live fingerprint and the score), once per change. Drift reports carry structure only; the registry keeps nothing about the visitor (no IP address, no user agent) and rate-limits them per site key.

Reading a session (`GET <registry>/sessions/<id>`) needs the site's secret key, is limited to the site's own sessions, and is rate-limited.

## 7. Server-side check

The script is a convenience; the server is the lock. On a consequential endpoint (requesting a quote, placing an order, an API that does the same), the site's server looks for a token in `Authorization: Usher <token>`, then `X-Usher-Token`, then the `usher_token` form field, and verifies it as in section 4. A check that knows the key it protects (say `form.submit`) also refuses it when the token lists it as forbidden or as needing confirmation it did not get (`reason: action_forbidden`, `confirmation_required`), and applies the key's default risk from the vocabulary as a floor, so a token from a knock on an unmapped page can't skip confirmation.

The server checks requests that identify as automated: any request carrying a token or an `Usher-Agent` header, and every request to endpoints meant for software, such as an API. When the check fails it answers:

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json
Link: <https://registry.example/knock>; rel="usher-knock"

{ "error": "knock_required", "knock_url": "https://registry.example/knock", "origin": "https://quote.example", "intent": "quote.car_insurance" }
```

A `reason` member (`missing`, `expired`, `wrong_origin`, `replayed`, …) may be added to help agents recover.

## What the protocol does not do

- **It does not detect agents that don't knock.** An automated browser that never knocks and never identifies itself looks like a person to the site. Usher gives well-behaved agents a faster, trusted path; it is not bot detection.
- **It does not change anything for people.** People see the same form, nothing they do is logged, and the server check only applies to requests that identify as automated or use endpoints meant for software.
- **It never carries values.** Maps, rules, tokens and logs hold structure and semantic keys, never what anyone typed.
- **The in-page lock is advisory.** The site script can hold a submit and log actions, but anything running in the page could ignore it. The server-side check is what enforces.
- **It does not replace the site's own security**: sessions, CSRF protection, rate limits and fraud checks still apply.
