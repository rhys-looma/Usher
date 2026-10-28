# Benchmark

Generated 2026-10-28 by `packages/agent/scripts/benchmark.ts`, 5 runs per row.

## Method

- **Journeys.** The mock site's two quotes, Brightwater Health and the car quote ("Mock quote site"), three steps each, submitted (the quotes are made up), and a real public single-page form, [httpbin.org/forms/post](https://httpbin.org/forms/post), filled but never submitted (a dry run stops before its submit).
- **Configurations.** (a) The agent reads each page with its model (extraction and a screenshot, labelled as the compiler does) and acts on that, without Usher: no knock, nothing shared. (b) The agent uses maps: on the mock site, which runs Usher, by knocking; on httpbin, which does not, by looking the map up in the registry by fingerprint (no token). (c) The agent first gets a plan for the journey and checks its data against it, then uses the maps.
- **Agents.** Agent A falls back to Muse Spark over HTTP; Agent B to Muse Spark Open, talking to the registry over MCP. In (b) and (c) neither calls a model.
- **Model responses** are replayed from recordings at the latency they had when recorded, so wall time and model time reflect real model calls without spending on every run. Tokens and cost are the recorded calls' usage. Rows marked live include one live run, listed separately.
- **Success**: the run completed (for the dry run: every value filled, nothing submitted). Medians with the range in brackets. In replayed rows each recording's latency is fixed, so the spread is the agent and browser's own variation; the live rows show real model latency, which varies more.

## Results (replayed runs)

| Journey | Configuration | Agent | Success | Wall time | Model time | Tokens in / out | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Brightwater Health, 3 steps, submitted | (a) reads pages, no Usher | Agent A (Muse Spark, HTTP) | 4/4 | 17.09 s (17.08 s–17.09 s) | 16.12 s (16.12 s–16.14 s) | 13349 / 3176 | $0.0302 |
| Brightwater Health, 3 steps, submitted | (a) reads pages, no Usher | Agent B (Muse Spark Open, MCP) | 4/4 | 62.82 s (62.81 s–62.84 s) | 61.85 s (61.84 s–61.87 s) | 13802 / 2615 | $0.0236 |
| Brightwater Health, 3 steps, submitted | (b) maps via knock / lookup | Agent A (Muse Spark, HTTP) | 5/5 | 3.07 s (3.05 s–3.11 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| Brightwater Health, 3 steps, submitted | (b) maps via knock / lookup | Agent B (Muse Spark Open, MCP) | 5/5 | 3.07 s (3.04 s–3.11 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| Brightwater Health, 3 steps, submitted | (c) plan, then maps | Agent A (Muse Spark, HTTP) | 5/5 | 3.05 s (3.04 s–3.07 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| Brightwater Health, 3 steps, submitted | (c) plan, then maps | Agent B (Muse Spark Open, MCP) | 5/5 | 3.06 s (3.06 s–3.08 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| Mock quote site, 3 steps, submitted | (a) reads pages, no Usher | Agent A (Muse Spark, HTTP) | 4/4 | 17.42 s (17.39 s–17.46 s) | 16.65 s (16.65 s–16.65 s) | 15333 / 3904 | $0.0358 |
| Mock quote site, 3 steps, submitted | (a) reads pages, no Usher | Agent B (Muse Spark Open, MCP) | 4/4 | 24.12 s (24.09 s–24.14 s) | 23.34 s (23.33 s–23.34 s) | 15786 / 2512 | $0.0239 |
| Mock quote site, 3 steps, submitted | (b) maps via knock / lookup | Agent A (Muse Spark, HTTP) | 5/5 | 2.88 s (2.75 s–2.90 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| Mock quote site, 3 steps, submitted | (b) maps via knock / lookup | Agent B (Muse Spark Open, MCP) | 5/5 | 2.90 s (2.87 s–2.91 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| Mock quote site, 3 steps, submitted | (c) plan, then maps | Agent A (Muse Spark, HTTP) | 5/5 | 2.89 s (2.74 s–2.89 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| Mock quote site, 3 steps, submitted | (c) plan, then maps | Agent B (Muse Spark Open, MCP) | 5/5 | 2.92 s (2.88 s–2.93 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| httpbin.org/forms/post, 1 page, filled not submitted | (a) reads pages, no Usher | Agent A (Muse Spark, HTTP) | 4/4 | 11.22 s (11.19 s–11.39 s) | 10.69 s (10.68 s–10.69 s) | 3953 / 1552 | $0.0115 |
| httpbin.org/forms/post, 1 page, filled not submitted | (a) reads pages, no Usher | Agent B (Muse Spark Open, MCP) | 4/4 | 7.77 s (7.74 s–7.78 s) | 7.24 s (7.22 s–7.24 s) | 4104 / 1249 | $0.0079 |
| httpbin.org/forms/post, 1 page, filled not submitted | (b) maps via knock / lookup | Agent A (Muse Spark, HTTP) | 5/5 | 2.53 s (2.50 s–2.54 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| httpbin.org/forms/post, 1 page, filled not submitted | (b) maps via knock / lookup | Agent B (Muse Spark Open, MCP) | 5/5 | 2.57 s (2.56 s–2.59 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| httpbin.org/forms/post, 1 page, filled not submitted | (c) plan, then maps | Agent A (Muse Spark, HTTP) | 5/5 | 2.53 s (2.51 s–2.56 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| httpbin.org/forms/post, 1 page, filled not submitted | (c) plan, then maps | Agent B (Muse Spark Open, MCP) | 5/5 | 2.55 s (2.53 s–2.57 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |

## Live runs

| Journey | Configuration | Agent | Outcome | Wall time | Model time | Tokens in / out | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Brightwater Health, 3 steps, submitted | (a) reads pages, no Usher | Agent A (Muse Spark, HTTP) | completed | 21.81 s | 20.76 s | 13349 / 3317 | $0.0308 |
| Brightwater Health, 3 steps, submitted | (a) reads pages, no Usher | Agent B (Muse Spark Open, MCP) | failed | 86.95 s | 25.95 s | 10483 / 1691 | $0.0089 |
| Mock quote site, 3 steps, submitted | (a) reads pages, no Usher | Agent A (Muse Spark, HTTP) | completed | 26.86 s | 26.08 s | 15333 / 3650 | $0.0347 |
| Mock quote site, 3 steps, submitted | (a) reads pages, no Usher | Agent B (Muse Spark Open, MCP) | failed | 60.27 s | 0.00 s | 0 / 0 | $0.0000 |
| httpbin.org/forms/post, 1 page, filled not submitted | (a) reads pages, no Usher | Agent A (Muse Spark, HTTP) | completed | 11.17 s | 10.64 s | 3953 / 1552 | $0.0115 |
| httpbin.org/forms/post, 1 page, filled not submitted | (a) reads pages, no Usher | Agent B (Muse Spark Open, MCP) | completed | 7.77 s | 7.18 s | 4104 / 1249 | $0.0079 |
