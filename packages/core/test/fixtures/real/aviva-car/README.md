# Aviva car insurance quote: real pages, structure only

Captured on 28 October 2026 from www.aviva.co.uk and www.direct.aviva.co.uk while a real car insurance quote was taken, step by step, in Chrome. The extractor ran read-only on each page as it was reached (the same in-page code as `scanScript()`, plus a count of comboboxes, listbox buttons and day/month/year fields).

**What's kept:** fields, labels, options, groups and actions only. Nothing typed is in these files: the extractor never reads an input's value. The address lookup's list of results (the addresses on one postcode), the greeting with the person's name, the price and the quote reference are left out.

| File | Page | State |
| --- | --- | --- |
| `00-landing.json` | aviva.co.uk car insurance | Registration box, "Get a new quote" |
| `01-vehicle.json` | Step 1 of 5, About your vehicle | After the registration lookup has found the car |
| `02-driver-details.json` | Step 2 of 5, About you: driver details | As it loads |
| `02b-driver-details-address-results.json` | The same | After "Find address": a select of addresses appears (the addresses are redacted) |
| `02c-driver-details-no-licence.json` | The same | After "I don't want to provide my licence": licence type, years held and convictions appear |
| `03-additional-information.json` | Step 3 of 5, Additional information | A list of assumptions, then one Yes/No to agree them. Answering Yes also shows two optional selects ("When does your home insurance renew?", "Where did you hear about us?"), not captured |
| `04-quote-details.json` | Step 4 of 5, the price | The voluntary excess as radios labelled in pounds |

Step 5 (buying) was not opened.

## What the pages need

- **Option matching (B1):**
  - mileage bands: "12,000" is "Up to 12,000 a year", value `UpTo12000`;
  - years as labels: "8 years" for licence held, "6 years" for the no-claims discount;
  - the excess: "£250", value 250;
  - picking one address from a lookup's results.
- **Dates (B2):**
  - the cover start date is a text box with a DD/MM/YYYY pattern;
  - the date of birth is split into `DayOfBirth`, `MonthOfBirth` and `YearOfBirth` text boxes under one "Date of birth" group (autocomplete `bday-day`, `bday-month`, `bday-year`).
- **Lookup with a result list (B3):** "Find address" shows a select of addresses that wasn't there before. The registration lookup on the landing page instead carries the found car into step 1.
- **Comboboxes (B4): none.** No `role=combobox`, `aria-autocomplete` or listbox-style dropdown on any of these pages.
- **Also:** radios are styled as cards (`ul role=radiogroup` with the input hidden). Clicking the input itself didn't register "Main driver"; clicking its label did.
