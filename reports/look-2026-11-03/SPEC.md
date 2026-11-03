# Usher look: implementation spec

The direction chosen on 3 November 2026 from the mockups at
https://claude.ai/artifact/AAZHPRBH2NdT698bwt7sHg (rows B3 and B5, "Petrol").
This is the brief for carrying it onto the site. It changes the look and the
front page's structure. It does not change what any page does.

## 1. The diagnosis, in one paragraph

What read as generated was the structure, not the palette: cream paper with a
Georgia-style display serif, uppercase letter-spaced eyebrows above every
heading, every block in a bordered card (often inside another card) with a
coloured top edge, the hero ticket, and three identical feature cards. The
remedy is one typeface, a flat page with rules instead of boxes, one owned
colour used in a few places, and a front page that shows what Usher does for
the owner rather than explaining it.

## 2. Tokens

Replace the `:root` block in `packages/registry/src/web/html.ts`. Keep the
variable names so nothing else has to change; the values below are what the
mockups use. Dark is the stage (front page, header bands, the summary panel);
light is every owner page.

| Variable | Light (owner pages) | Dark (stage) | Used for |
| --- | --- | --- | --- |
| `--bg` | `#f3f7f7` | `#0b2a33` | page |
| `--paper` | `#ffffff` | `#061b22` | panels, tables, the window |
| `--card` | `#ffffff` | `#0a2129` | alternate rows |
| `--ink` | `#0b2a33` | `#eef5f5` | text |
| `--muted` | `#4f6d72` | `#a7c4c8` | secondary text |
| `--dim` (new) | `#7f9ea3` | `#7fa8ae` | timestamps, hints, footer |
| `--line` | `#d3e0e2` | `#1c4650` | hairlines |
| `--rule` | `#0b2a33` | `#275a66` | stronger rules, panel borders |
| `--accent` | `#c2452c` | `#ff6a4d` | the brand colour |
| `--accent-ink` | `#ffffff` | `#061b22` | text on the accent |
| `--button` | `#0b2a33` | `#ff6a4d` | primary button |
| `--button-ink` | `#ffffff` | `#061b22` | |
| `--safe` / `--safe-bg` | `#1f9d66` / `#e3f5ec` | `#6fe3a6` / `#0f3a2c` | agent fills |
| `--cons` / `--cons-bg` | `#b8860b` / `#fff9ec` | `#f0b429` / `#3a2f14` | person confirms |
| `--user` / `--user-bg` | keep | keep | refused, errors |
| `--footer` | `#0b2a33` | `#061b22` | |

Drop `--serif`, `--pill-bg` and the purple. The `prefers-color-scheme: dark`
block becomes the dark column above, so owner pages in dark mode use the stage
colours too.

Contrast was checked for every text pairing in the table at 4.5:1 or better,
including the dim text on both grounds and the accent on the dark ground. Do
not lighten `--dim` further.

## 3. Type

One family, Instrument Sans (SIL Open Font Licence), weights 400, 500, 600,
700, with JetBrains Mono 400 and 500 for addresses, keys, tool names and step
numbers. The site loads nothing from other origins, so self-host both as woff2
under the registry's static files (`/fonts/`) with `font-display: swap`, and
fall back to `system-ui` and `ui-monospace`.

| Role | Size / weight / tracking |
| --- | --- |
| Front page h1 | 72px, 700, -0.04em, line-height 0.98, max 16ch |
| Page h1 (owner) | 30px, 700, -0.03em |
| Section h2 | 26px front page, 17px owner pages, 600 to 700 |
| Body | 15px owner pages, 16px front page, line-height 1.5 |
| Small | 13px; 12px for timestamps and hints |
| Numbers in stat tiles | 34px, 700, -0.04em, `font-variant-numeric: tabular-nums` |

Remove `.label` (the uppercase eyebrow) everywhere. Where a label is still
needed above a block, it is JetBrains Mono 12px in the accent colour (dark) or
muted colour (light), uppercase, 0.04em tracking, and nowhere else on the page.

## 4. Chrome and components

- **Header.** A plain bar: mark and wordmark left, nav right, the primary
  button filled in the accent. No pill, no floating nav. On owner pages the
  bar is the dark colour and carries the site's host in mono with a green dot
  when the app is on, and Sign out.
- **Tabs** (Tasks, Activity, Rules, Look, Publish) sit in the dark header; the
  active tab is a light tab with rounded top corners that joins the page
  below. "Map my site again" right-aligned in the accent.
- **The mark.** A 22px square outline in the accent with an arrow inside
  (`spec/` carries no logo; the SVG is in `PetrolHome.dc.html` on the canvas).
  Replace the Georgia "U" favicon with it.
- **Buttons.** 4px radius, no shadow. Primary: `--button`. Secondary: 1px
  border in `--rule`, transparent. Small variant 13px.
- **Panels.** `--paper` with a 1px `--line` border and 6px radius. One level
  only: never a panel inside a panel. Inside a panel, rows are separated by
  1px `--line`, never by borders of their own.
- **Tables.** Header row 11px muted, 600. Row borders `--line`. Mono for
  paths and names. No row hover colour.
- **The two states** are a fixed pair across the whole product: a filled 8px
  square in `--safe` before "Agent fills", in `--cons` before "Person
  confirms". The same squares in the key under the mapping window, in the
  task page tables (with the row tinted `--cons-bg`), in the rules table and
  in session outcomes. Refused keeps `--user`. These are the only badges.
- **The dark panel** on light pages (today's summary, your rules quoted) is
  `--bg` dark with `--ink` dark and a mono label in the accent. Used once or
  twice per page, never more.
- **Status line.** Replace the `<p class="notice">` left-border card with a
  single line of text under the h1, muted, with the time in mono.
- **No** gradients, shadows, left-border cards, coloured top edges, uppercase
  eyebrows, pills, or emoji.

## 5. The front page, `landing.ts`

Order of sections, top to bottom:

1. **Hero.** Left-aligned. h1 "Let AI agents use your site. On your terms."
   as today, in one weight with no italic. One sentence under it: "One
   script tag. Assistants fill what you allow, your customer answers what is
   theirs, and you see every session." Two buttons: Add your site, See it
   happen (anchor to the example). No ticket, no eyebrow, no side column.
2. **What happens in between.** The existing section, kept whole: the
   customer's message, the working line, the decision card and the result
   card on the left; the six steps with "Usher sees" on the right; the keeps
   list under. Keep the existing play-through in `site.js`. Changes:
   - the two panes sit on `--paper` dark with a 1px `--rule` border, no shadow;
   - the cards keep the site's own band and the white ground, so they read as
     the site's app, not Usher's chrome;
   - step 4 is picked out in `--cons` while the person is deciding, and steps
     not yet reached sit at 0.3 opacity;
   - section lede shortened to "One quote from Brightwater, our demo insurer.
     Its own three-page form, unchanged.";
   - add a Replay control at the foot of the steps, shown once the run ends.
3. **Four steps.** One row: "Twenty minutes. No developer." left, four columns
   right separated by hairlines, a mono number, a title and at most seven
   words each. Keep the measured time as the only figure.
4. **The tag.** One bordered row: "One tag. Nothing else changes." and the
   snippet.
5. **Building an agent?** One row: heading, 5.6× and $0.00 with a six-word
   caption each, and "Read the spec". The benchmark table and the 73.9% /
   98.6% tiles move to the method page it links to.
6. **Talk to us** form, unchanged in content, restyled.
7. Footer: one line left (Usher · Apache-2.0 · built by Looma), links right.
   Drop the Looma wordmark block.

Remove `pillarsSection`. Its three claims are already made by the example's
steps.

## 6. Owner pages

The mockups cover Tasks, a task, Rules and Activity. Look, Publish, the map
viewer and the walkthrough follow the same rules; nothing in them changes
structurally except as noted.

- **Dashboard home** becomes Tasks: h1 is the site's name, a line of status
  under it, the app's address in mono with "Add to an assistant". The setup
  strip is one row of five ticks with the joined-to-published time at the
  right. One row per task showing live state, tool name and today's use.
  Under it, two panels side by side: today's explanation (dark panel, with a
  link to Activity) and the owner's rules quoted (light panel, link to
  Rules). Spend for the month, keys and the off switch as one line at the foot.
- **A task.** Step tiles in one row, the final step dashed and labelled as the
  person's. One table per step: Question, Who decides, Notes, Change. The
  person-confirms row is tinted `--cons-bg`. "How assistants see it" and
  "When it finishes" side by side. Usage today at the foot.
- **Rules.** Two columns. Left: the rules quoted large on a dark panel, then
  the page-by-page table with the hour limit as its foot. Right, sticky:
  "Change your rules" with a textarea, a Propose button, the sentence "About
  45 seconds. Nothing changes until you apply it.", and the last proposal
  with a link to the history. The floating "Change your rules" pill goes.
- **Activity.** Four stat tiles in one row. "What agents are doing" as a dark
  panel with the time it was written and "Write it again". Sessions as one
  table: When, Assistant, Task, Outcome (with the state square), Steps. The
  hosted-id suffix after the assistant's name is dropped from the table and
  kept on the session page. Refused as a dashed empty-state panel with the
  sentence from the mockup.
- **Walkthrough and map viewer.** Same shell. The conversation keeps its
  bubbles but in the stage colours; the page screenshot's labels use the
  state pair.

Wording changes that ride along: "for each assistant" not "for each agent" in
the rate-limit line; "Agent fills" and "Person confirms" everywhere the two
states are named.

## 7. Phone width

Everything in the mockups wraps at 390px without sideways scroll: the header
nav wraps under the mark, tab rows wrap, grids collapse to one column at
under 720px, tables sit in an `overflow-x: auto` box with a 720px minimum
width, and the site's host in the header truncates with an ellipsis. This
fixes the overflow finding from the usability review. Touch targets stay at
44px or more; the small-button variant is for desktop only.

## 8. Order of work

1. Tokens and type in `html.ts`, fonts served, favicon. Every page changes at
   once and most of the AI feel goes with this step alone.
2. Remove `.label`, `.notice`, the pillar cards and the card-in-card nesting
   in `dashboard.ts`, `status.ts`, `card-page.ts`.
3. The front page as in section 5.
4. Tasks, task, Rules, Activity as in section 6.
5. Look, Publish, viewer, walkthrough, sign-up and admin pages: the shell and
   components only.
6. Phone width pass against the review's screenshots.

Steps 1 and 2 are safe before the demo and reversible in one commit. Steps 3
onwards are a second PR.

## 9. Out of scope

The theme preview's example content, the mapping-run spinner bug, the Propose
POST and the other findings in `reports/usability-2026-11-03/REPORT.md` are
separate work and not part of the look.
