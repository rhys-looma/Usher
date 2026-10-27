# Accuracy, from review marks

Scored 2026-10-27 from `reports/accuracy-review.csv`. Only elements marked y or n count. Public forms are human-checked: a person marked each key and risk right or wrong. The mock site is marked automatically by whether each key matches the mock site's answer key (`packages/core/test/fixtures/expected-keys.json`), with risk following from that key; that shows the compiler agrees with our own answer key on a form we built, not accuracy in general.

| Set | Keys correct | Risk correct | Locators resolve |
| --- | --- | --- | --- |
| Public forms, human-checked | 73.9% (51/69) | 98.6% (68/69) | 98.6% (68/69) |
| Mock site, matches the mock site's answer key | 100% (68/68) | 100% (68/68) | 100% (68/68) |

## Public forms, human-checked

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

## Mock site, matches the mock site's answer key

| Form | Keys correct | Risk correct | Locators resolve |
| --- | --- | --- | --- |
| mock-a-driver | 100% (14/14) | 100% (14/14) | 100% (14/14) |
| mock-a-vehicle | 100% (11/11) | 100% (11/11) | 100% (11/11) |
| mock-a-cover | 100% (9/9) | 100% (9/9) | 100% (9/9) |
| mock-b-driver | 100% (14/14) | 100% (14/14) | 100% (14/14) |
| mock-b-vehicle | 100% (11/11) | 100% (11/11) | 100% (11/11) |
| mock-b-cover | 100% (9/9) | 100% (9/9) | 100% (9/9) |
