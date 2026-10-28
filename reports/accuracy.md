# Accuracy

Generated 2026-10-28 by `packages/core/scripts/accuracy.ts` (forms: all, live within $5).

## Method

- Each page is loaded in headless Chromium at 1280px and its main form compiled exactly as the registry does: extraction, locators, fingerprint, Muse Spark labels, validation, merge. Nothing is submitted.
- Model responses come from recorded fixtures (mock site) or the compiler log (public forms compiled before); a page that changed since then has no recorded response and is skipped unless the run is `--live`.
- **Locators resolve**: every locator of the element finds exactly one element, and they all agree, on the live page.
- **Keys** and **risk** on the mock site are marked automatically: whether each matches the mock site's answer key (`packages/core/test/fixtures/expected-keys.json`). On public forms they are human-checked in `reports/accuracy-review.csv`. `npm run accuracy:score` scores both, separately.
- The open-weights classifier (Muse Spark Open) adds a second opinion on risk where recorded or run live; disagreements keep the stricter risk and are flagged.
- Pages that could not be loaded at all (they refuse automated browsers, or no longer exist) are left out.

## Summary

- Forms compiled: 58 of 65 (7 skipped: no form to map, or labels that failed validation).
- Elements: 444; locators resolving: 89%; vocabulary keys (not custom): 59.9%.
- Mock site, matches the mock site's answer key: keys 100% correct, risk 100% correct (after the classifier's stricter-wins).

## Per form

| Form | Category | Source | Elements | Keys (vocabulary / custom) | Risk (safe / consequential / needs user) | Locators resolve | Classifier flags | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mock-a-driver | mock site | recorded | 14 | 14 / 0 | 14 / 0 / 0 | 100% | 0 | Car insurance quote: driver details |
| mock-a-vehicle | mock site | recorded | 11 | 11 / 0 | 11 / 0 / 0 | 100% | 0 | Car insurance quote: your car |
| mock-a-cover | mock site | recorded | 9 | 9 / 0 | 6 / 1 / 2 | 100% | 0 | Car insurance quote: cover details |
| mock-b-driver | mock site | recorded | 14 | 14 / 0 | 14 / 0 / 0 | 100% | 0 | Car insurance quote: driver details |
| mock-b-vehicle | mock site | recorded | 11 | 11 / 0 | 11 / 0 / 0 | 100% | 0 | Car insurance quote: vehicle details |
| mock-b-cover | mock site | recorded | 9 | 9 / 0 | 6 / 1 / 2 | 100% | 0 | Car insurance quote: cover options |
| govuk-contact | contact | live | 9 | 4 / 5 | 8 / 1 / 0 | 100% | 0 | Contact GOV.UK team with question or feedback |
| ico-contact | contact | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Site search: find ICO information |
| ofcom-contact | contact | live | 3 | 1 / 2 | 2 / 1 / 0 | 100% | 0 | Rate this page: feedback on helpfulness |
| travelodge-booking | booking | live | 6 | 5 / 1 | 6 / 0 / 0 | 100% | 0 | Hotel search by destination, dates and guests |
| httpbin-order | booking | live | 11 | 5 / 6 | 10 / 1 / 0 | 100% | 0 | Pizza order: customer, size, toppings and delivery |
| nationalrail-journey | booking | recorded | 4 | 2 / 2 | 4 / 0 / 0 | 100% | 0 | Plan train journey between stations |
| eventbrite-search | booking | recorded | 3 | 3 / 0 | 3 / 0 / 0 | 100% | 0 | Discover local events: search by keyword and location |
| mozilla-newsletter | newsletter | live | 2 | 2 / 0 | 1 / 1 / 0 | 100% | 0 | Firefox newsletter signup |
| which-newsletter | newsletter | – | – | – | – | – | – | skipped: No form to map on https://www.which.co.uk/about-which/which-newsletters-akBCD7z3vgqS: the page has only a site search. |
| guardian-newsletters | newsletter | live | 53 | 52 / 1 | 3 / 50 / 0 | 100% | 0 | Sign up for Guardian newsletters |
| wikipedia-search | search | recorded | 3 | 1 / 2 | 3 / 0 / 0 | 100% | 0 | Search Wikipedia articles |
| govuk-search | search | live | 4 | 4 / 0 | 4 / 0 / 0 | 100% | 0 | Search all content on GOV.UK |
| ons-search | search | recorded | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | ONS site search by keyword or time series ID |
| nhs-search | search | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Search the NHS website |
| reddit-signup | account sign-up | – | – | – | – | – | – | skipped: No form to map on https://www.reddit.com/register/. |
| bbc-signup | account sign-up | recorded | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | BBC sign in: enter email or username |
| aviva-car | insurance first step | live | 4 | 4 / 0 | 3 / 1 / 0 | 100% | 0 | Car insurance quote by registration |
| directline-car | insurance first step | – | – | – | – | – | – | skipped: No form to map on https://www.directline.com/car-cover. |
| admiral-car | insurance first step | – | – | – | – | – | – | skipped: No form to map on https://www.admiral.com/car-insurance: the page has only a cookie or consent widget. |
| churchill-car | insurance first step | – | – | – | – | – | – | skipped: No form to map on https://www.churchill.com/car-insurance. |
| barclays-loans | finance first step | – | – | – | – | – | – | skipped: No form to map on https://www.barclays.co.uk/loans/. |
| hl-isa | finance first step | – | – | – | – | – | – | skipped: No form to map on https://www.hl.co.uk/investment-services/isa: the page has only a site search. |
| govuk-find-council | lookup | live | 3 | 3 / 0 | 3 / 0 / 0 | 100% | 0 | Find your local council |
| govuk-travel-advice | search | live | 1 | 1 / 0 | 1 / 0 / 0 | 100% | 0 | Search foreign travel advice by country or territory |
| govuk-electoral-office | lookup | live | 3 | 3 / 0 | 3 / 0 / 0 | 100% | 0 | Find electoral registration office by postcode |
| vehicle-enquiry | lookup | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Check if a vehicle is taxed and has an MOT |
| companies-house-search | search | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Search the company register |
| charity-register-search | search | live | 3 | 2 / 1 | 3 / 0 / 0 | 100% | 0 | Search the register of charities |
| food-ratings | search | live | 7 | 4 / 3 | 7 / 0 / 0 | 100% | 0 | Search for food hygiene ratings by business and location |
| flood-check | lookup | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Check for flooding in England |
| ofsted-reports | search | live | 31 | 3 / 28 | 31 / 0 / 0 | 100% | 0 | Find an Ofsted inspection report |
| nhs-find-gp | lookup | live | 4 | 2 / 2 | 4 / 0 / 0 | 100% | 0 | Find a GP surgery by postcode in England |
| nhs-find-pharmacy | lookup | live | 5 | 2 / 3 | 5 / 0 / 0 | 100% | 0 | Find a pharmacy in England |
| nhs-find-dentist | lookup | live | 3 | 3 / 0 | 3 / 0 / 0 | 100% | 0 | Find NHS dentist accepting new patients |
| tfl-journey | booking | live | 6 | 2 / 4 | 6 / 0 / 0 | 100% | 0 | Plan a journey on Transport for London |
| metoffice-search | search | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Find a weather forecast for a place |
| ofcom-broadband-checker | lookup | live | 4 | 4 / 0 | 4 / 0 / 0 | 100% | 0 | Check broadband availability by postcode |
| citizensadvice-search | search | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Find your local Citizens Advice service |
| uswitch-broadband | lookup | live | 72 | 18 / 54 | 72 / 0 / 0 | 31.9% | 0 | Find and compare broadband deals in your area |
| octopus-quote | quote | live | 2 | 2 / 0 | 1 / 1 / 0 | 100% | 0 | Energy quote: enter postcode to get a quote |
| english-heritage-search | search | live | 10 | 4 / 6 | 4 / 0 / 6 | 100% | 0 | Find a day out near you |
| cruk-donate | donation | live | 3 | 1 / 2 | 3 / 0 / 0 | 100% | 0 | Donate to beat cancer: choose amount |
| redcross-donate | donation | live | 4 | 2 / 2 | 4 / 0 / 0 | 100% | 0 | Monthly donation to Disaster Fund |
| oxfam-donate | donation | live | 5 | 1 / 4 | 4 / 0 / 1 | 100% | 0 | Monthly charity donation |
| shelter-donate | donation | live | 7 | 1 / 6 | 6 / 0 / 1 | 100% | 0 | Donate to Shelter to fight homelessness |
| parliament-petitions | search | live | 35 | 3 / 32 | 35 / 0 / 0 | 100% | 0 | Search and view UK Parliament petitions |
| gov-paye-calculator | calculator | live | 3 | 1 / 2 | 3 / 0 / 0 | 100% | 0 | PAYE take-home pay estimate: your pay amount |
| nhs-111-start | search | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Search the NHS website |
| citizensadvice-contact | contact | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Find nearest Citizens Advice office |
| ons-census-search | search | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Search ONS statistics by keyword or time series ID |
| bfi-newsletter | newsletter | live | 2 | 2 / 0 | 1 / 1 / 0 | 100% | 0 | Sign up to BFI news emails |
| nhm-search | search | live | 5 | 4 / 1 | 4 / 1 / 0 | 100% | 0 | Newsletter signup for museum updates |
| trainline-search | booking | live | 9 | 5 / 4 | 8 / 0 / 1 | 100% | 0 | Search, compare and buy cheap train tickets |
| bbc-search | search | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Search BBC content |
| ageuk-search | search | live | 3 | 2 / 1 | 3 / 0 / 0 | 100% | 0 | Find Age UK services, branches and shops nearby |
| openreach-fibre-checker | lookup | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Fibre broadband availability checker |
| gumtree-search | search | live | 3 | 3 / 0 | 3 / 0 / 0 | 100% | 0 | Search Gumtree classified ads |
| nhs-conditions-search | search | live | 2 | 2 / 0 | 2 / 0 / 0 | 100% | 0 | Search the NHS website |
| gov-find-apprenticeship | search | live | 11 | 7 / 4 | 11 / 0 / 0 | 100% | 0 | Find an apprenticeship: filter by job, location and type |
