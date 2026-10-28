# Usher plan, draft 0.1

A **plan** is a journey through several forms: the [maps](map.md) of each step joined by the actions that move between them (`leads_to`), with everything the journey will ask for gathered as **inputs**. An agent gets a plan before it starts, checks its user's data against the inputs, asks for anything missing or wrong, and only then opens the first page.

The normative shape is [`plan.schema.json`](plan.schema.json).

## Document

```json
{
  "usher_plan": "0.1",
  "origin": "https://quote.example",
  "intent": "quote.car_insurance",
  "start": "/quote/driver",
  "steps": [
    { "path": "/quote/driver", "map": "sha256:…", "purpose": "Car insurance quote: driver details",
      "advance": { "id": "e14", "key": "nav.next", "label": "Continue", "risk": "safe" }, "leads_to": "/quote/vehicle" }
  ],
  "inputs": [
    { "key": "person.dob", "label": "Date of birth", "control": "date", "required": true, "risk": "safe",
      "constraints": { "format": "date" }, "steps": ["/quote/driver"] },
    { "key": "person.occupation", "label": "Occupation", "control": "select", "required": true, "risk": "safe",
      "options": { "items": [{ "value": "accountant", "label": "Accountant" }], "total": 173, "truncated": true }, "steps": ["/quote/driver"] }
  ],
  "consequential": [{ "path": "/quote/cover", "key": "form.submit", "label": "Get my quote", "risk": "consequential" }],
  "complete": true,
  "stops_at": null
}
```

| Member | Meaning |
| --- | --- |
| `start` | The first step's path |
| `steps` | In order: each step's map digest, purpose, the action that moves on (`advance`) and where it leads |
| `inputs` | One per semantic key across the journey: label, control, whether it is required (on any step, when its `shown_if` holds), risk, constraints and options (first 20, total, truncated) as in the maps, and which steps ask for it |
| `consequential` | Actions on the way that need the user's confirmation or are theirs alone |
| `lookups` | Lookup actions on the way (`lookup.vehicle`, `lookup.address`). An agent runs one before filling the fields it fills (make, model and year from a registration; address lines from a postcode), and fills those only if the lookup left them empty. So those fields are optional in the user's data when the lookup's own input (`vehicle.registration`, `address.postcode`) is given |
| `complete` | `true` when the chain reaches a page with no form (the journey's result); `false` when it stops at a step whose way forward isn't known yet |
| `stops_at` | Where an incomplete chain stops |

## Getting a plan

`GET <registry>/plans?url=<first page>` (or the MCP tool `get_plan`) composes a plan from the registry's current maps for the origin, following `leads_to` from that page. Plans are composed on request, so they follow the maps as they change.

## Checking data before starting

For each input, an agent checks its user's value: present if required (and its condition holds), one of the options by value or by label, and within `pattern`, `min`, `max`, `min_length`, `max_length` and `format`. A truncated option list can't rule a value out. Problems are reported by key before any page is touched. Inputs whose risk is `needs_user` are the user's to answer on the page.

## When a step is rejected anyway

If a site still rejects a step, an agent reads the page's own error signals (an error summary's links, `aria-invalid` with `aria-describedby` or `aria-errormessage`, and inline error messages) and maps them to keys with the map's locators, giving `{ key, message }` pairs. The site script logs an `invalid` event per key (never the message, which may repeat what was typed) for sessions with a bound token.
