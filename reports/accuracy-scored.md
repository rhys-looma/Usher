# Accuracy, from review marks

Scored 2026-10-28. Only elements marked y or n count. Public forms are human-checked: a person marked each key and risk right or wrong. The mock site is marked automatically by whether each key matches the mock site's answer key (`packages/core/test/fixtures/expected-keys.json`), with risk following from that key; that shows the compiler agrees with our own answer key on a form we built, not accuracy in general.

| Run | Set | Keys correct | Risk correct | Locators resolve | Not yet marked |
| --- | --- | --- | --- | --- | --- |
| Latest run (`accuracy-review.csv`) | Public forms, human-checked | 95% (38/40) | 97.5% (39/40) | 87% (327/376) | 336 |
|  | Mock site, matches the mock site's answer key | 100% (68/68) | 100% (68/68) | 100% (68/68) |  |
| Run of 2026-10-27 (`accuracy-review-2026-10-27.csv`) | Public forms, human-checked | 73.9% (51/69) | 98.6% (68/69) | 98.6% (68/69) | 0 |
|  | Mock site, matches the mock site's answer key | 100% (68/68) | 100% (68/68) | 100% (68/68) |  |

## Latest run

### Public forms, human-checked

| Form | Keys correct | Risk correct | Locators resolve |
| --- | --- | --- | --- |
| govuk-contact | 100% (4/4) | 100% (4/4) | 100% (9/9) |
| ico-contact | 100% (2/2) | 50% (1/2) | 100% (2/2) |
| ofcom-contact | not reviewed | not reviewed | 100% (3/3) |
| travelodge-booking | 100% (6/6) | 100% (6/6) | 100% (6/6) |
| httpbin-order | 100% (7/7) | 100% (7/7) | 100% (11/11) |
| nationalrail-journey | 100% (3/3) | 100% (3/3) | 100% (4/4) |
| eventbrite-search | 66.7% (2/3) | 100% (3/3) | 100% (3/3) |
| mozilla-newsletter | 100% (2/2) | 100% (2/2) | 100% (2/2) |
| guardian-newsletters | not reviewed | not reviewed | 100% (53/53) |
| wikipedia-search | not reviewed | not reviewed | 100% (3/3) |
| govuk-search | 100% (3/3) | 100% (3/3) | 100% (4/4) |
| ons-search | 100% (2/2) | 100% (2/2) | 100% (2/2) |
| nhs-search | 100% (2/2) | 100% (2/2) | 100% (2/2) |
| bbc-signup | 100% (2/2) | 100% (2/2) | 100% (2/2) |
| aviva-car | 75% (3/4) | 100% (4/4) | 100% (4/4) |
| govuk-find-council | not reviewed | not reviewed | 100% (3/3) |
| govuk-travel-advice | not reviewed | not reviewed | 100% (1/1) |
| govuk-electoral-office | not reviewed | not reviewed | 100% (3/3) |
| vehicle-enquiry | not reviewed | not reviewed | 100% (2/2) |
| companies-house-search | not reviewed | not reviewed | 100% (2/2) |
| charity-register-search | not reviewed | not reviewed | 100% (3/3) |
| food-ratings | not reviewed | not reviewed | 100% (7/7) |
| flood-check | not reviewed | not reviewed | 100% (2/2) |
| ofsted-reports | not reviewed | not reviewed | 100% (31/31) |
| nhs-find-gp | not reviewed | not reviewed | 100% (4/4) |
| nhs-find-pharmacy | not reviewed | not reviewed | 100% (5/5) |
| nhs-find-dentist | not reviewed | not reviewed | 100% (3/3) |
| tfl-journey | not reviewed | not reviewed | 100% (6/6) |
| metoffice-search | not reviewed | not reviewed | 100% (2/2) |
| ofcom-broadband-checker | not reviewed | not reviewed | 100% (4/4) |
| citizensadvice-search | not reviewed | not reviewed | 100% (2/2) |
| uswitch-broadband | not reviewed | not reviewed | 31.9% (23/72) |
| octopus-quote | not reviewed | not reviewed | 100% (2/2) |
| english-heritage-search | not reviewed | not reviewed | 100% (10/10) |
| cruk-donate | not reviewed | not reviewed | 100% (3/3) |
| redcross-donate | not reviewed | not reviewed | 100% (4/4) |
| oxfam-donate | not reviewed | not reviewed | 100% (5/5) |
| shelter-donate | not reviewed | not reviewed | 100% (7/7) |
| parliament-petitions | not reviewed | not reviewed | 100% (35/35) |
| gov-paye-calculator | not reviewed | not reviewed | 100% (3/3) |
| nhs-111-start | not reviewed | not reviewed | 100% (2/2) |
| citizensadvice-contact | not reviewed | not reviewed | 100% (2/2) |
| ons-census-search | not reviewed | not reviewed | 100% (2/2) |
| bfi-newsletter | not reviewed | not reviewed | 100% (2/2) |
| nhm-search | not reviewed | not reviewed | 100% (5/5) |
| trainline-search | not reviewed | not reviewed | 100% (9/9) |
| bbc-search | not reviewed | not reviewed | 100% (2/2) |
| ageuk-search | not reviewed | not reviewed | 100% (3/3) |
| openreach-fibre-checker | not reviewed | not reviewed | 100% (2/2) |
| gumtree-search | not reviewed | not reviewed | 100% (3/3) |
| nhs-conditions-search | not reviewed | not reviewed | 100% (2/2) |
| gov-find-apprenticeship | not reviewed | not reviewed | 100% (11/11) |

### Mock site, matches the mock site's answer key

| Form | Keys correct | Risk correct | Locators resolve |
| --- | --- | --- | --- |
| mock-a-driver | 100% (14/14) | 100% (14/14) | 100% (14/14) |
| mock-a-vehicle | 100% (11/11) | 100% (11/11) | 100% (11/11) |
| mock-a-cover | 100% (9/9) | 100% (9/9) | 100% (9/9) |
| mock-b-driver | 100% (14/14) | 100% (14/14) | 100% (14/14) |
| mock-b-vehicle | 100% (11/11) | 100% (11/11) | 100% (11/11) |
| mock-b-cover | 100% (9/9) | 100% (9/9) | 100% (9/9) |

## Run of 2026-10-27

### Public forms, human-checked

| Form | Keys correct | Risk correct | Locators resolve |
| --- | --- | --- | --- |
| govuk-contact | 100% (7/7) | 100% (7/7) | 100% (7/7) |
| ico-contact | 100% (2/2) | 50% (1/2) | 100% (2/2) |
| travelodge-booking | 100% (6/6) | 100% (6/6) | 100% (6/6) |
| httpbin-order | 100% (11/11) | 100% (11/11) | 100% (11/11) |
| nationalrail-journey | 100% (4/4) | 100% (4/4) | 100% (4/4) |
| eventbrite-search | 44.4% (4/9) | 100% (9/9) | 100% (9/9) |
| mozilla-newsletter | 100% (2/2) | 100% (2/2) | 100% (2/2) |
| wikipedia-search | 100% (2/2) | 100% (2/2) | 50% (1/2) |
| govuk-search | 25% (4/16) | 100% (16/16) | 100% (16/16) |
| ons-search | 100% (2/2) | 100% (2/2) | 100% (2/2) |
| nhs-search | 100% (2/2) | 100% (2/2) | 100% (2/2) |
| bbc-signup | 100% (2/2) | 100% (2/2) | 100% (2/2) |
| aviva-car | 75% (3/4) | 100% (4/4) | 100% (4/4) |

### Mock site, matches the mock site's answer key

| Form | Keys correct | Risk correct | Locators resolve |
| --- | --- | --- | --- |
| mock-a-driver | 100% (14/14) | 100% (14/14) | 100% (14/14) |
| mock-a-vehicle | 100% (11/11) | 100% (11/11) | 100% (11/11) |
| mock-a-cover | 100% (9/9) | 100% (9/9) | 100% (9/9) |
| mock-b-driver | 100% (14/14) | 100% (14/14) | 100% (14/14) |
| mock-b-vehicle | 100% (11/11) | 100% (11/11) | 100% (11/11) |
| mock-b-cover | 100% (9/9) | 100% (9/9) | 100% (9/9) |
