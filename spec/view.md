# Usher result view, draft 0.1

A **result view** describes the page at the end of a journey: what it shows that a person wants to keep once they have their quote or have sent their form. The quote reference, the price and what it is for, the amount covered, a date, and links to the documents (a policy summary, the terms, key facts). Assistants use it to show those things to the person, in their own words from the site, instead of guessing at the page.

Like a map, it holds **where things are, never what they say**. It never holds a reference, a price or anyone's details: those belong to the person whose result it is, and are read from their own page, by code, when they get there.

## Who makes one

The walkthrough ("Map my site", [walkthrough](../docs/walkthrough.md)) makes one when the person who started it allowed it to press the final step. It reaches the result page with its test values; a model labels what the page shows, and code locates it, as for a map. It is kept with the journey's maps when the owner publishes them.

A view is never built from a real person's result: their page is read only with a view that already exists.

## Document shape

```json
{
  "usher_view": "0.1",
  "origin": "https://lifeinsurance.lv.com",
  "path": "/your-quick-quote",
  "title": "Quick quote results",
  "items": [
    { "id": "r1", "key": "result.price", "label": "You pay each month", "kind": "fact", "anchor": "You pay each month:", "locators": [{ "by": "css", "value": "main > div:nth-of-type(2) > p" }] },
    { "id": "r2", "key": "result.amount", "label": "Life insurance cover only", "kind": "fact", "anchor": "Life Insurance cover only:", "locators": [] },
    { "id": "r3", "key": "result.document", "label": "Policy summary", "kind": "link", "locators": [{ "by": "role", "value": "link", "name": "Policy summary" }] }
  ],
  "provenance": { "source": "walkthrough", "model": "muse-spark-1.3", "created_at": "2026-10-29T12:30:00Z" }
}
```

| Item field | What |
| --- | --- |
| `key` | `result.reference`, `result.price`, `result.amount` (what is covered or paid out), `result.term`, `result.date` (valid until, starts on), `result.document`, `result.next_step` |
| `label` | What the site calls it, as a person would read it |
| `kind` | `fact` (text to show) or `link` (a document or next step to offer) |
| `anchor` | For a fact: the page's words just before the value. A runtime finds them, then reads the text that follows |
| `locators` | Where the value or link is, by CSS path or by role and name; the anchor is tried first |

## Reading one

At the end of a person's own journey, on a page with a view, a runtime reads each item from that page: a fact's text after its anchor (or at its locator), a link's address and caption. It shows them to the person, word for word, and keeps none of them. An item it can't find is left out; nothing is guessed.
