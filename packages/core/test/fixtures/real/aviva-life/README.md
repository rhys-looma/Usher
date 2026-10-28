# Aviva life insurance quote: the first page, structure only

Captured on 28 October 2026 from www.direct.aviva.co.uk (life insurance, "Personal Details") in Chrome. The page was opened and the extractor ran read-only (the same in-page code as `scanScript()`); nothing was typed, chosen or submitted.

**What's kept:** fields, labels, options, groups, actions and locators, with element boxes, CSS paths and the cookie banner's form left out. The extractor never reads an input's value.

| File | What |
| --- | --- |
| `01-personal-details.json` | The capture: 37 elements in one form |
| `01-personal-details.labels.json` | Muse Spark's labels for the page rebuilt from the capture (`node --import tsx packages/core/scripts/record-real.ts aviva-life/01-personal-details.json`) |
| `01-personal-details.map.json` | The map those labels give |

`packages/core/test/aviva-life.test.ts` rebuilds the page at its own address (every request answered locally, nothing sent to Aviva), checks it extracts exactly as the real page did, and compiles it from the recording.

## What the page shows

- **Dates:** the date of birth is split into day, month and year boxes under one group (`person.dob` with parts).
- **Smoking** is one question with three answers ("I've never smoked", "Regularly, occasionally or socially", "I have in the past"), not yes or no. A plain "no" matches none of them, so the person is asked, or the model picks from the labels.
- **Lookup:** "Find my address" from the postcode (`lookup.address`).
- **The way forward** is a link, "See your quote", and nothing is marked required in the markup: the site validates on its server.
- **No vocabulary key yet** for life cover's own questions: "Your cover" (family or mortgage protection) and "Do you want to add critical illness cover?" come back as `custom.*`.
- **Marketing preferences** are hidden behind a "Show" button and left out of the map.
- Cover amount and term are not on this page.
