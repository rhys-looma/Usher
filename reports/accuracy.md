# Accuracy

Generated 2026-10-27 by `packages/core/scripts/accuracy.ts` (forms: all, live within $1).

## Method

- Each page is loaded in headless Chromium at 1280px and its main form compiled exactly as the registry does: extraction, locators, fingerprint, Muse Spark labels, validation, merge. Nothing is submitted.
- Model responses come from recorded fixtures (mock site) or the compiler log (public forms compiled before); a page that changed since then has no recorded response and is skipped unless the run is `--live`.
- **Locators resolve**: every locator of the element finds exactly one element, and they all agree, on the live page.
- **Keys** and **risk** on the mock site are marked automatically: whether each matches the mock site's answer key (`packages/core/test/fixtures/expected-keys.json`). On public forms they are human-checked in `reports/accuracy-review.csv`. `npm run accuracy:score` scores both, separately.
- The open-weights classifier (Muse Spark Open) adds a second opinion on risk where recorded or run live; disagreements keep the stricter risk and are flagged.
- Pages that could not be loaded at all (they refuse automated browsers, or no longer exist) are left out.

## Summary

- Forms compiled: 19 of 28 (9 skipped: no form to map, or labels that failed validation).
- Elements: 119; locators resolving: 99.2%; vocabulary keys (not custom): 89.9%.
- Mock site, matches the mock site's answer key: keys 100% correct, risk 100% correct (after the classifier's stricter-wins).

## Per form

The Brightwater Health rows (mock-*-health-*) were added on 28 October from the recorded Muse Spark labels, after this run: every locator resolves on both layouts, `person.smoker` is labelled needs_user and the declaration a consent. They are in `accuracy-review.csv` with the human columns blank, under the mock site, so the human-checked public-form figures are unchanged.

| Form | Category | Source | Elements | Keys (vocabulary / custom) | Risk (safe / consequential / needs user) | Locators resolve | Classifier flags | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mock-a-driver | mock site | recorded | 14 | 14 / 0 | 14 / 0 / 0 | 100% | 0 | Car insurance quote: driver details |
| mock-a-vehicle | mock site | recorded | 11 | 11 / 0 | 11 / 0 / 0 | 100% | 0 | Car insurance quote: vehicle details |
| mock-a-cover | mock site | recorded | 9 | 9 / 0 | 6 / 1 / 2 | 100% | 0 | Car insurance quote: cover details |
| mock-b-driver | mock site | recorded | 14 | 14 / 0 | 14 / 0 / 0 | 100% | 0 | Car insurance quote: driver details |
| mock-b-vehicle | mock site | recorded | 11 | 11 / 0 | 11 / 0 / 0 | 100% | 0 | Car insurance quote: vehicle details |
| mock-b-cover | mock site | recorded | 9 | 9 / 0 | 6 / 1 / 2 | 100% | 0 | Motor insurance quote: cover options |
| mock-a-health-about | mock site | recorded | 13 | 13 / 0 | 12 / 0 / 1 | 100% | – | Health insurance quote: about you |
| mock-a-health-cover | mock site | recorded | 8 | 8 / 0 | 8 / 0 / 0 | 100% | – | Health insurance quote: cover options |
| mock-a-health-declaration | mock site | recorded | 3 | 3 / 0 | 1 / 1 / 1 | 100% | – | Health insurance quote declaration and consent |
| mock-b-health-about | mock site | recorded | 13 | 13 / 0 | 12 / 0 / 1 | 100% | – | Health insurance quote: your details |
| mock-b-health-cover | mock site | recorded | 8 | 8 / 0 | 8 / 0 / 0 | 100% | – | Health insurance: choose your cover options |
| mock-b-health-declaration | mock site | recorded | 3 | 3 / 0 | 1 / 1 / 1 | 100% | – | Health insurance quote declaration and confirmation |
| govuk-contact | contact | recorded | 7 | 4 / 3 | 6 / 1 / 0 | 100% | 0 | Contact GOV.UK team with question or feedback |
| ico-contact | contact | recorded | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Site search: find ICO information |
| ofcom-contact | contact | – | – | – | – | – | – | skipped: No form to map on https://www.ofcom.org.uk/about-ofcom/what-we-do/contact-us: the page has only a site search, a cookie or consent widget. |
| travelodge-booking | booking | recorded | 6 | 5 / 1 | 6 / 0 / 0 | 100% | 0 | Hotel search: destination, dates, rooms and guests |
| httpbin-order | booking | recorded | 11 | 5 / 6 | 10 / 1 / 0 | 100% | 0 | Pizza order: customer, size, toppings and delivery |
| nationalrail-journey | booking | recorded | 4 | 2 / 2 | 4 / 0 / 0 | 100% | 0 | Plan train journey between stations |
| eventbrite-search | booking | recorded | 3 | 3 / 0 | 3 / 0 / 0 | 100% | 0 | Search for local events by keyword and location |
| mozilla-newsletter | newsletter | recorded | 2 | 2 / 0 | 1 / 1 / 0 | 100% | 0 | Get Firefox news newsletter signup |
| which-newsletter | newsletter | – | – | – | – | – | – | skipped: No form to map on https://www.which.co.uk/about-which/which-newsletters-akBCD7z3vgqS: the page has only a site search. |
| guardian-newsletters | newsletter | – | – | – | – | – | – | skipped: No form to map on https://www.theguardian.com/email-newsletters: the page has only a site search, a newsletter sign-up. |
| wikipedia-search | search | recorded | 2 | 2 / 0 | 2 / 0 / 0 | 50% | 0 | Search Wikipedia articles |
| govuk-search | search | live | 4 | 4 / 0 | 4 / 0 / 0 | 100% | 0 | Search all content on GOV.UK |
| ons-search | search | recorded | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Search ONS data by keyword or time series ID |
| nhs-search | search | recorded | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Search the NHS website |
| reddit-signup | account sign-up | – | – | – | – | – | – | skipped: No form to map on https://www.reddit.com/register/. |
| bbc-signup | account sign-up | recorded | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | BBC sign-in: enter email or username |
| aviva-car | insurance first step | recorded | 4 | 4 / 0 | 3 / 1 / 0 | 100% | 0 | Car insurance quote: start with registration |
| directline-car | insurance first step | – | – | – | – | – | – | skipped: No form to map on https://www.directline.com/car-cover. |
| admiral-car | insurance first step | – | – | – | – | – | – | skipped: No form to map on https://www.admiral.com/car-insurance: the page has only a cookie or consent widget. |
| churchill-car | insurance first step | – | – | – | – | – | – | skipped: No form to map on https://www.churchill.com/car-insurance. |
| barclays-loans | finance first step | – | – | – | – | – | – | skipped: No form to map on https://www.barclays.co.uk/loans/. |
| hl-isa | finance first step | – | – | – | – | – | – | skipped: No form to map on https://www.hl.co.uk/investment-services/isa: the page has only a site search. |
