# Accuracy

Generated 2026-10-27 by `packages/core/scripts/accuracy.ts` (forms: all, live within $2).

## Method

- Each page is loaded in headless Chromium at 1280px and its main form compiled exactly as the registry does: extraction, locators, fingerprint, Muse Spark labels, validation, merge. Nothing is submitted.
- Model responses come from recorded fixtures (mock site) or the compiler log (public forms compiled before); a page that changed since then has no recorded response and is skipped unless the run is `--live`.
- **Locators resolve**: every locator of the element finds exactly one element, and they all agree, on the live page.
- **Keys** and **risk** on the mock site are marked automatically against the hand-checked list; on public forms they are marked by hand in `reports/accuracy-review.csv` and scored with `npm run accuracy:score`.
- The open-weights classifier (Muse Spark Open) adds a second opinion on risk where recorded or run live; disagreements keep the stricter risk and are flagged.

## Summary

- Forms compiled: 19 of 34 (15 skipped).
- Elements: 137; locators resolving: 99.3%; vocabulary keys (not custom): 82.5%.
- Mock site, marked automatically: keys 100% correct, risk 100% correct (after the classifier's stricter-wins).

## Per form

| Form | Category | Source | Elements | Keys (vocabulary / custom) | Risk (safe / consequential / needs user) | Locators resolve | Classifier flags | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mock-a-driver | mock site | recorded | 14 | 14 / 0 | 14 / 0 / 0 | 100% | 0 | Car insurance quote: driver details |
| mock-a-vehicle | mock site | recorded | 11 | 11 / 0 | 11 / 0 / 0 | 100% | 0 | Car insurance quote: your car |
| mock-a-cover | mock site | recorded | 9 | 9 / 0 | 6 / 1 / 2 | 100% | 0 | Car insurance quote: cover details |
| mock-b-driver | mock site | recorded | 14 | 14 / 0 | 14 / 0 / 0 | 100% | 0 | Car insurance quote: driver details |
| mock-b-vehicle | mock site | recorded | 11 | 11 / 0 | 11 / 0 / 0 | 100% | 0 | Car insurance quote: vehicle details |
| mock-b-cover | mock site | recorded | 9 | 9 / 0 | 6 / 1 / 2 | 100% | 0 | Motor insurance quote: cover options |
| govuk-contact | contact | live | 7 | 4 / 3 | 6 / 1 / 0 | 100% | 0 | Contact GOV.UK team with question or feedback |
| ico-contact | contact | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Site search: find ICO information |
| parliament-contact | contact | – | – | – | – | – | – | skipped: HTTP 403 (refuses automated browsers) |
| ofcom-contact | contact | – | – | – | – | – | – | skipped: No form to map on https://www.ofcom.org.uk/about-ofcom/what-we-do/contact-us: the page has only a site search, a cookie or consent widget. |
| travelodge-booking | booking | live | 6 | 5 / 1 | 6 / 0 / 0 | 100% | 0 | Hotel search by destination, dates and guests |
| httpbin-order | booking | live | 11 | 5 / 6 | 10 / 1 / 0 | 100% | 0 | Pizza order: contact, size, toppings and delivery |
| nationalrail-journey | booking | live | 4 | 2 / 2 | 4 / 0 / 0 | 100% | 0 | Plan train journey between stations |
| eventbrite-search | booking | live | 9 | 9 / 0 | 9 / 0 / 0 | 100% | 0 | Find local events and things to do |
| lner-booking | booking | – | – | – | – | – | – | skipped: HTTP 403 (refuses automated browsers) |
| mozilla-newsletter | newsletter | live | 2 | 2 / 0 | 1 / 1 / 0 | 100% | 0 | Firefox newsletter signup |
| which-newsletter | newsletter | – | – | – | – | – | – | skipped: No form to map on https://www.which.co.uk/about-which/which-newsletters-akBCD7z3vgqS: the page has only a site search. |
| guardian-newsletters | newsletter | – | – | – | – | – | – | skipped: No form to map on https://www.theguardian.com/email-newsletters: the page has only a site search, a newsletter sign-up. |
| wikipedia-search | search | live | 2 | 2 / 0 | 2 / 0 / 0 | 50% | 0 | Wikipedia site search |
| govuk-search | search | live | 16 | 4 / 12 | 16 / 0 / 0 | 100% | 0 | Search all content on GOV.UK |
| ons-search | search | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | ONS site search by keyword or time series ID |
| nhs-search | search | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Search the NHS website |
| github-signup | account sign-up | – | – | – | – | – | – | skipped: HTTP 403 (refuses automated browsers) |
| reddit-signup | account sign-up | – | – | – | – | – | – | skipped: No form to map on https://www.reddit.com/register/. |
| bbc-signup | account sign-up | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | BBC sign-in: enter email or username |
| aviva-car | insurance first step | live | 4 | 4 / 0 | 3 / 1 / 0 | 100% | 0 | Car insurance quote: start with registration |
| directline-car | insurance first step | – | – | – | – | – | – | skipped: No form to map on https://www.directline.com/car-cover. |
| admiral-car | insurance first step | – | – | – | – | – | – | skipped: No form to map on https://www.admiral.com/car-insurance: the page has only a cookie or consent widget. |
| churchill-car | insurance first step | – | – | – | – | – | – | skipped: No form to map on https://www.churchill.com/car-insurance. |
| moneysupermarket-car | insurance first step | – | – | – | – | – | – | skipped: HTTP 403 (refuses automated browsers) |
| nationwide-mortgage | finance first step | – | – | – | – | – | – | skipped: HTTP 404 |
| barclays-loans | finance first step | – | – | – | – | – | – | skipped: No form to map on https://www.barclays.co.uk/loans/. |
| hl-isa | finance first step | – | – | – | – | – | – | skipped: No form to map on https://www.hl.co.uk/investment-services/isa: the page has only a site search. |
| mse-mortgage | finance first step | – | – | – | – | – | – | skipped: HTTP 403 (refuses automated browsers) |
