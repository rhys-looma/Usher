# Aviva life insurance quote: the first page, structure only

Captured on 28 October 2026 from www.direct.aviva.co.uk (life insurance, "Personal Details") in Chrome, with the extractor run in the page (the same in-page code as `scanScript()`). First as it loads; then after clicking through every option of its choice questions, which open more of the form. Nothing was typed and "See your quote" was never pressed.

**What's kept:** fields, labels, options, groups, actions and locators, with element boxes, CSS paths and the cookie banner's form left out. The extractor never reads an input's value.

| File | What |
| --- | --- |
| `01-personal-details.json` | As it loads: 37 elements in one form |
| `02-family-joint-ci-ex-smoker.json` | Family protection, me and someone else, one joint policy, critical illness, "I have in the past": 63 elements |
| `03-mortgage-joint-ci-ex-smoker.json` | The same with mortgage protection: 60 elements |
| `*.labels.json`, `01-personal-details.map.json` | Muse Spark's labels for each (recorded with `scripts/record-real.ts`), and the first page's map |

`packages/core/test/aviva-life.test.ts` rebuilds the page at its own address (every request answered locally, nothing sent to Aviva), checks it extracts exactly as the real page did, and compiles it from the recording.

## What the answers open

| Answer | What appears |
| --- | --- |
| Your cover: Family protection | A sum assured (£), "How much money would you need to leave for your family?" (£100,000 to £300,000), inflation protection (optional), and the term (5 to 50 years, a select whose "Select your policy term length" placeholder has the value 0) |
| Your cover: Mortgage protection | A mortgage amount (£) and the mortgage term instead |
| Me and someone else | "Choose your policy type" (one joint policy or two individual policies) and the second person: name, split date of birth, smoking ("They've never smoked" …), email, phone, "Use the same address details as above" and their own postcode and "Find their address" |
| Critical illness: Yes | A critical illness amount (£) and "How much critical illness cover do you need?" (£25,000 to £70,000) |
| Smoking: I have in the past | When: within 12 months, more than 12 months, 3 years or 5 years ago |

## What the page shows

- **Dates:** the date of birth is split into day, month and year boxes under one group (`person.dob` with parts).
- **Smoking** is one question with three answers ("I've never smoked", "Regularly, occasionally or socially", "I have in the past"), not yes or no. A plain "no" matches none of them, so the person is asked, or the model picks from the labels.
- **Lookup:** "Find my address" from the postcode (`lookup.address`).
- **The way forward** is a link, "See your quote", and nothing is marked required in the markup: the site validates on its server.
- **No vocabulary key yet** for life cover's own questions (the cover type, amounts, term, inflation, critical illness) or for a second person, so they come back as `custom.*`, and not the same ones from one state to the next (the second person's date of birth is one key in one state and three in the other).
- **One group label is wrong:** the extractor names "Me / Me and someone else" by the nearest heading above it, which once the term question has appeared is "How long do you need cover for?".
- **Marketing preferences** are hidden behind a "Show" button and left out of the map.
