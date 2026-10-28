# Vote mode against the human marks

Generated 2026-10-28 by `packages/core/scripts/vote-eval.ts`. Marks: `reports/accuracy-review-2026-10-27.csv` (69 public elements on 13 forms, every one marked by hand). Live model spend: $0.5699.

The marked run itself: 51 of 69 keys right (73.9%), 68 risks right (98.6%).

Each form compiled again today, once with one run and once in vote mode, and each element matched to its marked row by label and control (pages change; unmatched elements are left out). A key or risk equal to the marked one inherits its mark; a changed one where the mark said right counts as a regression; a changed one where the mark said wrong may be a fix, and waits for a person to mark it.

| Mode | Matched | Keys right | Keys regressed | Keys changed, to mark | Risks right | Risks regressed | Risks changed, to mark |
| --- | --- | --- | --- | --- | --- | --- | --- |
| One run | 48 | 37 (77.1%) | 9 | 0 | 47 (97.9%) | 0 | 0 |
| Vote mode | 50 | 39 (78%) | 9 | 0 | 49 (98%) | 0 | 0 |

## Forms

- govuk-contact: vote mode 3 runs
- ico-contact: vote mode 2 runs
- travelodge-booking: vote mode 3 runs
- httpbin-order: vote mode 3 runs
- nationalrail-journey: vote mode 1 run
- eventbrite-search: vote mode 1 run
- mozilla-newsletter: vote mode 3 runs
- wikipedia-search: vote mode 1 run
- govuk-search: vote mode 2 runs
- ons-search: vote mode 1 run
- nhs-search: vote mode 2 runs
- bbc-signup: vote mode 1 run
- aviva-car: vote mode 3 runs

## Changed by vote mode, waiting for a mark

None.
