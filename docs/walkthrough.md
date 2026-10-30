# Map my site: the walkthrough mapper

A site owner presses **Map my site** on the dashboard. Usher opens their form in its own browser, walks it page by page the way an agent would, and proposes a map for every page. Nothing changes for agents until the owner publishes it.

It is step two of the [twenty minutes](site-apps.md#the-twenty-minutes). The owner's page shows the setup strip. Once the maps are published, each journey becomes a tool in the site's assistant app, and the page points to the next step, the rules.

## Who can start one

- **The owner of a joined site**, signed in to the dashboard, on the origin they proved they control. The start page must be on that origin.
- **The operator**, through `/admin`, on the public demo site only.
- **One run per site per UTC day.** `USHER_WALKTHROUGH_DAILY_LIMIT` raises it for the demo site, and for no other.
- **Within the daily model budget.** A run is refused when today's spend plus an estimate for one run ($0.60) would pass the cap.
- **One run at a time per site.**

The dashboard shows the last run and greys the button with the reason when a run can't start.

## What the owner gives it

- **Test values, by key**, one per line (`person.first_name: Robin`), or **a generated test person**: a fixed, fictional set of answers (`packages/registry/src/walkthrough-persona.ts`). An owner's line overrides the generated answer for that key. Where a test answer matches none of a question's options, the walkthrough takes the question's first real option so the journey can go on.
- **Stand-ins for the rest.** A required field that no test answer covers gets a harmless stand-in, so the site doesn't refuse the page: a list's first real option, the lowest number allowed, a date a fortnight away, a ticked box, `Test` (or the first of a few stock answers that fits the field's pattern). That covers a mortgage's property price, a booking's party size or a pet's name. Optional fields, files and passwords are left empty. Stand-ins stay in the run's memory like every test answer.
- **Whether the final consequential action may be pressed.** Unticked, the run stops before it (for example before "Get my quote") and says so. Ticked, the run knocks again with that action confirmed, as an agent would, and presses it.

The values live in the run's memory and nowhere else: not in storage, logs, the compiler log, screenshots, live frames or error messages. A test checks this for completed, cancelled and failed runs, against every file the registry wrote and every event it streamed.

## What it does, page by page

1. **Knocks** as `walkthrough:<site>` (a session the site's log shows as the walkthrough), and binds the token to the page so the site script and middleware treat it like any agent.
2. **Extracts** the form (structure only, as everywhere in Usher).
3. **Explores branches.** For each of the first 12 radio groups and selects, it tries every option (up to 8) and records which fields each one shows. Code writes `shown_if` from what it saw; the model is not asked. It leaves the option that shows the most, so those fields are labelled too, and notes fields that only other options show.
4. **Labels** the page with Muse Spark in vote mode (up to three runs; see `packages/core/src/compile/vote.ts`), with the masked screenshot. Each element also gets its `box`.
5. **Runs lookups** (postcode to address list, registration to car) with the test values and records the lists they show as structure: a label and a count, never the entries. Opens comboboxes and counts their options the same way.
6. **Fills** the safe fields with the test values (and stand-ins), in order, respecting the conditions it found.
7. **Moves on** by the page's forward action and records `leads_to`. It stops at the result page, at the first consequential action it isn't allowed to press, after 10 pages, or when the page won't move on (the site may have refused a test value).

## What the owner sees

- **Live.** The browser view (masked JPEG frames, about two a second) and the steps in plain words, over server-sent events. Closing the page doesn't stop the run; the result waits on the dashboard.
- **The result.** One annotated screenshot per page: each element boxed and coloured by risk (green safe, amber consequential, red the person's), with its key as a tag. The same elements as a table, with the condition that shows each one and where each action leads. Hovering or focusing a box lights its row and back; every box is a link to its row, so the whole view works from the keyboard and as text.
- **A diff** against the maps agents get now: elements added, removed or labelled differently.
- **Corrections.** Each row has a **Correct** control for key, risk and label. A change that would make the map invalid is refused and explained.
- **Change it in words.** The owner can also say what to change ("the smoker question is the person's own on every page", "call the third field the policy number"). Muse Spark reads the sentence and the proposal's structure (ids, labels, controls, keys, risks; never a value) and proposes changes by element id. Code checks each one as it checks a row correction and leaves out any that name an element that isn't there or a key that isn't a key. The owner sees every change with its reason, then accepts or discards; accepted changes go through the same path as row corrections, so each is an owner-verified label. A request that is really a site rule ("only my customers answer medical questions") is not applied to the map; the owner is pointed to the rules page instead.
- **Publish.** The proposal replaces the maps agents get, recorded as the site's own (`source: site`) and verified by the owner. Boxes are dropped from published maps; agents don't need them.

The public demo site's last run can be watched by anyone at `/demo/walkthrough`, read-only. The picker on `/viewer` has the same annotated view for its public forms ("See how Usher reads this form"), drawn from the cached map's own locators with no model call.

## Corrections are training data

Each correction is kept in the registry's `corrections` table (and the local compiler log in development), tagged `owner_verified`, with the site, the time, the model's answer and the owner's, and the element's structure as a small model would see it: label, control, options summary, neighbours, page title. Never a value.

`npm run finetune:export` takes an owner's answer over any number of model runs for the same element, and counts owner-verified examples in `stats.json`. In production, download the table from `/admin/corrections.jsonl` and pass it with `--corrections <file>`.

## The demo scene

```sh
USHER_ADMIN_KEY=… npm run demo:walkthrough -- --registry <registry url> --start /health/about
```

It starts a run on the demo site as the operator and opens `/demo/walkthrough` in a visible browser window, ready to record.

## Limits and what it doesn't do

- It doesn't sign in, solve a CAPTCHA, upload files or pay.
- Fields that only appear after a choice it didn't leave selected are noted, not mapped.
- It never follows the site off its own origin, and every request its browser makes must reach a public address (the same check as the map viewer and hosted MCP).
