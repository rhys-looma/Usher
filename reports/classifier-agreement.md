# Risk classifier agreement

Muse Spark (muse-spark-1.3) labels each element's risk; Muse Spark Open (meta-models/muse-spark-open-1026) classifies it independently. Where they differ, the stricter risk is kept and the element is flagged. Generated 2026-10-27 by `packages/core/scripts/classifier-report.ts`. Pages were loaded and read; nothing was submitted.

- Mock site, 6 pages: 95.6% of 68 elements agree.
- Public forms: 96.2% of 26 elements agree.

| Form | Page | Elements | Agreement | Disagreements (kept the stricter) |
| --- | --- | --- | --- | --- |
| mock site A driver | /quote/driver | 14 | 100% | – |
| mock site A vehicle | /quote/vehicle | 11 | 100% | – |
| mock site A cover | /quote/cover | 9 | 100% | – |
| mock site B driver | /quote/driver | 14 | 78.6% | Have you made any claims in the last 5 years? (person.claims.has_any): Spark safe, Open needs_user → needs_user; Date of the claim (person.claims.date): Spark safe, Open needs_user → needs_user; Type of claim (person.claims.type): Spark safe, Open needs_user → needs_user |
| mock site B vehicle | /quote/vehicle | 11 | 100% | – |
| mock site B cover | /quote/cover | 9 | 100% | – |
| contact | https://www.gov.uk/contact/govuk | 7 | 100% | – |
| booking | https://www.travelodge.co.uk/ | 11 | 90.9% | Search (form.submit): Spark consequential, Open safe → consequential |
| newsletter sign-up | https://www.mozilla.org/en-US/newsletter/ | 2 | 100% | – |
| search | https://en.wikipedia.org/wiki/Special:Search | 2 | 100% | – |
| insurer first step | https://www.aviva.co.uk/insurance/motor/car-insurance/ | 4 | 100% | – |

**Run-to-run variation.** Muse Spark Open (`-1026`) is not deterministic at temperature 0. Three runs on 27 Oct gave 95.6%, 83.8% and 95.6% on the mock site; the low run marked claims history, mileage and car use as `needs_user` on layout A. The public-form element counts also vary, because Muse Spark compiles those pages live each run. The disagreements are almost all the classifier being stricter, and the stricter risk is what's kept, so variation makes maps more cautious, never less.
