# Benchmark

Generated 2026-10-26 by `packages/agent/scripts/benchmark.ts`, 5 runs per row.

## Method

- **Journeys.** The mock quote site's three steps, submitted (the quote is made up), and a real public single-page form, [httpbin.org/forms/post](https://httpbin.org/forms/post), filled but never submitted (a dry run stops before its submit).
- **Configurations.** (a) The agent reads each page with its model (extraction and a screenshot, labelled as the compiler does) and acts on that, without Usher: no knock, nothing shared. (b) The agent uses maps: on the mock site, which runs Usher, by knocking; on httpbin, which does not, by looking the map up in the registry by fingerprint (no token). (c) The agent first gets a plan for the journey and checks its data against it, then uses the maps.
- **Agents.** Agent A falls back to Muse Spark over HTTP; Agent B to Muse Spark Open, talking to the registry over MCP. In (b) and (c) neither calls a model.
- **Model responses** are replayed from recordings at the latency they had when recorded, so wall time and model time reflect real model calls without spending on every run. Tokens and cost are the recorded calls' usage. Rows marked live include one live run, listed separately.
- **Success**: the run completed (for the dry run: every value filled, nothing submitted). Medians with the range in brackets. In replayed rows each recording's latency is fixed, so the spread is the agent and browser's own variation; the live rows show real model latency, which varies more.

## Results (replayed runs)

| Journey | Configuration | Agent | Success | Wall time | Model time | Tokens in / out | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mock quote site, 3 steps, submitted | (a) reads pages, no Usher | Agent A (Muse Spark, HTTP) | 4/4 | 14.22 s (14.21 s–14.23 s) | 13.60 s (13.60 s–13.60 s) | 13702 / 3190 | $0.0307 |
| Mock quote site, 3 steps, submitted | (a) reads pages, no Usher | Agent B (Muse Spark Open, MCP) | 4/4 | 14.01 s (13.99 s–14.03 s) | 13.39 s (13.39 s–13.40 s) | 14155 / 2408 | $0.0258 |
| Mock quote site, 3 steps, submitted | (b) maps via knock / lookup | Agent A (Muse Spark, HTTP) | 5/5 | 2.68 s (2.67 s–2.72 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| Mock quote site, 3 steps, submitted | (b) maps via knock / lookup | Agent B (Muse Spark Open, MCP) | 5/5 | 2.71 s (2.69 s–2.75 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| Mock quote site, 3 steps, submitted | (c) plan, then maps | Agent A (Muse Spark, HTTP) | 5/5 | 2.69 s (2.68 s–2.71 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| Mock quote site, 3 steps, submitted | (c) plan, then maps | Agent B (Muse Spark Open, MCP) | 5/5 | 2.69 s (2.68 s–2.72 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| httpbin.org/forms/post, 1 page, filled not submitted | (a) reads pages, no Usher | Agent A (Muse Spark, HTTP) | 4/4 | 11.12 s (11.10 s–11.12 s) | 10.59 s (10.58 s–10.59 s) | 3539 / 1458 | $0.0106 |
| httpbin.org/forms/post, 1 page, filled not submitted | (a) reads pages, no Usher | Agent B (Muse Spark Open, MCP) | 4/4 | 9.56 s (9.55 s–9.62 s) | 9.03 s (9.02 s–9.03 s) | 3690 / 1857 | $0.0125 |
| httpbin.org/forms/post, 1 page, filled not submitted | (b) maps via knock / lookup | Agent A (Muse Spark, HTTP) | 5/5 | 2.53 s (2.52 s–2.54 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| httpbin.org/forms/post, 1 page, filled not submitted | (b) maps via knock / lookup | Agent B (Muse Spark Open, MCP) | 5/5 | 2.58 s (2.57 s–2.61 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| httpbin.org/forms/post, 1 page, filled not submitted | (c) plan, then maps | Agent A (Muse Spark, HTTP) | 5/5 | 2.54 s (2.52 s–2.63 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| httpbin.org/forms/post, 1 page, filled not submitted | (c) plan, then maps | Agent B (Muse Spark Open, MCP) | 5/5 | 2.58 s (2.56 s–2.59 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |

## Live runs

| Journey | Configuration | Agent | Outcome | Wall time | Model time | Tokens in / out | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mock quote site, 3 steps, submitted | (a) reads pages, no Usher | Agent A (Muse Spark, HTTP) | completed | 21.89 s | 21.23 s | 13702 / 3454 | $0.0318 |
| Mock quote site, 3 steps, submitted | (a) reads pages, no Usher | Agent B (Muse Spark Open, MCP) | completed | 16.04 s | 15.40 s | 14155 / 2539 | $0.0264 |
| httpbin.org/forms/post, 1 page, filled not submitted | (a) reads pages, no Usher | Agent A (Muse Spark, HTTP) | completed | 11.10 s | 10.57 s | 3539 / 1458 | $0.0106 |
| httpbin.org/forms/post, 1 page, filled not submitted | (a) reads pages, no Usher | Agent B (Muse Spark Open, MCP) | completed | 9.54 s | 9.02 s | 3690 / 1857 | $0.0125 |
