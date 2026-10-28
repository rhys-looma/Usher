# Usher policy format, draft 0.1

A **policy** is a site's rules for agents on its forms: which forms have an agent lane, what agents may do on each, how often, which agents, and how long their logs are kept. It belongs to one origin and lives at the site's registry. Site owners can write it in plain English; the registry turns that into this format for them to confirm.

The normative shape is [`policy.schema.json`](policy.schema.json).

## Document

```json
{
  "usher_policy": "0.1",
  "origin": "https://quote.example",
  "default": {
    "agent_lane": true,
    "actions": { "form.submit": "confirm" },
    "rate_limits": [{ "action": "form.submit", "per": "agent", "max": 5, "window": "hour" }]
  },
  "forms": [
    { "match": { "path": "/quote/*" }, "actions": { "consent.marketing": "forbid" } },
    { "match": { "digest": "sha256:…" }, "agent_lane": false }
  ],
  "agents": { "allow": "*", "block": [] },
  "retention": { "session_days": 30 }
}
```

| Member | Meaning |
| --- | --- |
| `usher_policy` | `"0.1"` |
| `origin` | The site's origin |
| `default` | Rules for every form on the origin |
| `forms` | Rules for particular forms, matched by `path` (a pattern where `*` matches within one segment and `**` across segments) or by map `digest`. Later entries win over earlier ones and over `default` |
| `agents` | `allow`: `"*"` or a list of agent ids; `block`: agent ids refused everywhere; `hosted`: `"allow"` (the default) or `"block"` for every agent acting through a hosted Usher connection (a registry's `/mcp`), whose tokens carry `act: { "sub": "hosted" }` |
| `retention.session_days` | How long the registry keeps agent sessions (logs) for this origin |

### Rules (in `default` and each form)

| Member | Meaning |
| --- | --- |
| `agent_lane` | Whether agents may use the form at all. `false` refuses knocks for it |
| `actions` | Per semantic key (from the [vocabulary](vocabulary.md), fields or actions): `allow`, `confirm` (the agent must have its user's confirmation first) or `forbid` (agents may not do it; the user can) |
| `rate_limits` | Each `{ action, per, max, window }`: at most `max` uses of `action` per `agent` (each agent id) or per `origin` (all agents together) in a sliding `minute`, `hour` or `day`. `action` is a semantic key, counted when an agent knocks to perform it, or `"knock"` to count every knock |

## Stricter, never looser

Every element in a map has a risk, which sets a floor on its rule:

| Map risk | Floor |
| --- | --- |
| `safe` | `allow` |
| `consequential` | `confirm` |
| `needs_user` | `forbid` |

A policy can raise a rule above its floor (`allow` < `confirm` < `forbid`) but never lower it, with one exception that is the site's to make. A field that is the person's to answer may be permitted with `confirm` when it is what they say about their health (`health.*`) or whether they smoke (`person.smoker`, `partner.smoker` and their `*_stopped`): an agent then enters the person's own answer, as they gave it, and puts it back to them before anything is submitted. `allow` on such a field counts as `confirm`. Consents, passwords, card and bank details, and every action keep their floor. A validator refuses a policy that tries, for every map the registry holds for the forms it matches, and for keys with no map yet against the key's default risk in the vocabulary. When rules are applied, the floor wins anyway.

## How it is enforced

- **At knock.** A form without an agent lane, or an agent that is blocked or not allowed, is refused (`403 agents_not_allowed`, `403 agent_blocked`). The knock response's `rules.actions` lists the effective rule for every element of the matched map.
- **When the agent acts.** Before a `confirm` action, the agent asks its user and knocks again with `confirmed: ["<key>"]`, a statement signed by the agent that its user agreed. The registry refuses a `forbid` action (`403 action_forbidden`) and counts the action against its rate limits (`429 rate_limited`). The token then names the action as confirmed.
- **In the page.** The site script holds a `confirm` action until the agent calls `window.usher.confirm(key)`, and never lets an agent submit a `forbid` action.
- **On the server.** Tokens carry the form's `confirm` and `forbid` keys and what was `confirmed`. A server check protecting an action refuses it when it is forbidden (`reason: action_forbidden`) or needs confirmation the token does not record (`reason: confirmation_required`).

## Plain English

A site owner can write rules such as *"agents can fill in quotes, but a person confirms the submit, and at most five an hour"*. The registry turns the text into a policy with Muse Spark, validates it, and returns it for the owner to confirm; nothing applies until they do. The registry keeps the English alongside the policy so both can be shown.
