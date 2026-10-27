# Key disagreements

Every element where Muse Spark's (`muse-spark-1.3`) key is not settled, grouped by kind. Generated 2026-10-27 by `packages/core/scripts/key-disagreements.ts` from the compiler log, the fine-tuning eval and `reports/accuracy-review.csv`. Labels are the page's own text; no values.

| Kind | Between runs | Per element vs whole form | Review |
| --- | --- | --- | --- |
| Custom keys, same slug once normalised | 9 | 3 | 0 |
| Synonym pairs | 0 | 0 | 0 |
| Custom slug wording | 1 | 0 | 0 |
| Custom key against a vocabulary key | 0 | 6 | 0 |
| Genuine disagreement | 5 | 1 | 2 |
| **Total** | **15** of 118 elements on 18 forms labelled more than once | **10** of 28 eval elements | **2** of 46 human-checked |

- **Between runs**: the same form, by fingerprint, labelled more than once by the compiler. Runs span prompt changes (custom keys encouraged on 26 October, `search.submit` added on 27 October), so some differences are the prompt, not chance.
- **Per element vs whole form**: the fine-tuning eval. Muse Spark sees one element with its neighbours and is scored against its own labels from seeing the whole form with a screenshot. This is the exact-match key accuracy in docs/finetune.md.
- **Review**: public-form keys marked wrong when human-checked in `reports/accuracy-review.csv`.

Per element vs whole form, by page: www.eventbrite.co.uk/ 7, www.gov.uk/contact/govuk 3.

## Custom keys, same slug once normalised (12)

Both sides used a custom key and the words match after removing filler and plurals (custom.room_count and custom.rooms). Equivalence scoring counts these as correct.

| Source | Page | Element | Keys |
| --- | --- | --- | --- |
| between runs | httpbin.org/forms/post (5 runs) | Bacon | `custom.pizza_topping_bacon` / `custom.topping_bacon` |
| between runs | httpbin.org/forms/post (5 runs) | Extra Cheese | `custom.pizza_topping_extra_cheese` / `custom.topping_extra_cheese` |
| between runs | httpbin.org/forms/post (5 runs) | Onion | `custom.pizza_topping_onion` / `custom.topping_onion` |
| between runs | httpbin.org/forms/post (5 runs) | Mushroom | `custom.pizza_topping_mushroom` / `custom.topping_mushroom` |
| between runs | www.travelodge.co.uk/ (7 runs) | Room 1 | `custom.room_1_adults` / `custom.adults_room_1` |
| between runs | www.travelodge.co.uk/ (7 runs) | Room 1 | `custom.room_1_children` / `custom.children_room_1` |
| between runs | www.gov.uk/contact/govuk (4 runs) | help pages | `custom.help_pages` / `custom.help_pages_link` |
| between runs | www.gov.uk/contact/govuk (4 runs) | government department | `custom.government_department` / `custom.government_department_link` |
| between runs | www.gov.uk/contact/govuk (4 runs) | directly. | `custom.directly` / `custom.directly_text` |
| per element vs whole form | www.gov.uk/contact/govuk | help pages | `custom.help_pages_link` / `custom.help_pages` |
| per element vs whole form | www.gov.uk/contact/govuk | government department | `custom.government_department_link` / `custom.government_department` |
| per element vs whole form | www.gov.uk/contact/govuk | directly. | `custom.directly_text` / `custom.directly` |

## Custom slug wording (1)

Both sides agree nothing in the vocabulary fits and name the element differently. Usually the same meaning; sometimes one side is vaguer (custom.search_result_link).

| Source | Page | Element | Keys |
| --- | --- | --- | --- |
| between runs | www.travelodge.co.uk/ (7 runs) | room | `custom.room_count` / `custom.number_of_rooms` |

## Custom key against a vocabulary key (6)

One side found a vocabulary key and the other invented a custom one. These are genuine disagreements about whether the vocabulary fits.

| Source | Page | Element | Keys |
| --- | --- | --- | --- |
| per element vs whole form | www.eventbrite.co.uk/ | autocomplete | `search.query` / `custom.search_autocomplete` |
| per element vs whole form | www.eventbrite.co.uk/ | All | `search.submit` / `custom.filter_all` |
| per element vs whole form | www.eventbrite.co.uk/ | For you | `search.submit` / `custom.filter_for_you` |
| per element vs whole form | www.eventbrite.co.uk/ | Today | `search.submit` / `custom.date_filter` |
| per element vs whole form | www.eventbrite.co.uk/ | This weekend | `search.submit` / `custom.filter_this_weekend` |
| per element vs whole form | www.eventbrite.co.uk/ | Scroll carousel left | `ui.expand` / `custom.scroll_carousel_left` |

## Genuine disagreement (8)

Two different vocabulary keys, or a key a reviewer marked wrong.

| Source | Page | Element | Keys |
| --- | --- | --- | --- |
| between runs | www.travelodge.co.uk/ (7 runs) | Search | `form.submit` / `nav.next` / `search.submit` |
| between runs | en.wikipedia.org/wiki/Special:Search (3 runs) | Search | `custom.search` / `form.submit` / `nav.next` |
| between runs | www.aviva.co.uk/insurance/motor/car-insurance/ (5 runs) | Don't know the registration? | `ui.expand` / `nav.skip` |
| between runs | ico.org.uk/global/contact-us/ (3 runs) | Search | `form.submit` / `search.submit` |
| between runs | www.nhs.uk/ (2 runs) | Search | `nav.next` / `search.submit` |
| per element vs whole form | www.eventbrite.co.uk/ | autocomplete | `search.location` / `search.query` |
| review | eventbrite-search |  | `search.submit` |
| review | aviva-car | Continue your saved quote | `nav.next` |
