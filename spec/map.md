# Usher map, draft 0.1

A **map** describes one state of one web form: what its fields mean, how to find them, and which actions matter. Agents use a map instead of reading the raw page.

A **plan** (separate spec, to follow) is a journey through several maps, joined by the actions that move between them.

## Principles

1. **Structure, never values.** A map never holds anything a person typed, and never holds page content beyond field labels and option lists. It is safe to share openly.
2. **The model labels, the code locates.** Element records and locators are produced by deterministic code (the extractor). A model only adds meaning: semantic keys, risk, conditions. A model never writes a selector.
3. **Several locators per element.** Pages change. Each element carries locators in priority order, so a renamed `id` still resolves by label or role.
4. **Risk is explicit.** Every field and action says whether an agent may act on it freely, whether it is consequential, or whether a human must do it.
5. **Fail safe.** If a map doesn't match the page, the agent reads the page as it would have anyway.

## Which form a map is for

A page may hold several forms. A map is for the one a person with the agent's intent came to fill in:

- **Never a cookie or consent widget, a site search or a newsletter box**, unless the intent asks for one (`search.query`, say). Code marks these when it extracts the page: a consent container or cookie-labelled fields; `role="search"`, a `<search>` element, or a small form that says search; a form of up to three fields with an email address that says newsletter or subscribe. With no intent at all, a search or newsletter box is still mapped when it is all the page has; a consent widget never is.
- **Between the forms that remain**, the compiler sends a model one line per form, written by code (a guess at its purpose from its fields' likely keys, its fields and buttons), with the intent, and the model names one. The model never sees the markup.
- **Everyone else finds it by fingerprint.** The page's script, agents and the keeper fingerprint each remaining form and use the one whose fingerprint has a map, so they need no model to agree with the compiler.

When nothing remains, there is no map: the page has no form for that intent.

## Document shape

```json
{
  "usher": "0.1",
  "origin": "https://quote.example",
  "path": "/quote/driver",
  "fingerprint": { "algo": "usher-fp-1", "digest": "sha256:…", "signature": ["…"] },
  "form": { "purpose": "Car insurance quote: driver details", "intent": "quote.car_insurance", "step": 1 },
  "groups": [ … ],
  "fields": [ … ],
  "actions": [ … ],
  "provenance": { "source": "compiled", "compiler": "muse-spark", "created_at": "2026-10-27T10:00:00Z", "verified": false }
}
```

The full, normative definition is [`map.schema.json`](map.schema.json). An annotated example is [`examples/quote-driver.map.json`](examples/quote-driver.map.json).

### Top level

| Property | Required | Meaning |
| --- | --- | --- |
| `usher` | yes | Spec version, `"0.1"` |
| `origin` | yes | Scheme, host and port of the page |
| `path` | yes | Path pattern. `:param` marks a variable segment, e.g. `/quote/:session/driver` |
| `fingerprint` | yes | Structural identity of the form (below) |
| `form` | yes | What the form is for |
| `groups` | no | Visible sections (fieldsets, headed blocks) |
| `fields` | yes | Inputs, selects, radio groups, checkboxes, text areas |
| `actions` | yes | Buttons and links that act on the form or move the journey |
| `provenance` | yes | Who produced the map and whether it is verified |

### Fingerprint

Identifies the form by its structure, not its URL, so A/B variants and minor redesigns still match.

- `algo`: fingerprint algorithm, `usher-fp-1` in this draft.
- `signature`: one short hash per field and action, in document order. Each hash covers the control type, the normalised label text and the required flag. It never covers values, ids or CSS classes.
- `digest`: a hash of the whole signature list, for exact lookups.

Lookups match on `digest` first, then on signature similarity (a Jaccard score over the `signature` sets). The threshold is set by the registry.

### Fields

| Property | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Element id assigned by the extractor (`e1`, `e2`, …), stable within this map only |
| `key` | yes | Semantic key from the [vocabulary](vocabulary.md), or `custom.<slug>` |
| `label` | yes | The visible label, normalised whitespace |
| `control` | yes | `text`, `email`, `tel`, `number`, `date`, `select`, `radio`, `checkbox`, `textarea`, `file`, `password` |
| `required` | yes | Whether the form requires it |
| `risk` | yes | `safe`, `consequential` or `needs_user` (below) |
| `sensitive` | no | `true` for payment details, passwords, government ids and medical answers. A plan never carries their values; an agent fills a medical answer only where the site's rules permit it, with the person's own answer, confirmed by them |
| `constraints` | no | `pattern`, `min`, `max`, `min_length`, `max_length`, `format` |
| `options` | for select/radio | `items` (value and label), `total`, `truncated` |
| `group` | no | Id of the containing group |
| `part` | no | `day`, `month` or `year`: one part of a date split across fields (see below) |
| `shown_if` | no | A condition; the field is only present when it holds |
| `locators` | yes | At least one locator, in priority order |
| `box` | no | Where the element sat on the page when it was mapped (below) |

### Actions

| Property | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Element id |
| `key` | yes | Semantic key, e.g. `nav.next`, `form.submit`, `lookup.address` |
| `label` | yes | Visible text or accessible name |
| `kind` | yes | `submit`, `button` or `link` |
| `risk` | yes | `safe`, `consequential` or `needs_user` |
| `locators` | yes | At least one locator |
| `leads_to` | no | Path of the map this action moves to, once known (an **edge**) |
| `box` | no | Where the element sat on the page when it was mapped (below) |

### Box

`box` is `{ "x", "y", "width", "height" }` in CSS pixels from the top left of the whole page (not the viewport), at the 1280-wide viewport Usher maps with. It is position and size only, never content. A walkthrough ([docs/walkthrough.md](../docs/walkthrough.md)) records it to draw the annotated screenshot an owner reviews; the maps agents are served leave it out. Agents locate elements by `locators`, never by box.

### Risk

| Value | Meaning | Agent behaviour |
| --- | --- | --- |
| `safe` | Reversible, no effect outside the session (typing in a field, moving to the next step) | Act freely |
| `consequential` | Has an effect the user should know about (requesting a quote, sending a message, creating a booking) | Act only if the user's instruction covers it and the site's rules allow it |
| `needs_user` | Commits the user legally or financially, or needs their own judgement (declarations, consent, payment, passwords) | Never act; hand to the user |

Site rules (policy format, to follow) can make an action stricter than its map says, never looser.

### Locators

Each locator is `{ "by": …, "value": …, "name"?: … }`:

| `by` | `value` |
| --- | --- |
| `id` | Element `id` attribute |
| `name` | Element `name` attribute |
| `label` | Visible label text |
| `role` | ARIA role, with the accessible name in `name` |
| `placeholder` | Placeholder text |
| `css` | A CSS selector generated by the extractor; last resort |

A runtime tries locators in order and uses the first that resolves to exactly one element.

### Split dates

Many forms ask for a date as separate day, month and year boxes or selects. Each becomes a field with a `part`, and the parts of one date share one key and one group. The value is still the whole date, YYYY-MM-DD ([vocabulary](vocabulary.md#values)); an agent fills each part from it.

```json
{ "id": "e5", "key": "person.dob", "label": "Day of birth", "control": "text", "required": true, "risk": "safe",
  "part": "day", "group": "g2", "constraints": { "pattern": "[0-9]*", "max_length": 2 }, "locators": [{ "by": "id", "value": "DayOfBirth" }] },
{ "id": "e6", "key": "person.dob", "label": "Month of birth", "control": "text", "required": true, "risk": "safe",
  "part": "month", "group": "g2", "locators": [{ "by": "id", "value": "MonthOfBirth" }] },
{ "id": "e7", "key": "person.dob", "label": "Year of birth", "control": "text", "required": true, "risk": "safe",
  "part": "year", "group": "g2", "locators": [{ "by": "id", "value": "YearOfBirth" }] }
```

**How parts are found.** The extractor reads each part from the field's own words:
- an `autocomplete` of `bday-day`, `bday-month` or `bday-year`;
- a name or id such as `DayOfBirth`, `dob-day` or `dob[day]`;
- a label starting "Day", "Month" or "Year";
- a placeholder of `DD`, `MM` or `YYYY`.

It sets `part` only where a group holds two or more different parts, so a lone "Year of manufacture" stays a field of its own.

**Validation.** Labels may give parts one key only within one group, each part once. A date shown as text in the site's own format (DD/MM/YYYY and the like, from the field's placeholder, its label or its pattern) is an ordinary field: the agent writes the value in that format.

**Lookup results.** A lookup that shows a list of results (the addresses on a postcode, say) adds a select or radio group to the page only after it runs. Maps describe the page as it loads, so that list isn't a field in the map. The lookup is an action (`lookup.address`), and an agent picks from the list when it appears; see [plan.md](plan.md) on lookups.

### Conditions

`shown_if` is `{ "field": <key>, "op": <op>, "value"?: <value> }`, where `op` is `equals`, `not_equals`, `in`, `checked` or `filled`. The `value` is an option value from the map, never user data.

### Provenance

| Property | Meaning |
| --- | --- |
| `source` | `compiled` (built by a compiler), `site` (published by the site's own script) or `agent` (recorded from an agent's run) |
| `compiler` | Model or tool that compiled it |
| `created_at` | ISO 8601 timestamp |
| `verified` | `true` once enough independent runs succeed, or when `source` is `site` |
