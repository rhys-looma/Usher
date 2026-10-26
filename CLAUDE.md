# Usher

An open protocol and script tag that lets websites control AI agents on their forms, and gives agents a fast, trusted way in. Built for the Meta Global AI Developer Hackathon (building period 26 Oct – 4 Nov 2026, deadline 02:00 UK Thu 5 Nov). See README.md and HACKATHON.md.

## How it works

- Agents read anything; forms unlock when an agent **knocks**.
- The registry returns a **map** of the form (structure only), the site's **rules** and a short-lived **token**.
- A site script logs agent sessions. A server-side check enforces the token on consequential submits.
- Meta models: Muse Spark compiles maps, turns plain-English rules into policy and explains sessions to site owners. Muse Glimmer / Muse Spark Open (open weights) classify field risk.

## Rules (non-negotiable)

- All code is new work during the hackathon. Never copy anything from Looma's other codebases; no insurer plans or data.
- Commits are authored by Rhys only. No Co-Authored-By lines, no "Generated with" lines, no AI attribution anywhere in commits, PRs, code comments or docs.
- Maps hold structure, never values. Never read, log or store what anyone typed. Extraction must not read `.value` of inputs.
- The model labels, the code locates. Models never write selectors.
- Keep dependencies minimal. TypeScript strict.
- Licence: Apache-2.0 for code; specs in `spec/` are CC BY 4.0.
- Work on a branch, small commits, open a PR at the end for Rhys to merge.

## Repo layout

| Path | What |
| --- | --- |
| `spec/` | Map spec (`map.md`), JSON Schema (`map.schema.json`, draft 2020-12), vocabulary, example maps |
| `packages/core/` | Extractor, locators, fingerprint, labels, map compiler (TypeScript) |
| `packages/core/test/` | node:test suites; browser tests use Playwright (chromium) |
| `examples/mock-quote-site/` | Fictional three-step quote form (Brightwater Motor), no dependencies |
| `scripts/` | `test.mjs` and `record-fixtures.mjs` run with the mock site (A and B) started on free ports |
| `packages/registry/` | Registry: knock, maps (lookup by fingerprint), sessions, runs, drift; HTTP (`src/http.ts`) and MCP (`src/mcp.ts`); JSON-file storage |
| `data/compiler-log/` | Gitignored JSONL of every model request and response (future fine-tuning set) |

## Core package

- `src/extract.ts`: `extractForms()` runs **inside the page**. It must stay self-contained (no runtime imports, all helpers inside the function) so it works through `page.evaluate` and inside the site script bundle.
- `src/locators.ts`: `locatorKit()`, also in-page and self-contained. Builds locators (id, name, label, role, placeholder, css) and keeps only those resolving to exactly one element.
- `src/fingerprint.ts`: `usher-fp-1` signature and digest via WebCrypto, plus Jaccard `similarity`.
- `src/inpage.ts`: builds the scripts passed to `page.evaluate`.
- `src/vocabulary.ts`: vocabulary as data. `spec/vocabulary.md` is the source; `npm run vocabulary` regenerates `spec/vocabulary.json` and a test keeps them in sync.
- `src/labels.ts`: the `Labels` a labeller returns (meaning only) and `validateLabels()`, which returns structured errors to feed back to a model, clamps risk to key defaults and drops hidden unconditioned fields (honeypots).
- `src/map.ts`: `mergeMap()` joins extraction, locators, fingerprint and validated labels into a schema-valid map.
- `src/compile/`: the Muse Spark compiler. `model.ts` (fetch client, prices, refuses `-contributor` models), `prompt.ts` (system prompt, per-page strict schema), `compile.ts` (page → map, one retry with validation errors), `log.ts`, `cli.ts`.

## Model API

- `MODEL_API_KEY` from the environment or `.env` (gitignored). Never log, print or commit it.
- Model `muse-spark-1.3`, override with `USHER_COMPILER_MODEL`. Never a `-contributor` variant: those let Meta train on our content.
- Tests replay `packages/core/test/fixtures/labels/`. A prompt change makes them stale: re-record with `npm run fixtures:record`.

## Running

Node 20+.

```sh
npm install
npm test             # installs chromium if needed, starts mock site (A and B) on free ports, runs tests
npm run typecheck
npm run compile -- <url> [--out file]   # compile one page with Muse Spark
npm run fixtures:record                 # re-record model fixtures (needs MODEL_API_KEY)
npm run registry -- --seed mock-site    # registry on :4200 with the mock-site maps (data in data/registry)
npm run seed:build                      # rebuild seed maps from recorded labels
USHER_LIVE=1 npm test                   # also run the live model test
```

Mock site on its own:

```sh
cd examples/mock-quote-site && npm start      # http://localhost:4100, /__admin switches layout A/B
VARIANT=b npm start                           # start in layout B
```

Steps 2 and 3 need the previous steps submitted in the same session; the test helpers post them first.
