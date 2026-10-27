# Key disagreements

Every element where Muse Spark's (`muse-spark-1.3`) key is not settled, grouped by kind. Generated 2026-10-27 by `packages/core/scripts/key-disagreements.ts` from the compiler log, the fine-tuning eval and `reports/accuracy-review.csv`. Labels are the page's own text; no values.

| Kind | Between runs | Per element vs whole form | Review |
| --- | --- | --- | --- |
| Custom keys, same slug once normalised | 2 | 0 | 0 |
| Synonym pairs | 0 | 0 | 0 |
| Custom slug wording | 1 | 9 | 0 |
| Custom key against a vocabulary key | 0 | 7 | 0 |
| Genuine disagreement | 3 | 0 | 0 |
| **Total** | **6** of 110 elements on 15 forms labelled more than once | **16** of 41 eval elements | **0** of 68 reviewed |

- **Between runs**: the same form, by fingerprint, labelled more than once by the compiler. Runs span prompt changes (custom keys encouraged on 26 October, `search.submit` added on 27 October), so some differences are the prompt, not chance.
- **Per element vs whole form**: the fine-tuning eval. Muse Spark sees one element with its neighbours and is scored against its own labels from seeing the whole form with a screenshot. This is the 61% exact-match number.
- **Review**: keys marked wrong by hand. Only the mock site has been reviewed so far.

Per element vs whole form, by page: www.gov.uk/search/all 13, www.gov.uk/contact/govuk 1, ico.org.uk/global/contact-us/ 1, www.churchill.com/car-insurance 1.

## Custom keys, same slug once normalised (2)

Both sides used a custom key and the words match after removing filler and plurals (custom.room_count and custom.rooms). Equivalence scoring counts these as correct.

| Source | Page | Element | Keys |
| --- | --- | --- | --- |
| between runs | www.travelodge.co.uk/ (5 runs) | Room 1 | `custom.room_1_adults` / `custom.adults_room_1` |
| between runs | www.travelodge.co.uk/ (5 runs) | Room 1 | `custom.room_1_children` / `custom.children_room_1` |

## Custom slug wording (10)

Both sides agree nothing in the vocabulary fits and name the element differently. Usually the same meaning; sometimes one side is vaguer (custom.search_result_link).

| Source | Page | Element | Keys |
| --- | --- | --- | --- |
| between runs | www.travelodge.co.uk/ (5 runs) | room | `custom.room_count` / `custom.number_of_rooms` |
| per element vs whole form | www.gov.uk/contact/govuk | directly. | `custom.directly` / `custom.contact_text_field` |
| per element vs whole form | www.gov.uk/search/all | Sign in to your Universal Credit account | `custom.universal_credit_sign_in` / `custom.account_sign_in` |
| per element vs whole form | www.gov.uk/search/all | HMRC online services: sign in or set up an account | `custom.hmrc_sign_in_setup` / `custom.search_result_link` |
| per element vs whole form | www.gov.uk/search/all | Sign in or set up an account | `custom.hmrc_sign_in` / `custom.search_result_link` |
| per element vs whole form | www.gov.uk/search/all | Get help with signing in to HMRC online services | `custom.hmrc_sign_in_help` / `custom.search_result_link` |
| per element vs whole form | www.gov.uk/search/all | Universal Credit | `custom.universal_credit_info` / `custom.search_result_link` |
| per element vs whole form | www.gov.uk/search/all | Get information about a company | `custom.company_information` / `custom.lookup_company` |
| per element vs whole form | www.gov.uk/search/all | Companies House | `custom.companies_house` / `custom.search_result_link` |
| per element vs whole form | www.gov.uk/search/all | eVisas: access and use your online immigration status | `custom.evisa_status` / `custom.search_result_link` |

## Custom key against a vocabulary key (7)

One side found a vocabulary key and the other invented a custom one. These are genuine disagreements about whether the vocabulary fits.

| Source | Page | Element | Keys |
| --- | --- | --- | --- |
| per element vs whole form | ico.org.uk/global/contact-us/ | Search | `form.submit` / `custom.search_submit` |
| per element vs whole form | www.gov.uk/search/all | Search | `form.submit` / `custom.search_submit` |
| per element vs whole form | www.gov.uk/search/all | Filter and sort | `ui.expand` / `custom.filter_and_sort` |
| per element vs whole form | www.gov.uk/search/all | Check the MOT history of a vehicle | `custom.check_mot_history` / `lookup.vehicle` |
| per element vs whole form | www.gov.uk/search/all | Check if a vehicle is taxed | `custom.check_vehicle_taxed` / `lookup.vehicle` |
| per element vs whole form | www.gov.uk/search/all | Check the MOT status of a vehicle | `custom.check_mot_status` / `lookup.vehicle` |
| per element vs whole form | www.churchill.com/car-insurance | Reject all | `ui.dismiss` / `custom.reject_all_cookies` |

## Genuine disagreement (3)

Two different vocabulary keys, or a key a reviewer marked wrong.

| Source | Page | Element | Keys |
| --- | --- | --- | --- |
| between runs | www.travelodge.co.uk/ (5 runs) | Search | `form.submit` / `nav.next` |
| between runs | en.wikipedia.org/wiki/Special:Search (3 runs) | Search | `custom.search` / `form.submit` / `nav.next` |
| between runs | www.aviva.co.uk/insurance/motor/car-insurance/ (4 runs) | Don't know the registration? | `ui.expand` / `nav.skip` |
