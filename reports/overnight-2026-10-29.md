# Overnight run, 28–29 October 2026

A running log: what shipped, timings, spend, what was cut and why. Newest at the bottom of each part.

## Precondition

The site changes were already merged and live before the run started: Brightwater Health ([#81](https://github.com/rhys-looma/Usher/pull/81)), the six steps and "What Usher keeps" (#83, #85, #91), health examples everywhere, the site deciding on medical answers (#90).

## Part 0: voting compiler

- `packages/core/src/compile/vote.ts`: up to three runs. The first labels the whole page. The second asks only about contested elements (more than one strong short-list candidate, or labelled consequential or needs_user). The third asks only about those the first two disagree on, or that either labelled risky. Majority per element; a risk tie takes the stricter risk, a key tie the short list's top candidate, else `custom.<slug>`.
- Agreement counts per element (runs, how many agreed on the key and the risk) go in the compile log (`task: vote_result`) and the map's `provenance.votes` (schema updated). Counts only.
- The keeper and the eval runner (`accuracy.ts`) use vote mode; the CLI stays single-pass (`--vote` to opt in).
- **Before/after against the human marks** (`reports/vote-eval.md`, `packages/core/scripts/vote-eval.ts`, $0.57 live). The 13 public forms of the complete marked run (69 elements) were compiled again, once with one run and once in vote mode, and each element was matched to its marked row by label. One run: 37 of 48 matched keys right (77.1%), 47 risks (97.9%). Vote mode: 39 of 50 (78%), 49 risks (98%). Vote mode changed none of the marked keys, so there is nothing new to mark. Both modes have the same 9 regressions against the 27 October marks: the model answers those differently today, with or without a vote. So on these forms vote mode is level on accuracy; what it adds is the per-element agreement counts, which show where to look. Vote runs per form: 1 to 3 (5 forms needed only one).
- Also in this PR, as groundwork for Part W: an optional `box` on map elements (position and size only), kept only when a compile asks for it (`boxes: true`).
- The keeper's test now expects the recompile to be followed by up to two vote runs.
