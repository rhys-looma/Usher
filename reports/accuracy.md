# Accuracy

Generated 2026-10-26 by `packages/core/scripts/accuracy.ts` (forms: recorded, live within $0.1).

## Method

- Each page is loaded in headless Chromium at 1280px and its main form compiled exactly as the registry does: extraction, locators, fingerprint, Muse Spark labels, validation, merge. Nothing is submitted.
- Model responses come from recorded fixtures (mock site) or the compiler log (public forms compiled before); a page that changed since then has no recorded response and is skipped unless the run is `--live`.
- **Locators resolve**: every locator of the element finds exactly one element, and they all agree, on the live page.
- **Keys** and **risk** on the mock site are marked automatically against the hand-checked list; on public forms they are marked by hand in `reports/accuracy-review.csv` and scored with `npm run accuracy:score`.
- The open-weights classifier (Muse Spark Open) adds a second opinion on risk where recorded or run live; disagreements keep the stricter risk and are flagged.

## Summary

- Forms compiled: 12 of 12 (0 skipped).
- Elements: 100; locators resolving: 100%; vocabulary keys (not custom): 89%.
- Mock site, marked automatically: keys 100% correct, risk 95.6% correct (after the classifier's stricter-wins).

## Per form

| Form | Category | Source | Elements | Keys (vocabulary / custom) | Risk (safe / consequential / needs user) | Locators resolve | Classifier flags | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mock-a-driver | mock site | recorded | 14 | 14 / 0 | 14 / 0 / 0 | 100% | 0 | Car insurance quote: driver details |
| mock-a-vehicle | mock site | recorded | 11 | 11 / 0 | 11 / 0 / 0 | 100% | 0 | Car insurance quote: vehicle details |
| mock-a-cover | mock site | recorded | 9 | 9 / 0 | 6 / 1 / 2 | 100% | 0 | Car insurance quote: cover details |
| mock-b-driver | mock site | recorded | 14 | 14 / 0 | 11 / 0 / 3 | 100% | 3 | Car insurance quote: driver details |
| mock-b-vehicle | mock site | recorded | 11 | 11 / 0 | 11 / 0 / 0 | 100% | 0 | Car insurance quote: vehicle details |
| mock-b-cover | mock site | recorded | 9 | 9 / 0 | 6 / 1 / 2 | 100% | 0 | Car insurance quote: cover options |
| govuk-contact | contact | recorded | 7 | 4 / 3 | 6 / 1 / 0 | 100% | 0 | Contact GOV.UK team with a question or feedback |
| travelodge-booking | booking | recorded | 6 | 5 / 1 | 5 / 1 / 0 | 100% | 0 | Hotel search by destination, dates and guests |
| httpbin-order | booking | recorded | 11 | 5 / 6 | 10 / 1 / 0 | 100% | 0 | Pizza order form |
| mozilla-newsletter | newsletter | recorded | 2 | 2 / 0 | 1 / 1 / 0 | 100% | 0 | Firefox news newsletter signup |
| wikipedia-search | search | live | 2 | 1 / 1 | 2 / 0 / 0 | 100% | 0 | Search Wikipedia articles |
| aviva-car | insurance first step | live | 4 | 4 / 0 | 3 / 1 / 0 | 100% | 0 | Car insurance quote by car registration |
