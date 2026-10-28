# Benchmark

Generated 2026-10-28 by `packages/agent/scripts/benchmark.ts`, 5 runs per row.

## Method

- **Journeys.** The mock quote site's three steps, submitted (the quote is made up), and a real public single-page form, [httpbin.org/forms/post](https://httpbin.org/forms/post), filled but never submitted (a dry run stops before its submit).
- **Configurations.** (a) The agent reads each page with its model (extraction and a screenshot, labelled as the compiler does) and acts on that, without Usher: no knock, nothing shared. (b) The agent uses maps: on the mock site, which runs Usher, by knocking; on httpbin, which does not, by looking the map up in the registry by fingerprint (no token). (c) The agent first gets a plan for the journey and checks its data against it, then uses the maps.
- **Agents.** Agent A falls back to Muse Spark over HTTP; Agent B to Muse Spark Open, talking to the registry over MCP. In (b) and (c) neither calls a model.
- **Model responses** are replayed from recordings at the latency they had when recorded, so wall time and model time reflect real model calls without spending on every run. Tokens and cost are the recorded calls' usage. Rows marked live include one live run, listed separately.
- **Success**: the run completed (for the dry run: every value filled, nothing submitted). Medians with the range in brackets. In replayed rows each recording's latency is fixed, so the spread is the agent and browser's own variation; the live rows show real model latency, which varies more.

## Results (replayed runs)

| Journey | Configuration | Agent | Success | Wall time | Model time | Tokens in / out | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mock quote site, 3 steps, submitted | (a) reads pages, no Usher | Agent A (Muse Spark, HTTP) | 5/5 | 13.82 s (13.79 s–13.83 s) | 13.04 s (13.04 s–13.04 s) | 14704 / 3512 | $0.0333 |
| Mock quote site, 3 steps, submitted | (a) reads pages, no Usher | Agent B (Muse Spark Open, MCP) | 5/5 | 22.42 s (22.41 s–22.46 s) | 21.68 s (21.68 s–21.69 s) | 15157 / 2488 | $0.0214 |
| Mock quote site, 3 steps, submitted | (b) maps via knock / lookup | Agent A (Muse Spark, HTTP) | 5/5 | 2.91 s (2.91 s–2.97 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| Mock quote site, 3 steps, submitted | (b) maps via knock / lookup | Agent B (Muse Spark Open, MCP) | 5/5 | 2.85 s (2.76 s–2.94 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| Mock quote site, 3 steps, submitted | (c) plan, then maps | Agent A (Muse Spark, HTTP) | 5/5 | 2.85 s (2.83 s–2.90 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| Mock quote site, 3 steps, submitted | (c) plan, then maps | Agent B (Muse Spark Open, MCP) | 5/5 | 2.86 s (2.76 s–2.89 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| httpbin.org/forms/post, 1 page, filled not submitted | (a) reads pages, no Usher | Agent A (Muse Spark, HTTP) | 5/5 | 12.19 s (12.17 s–12.20 s) | 11.75 s (11.75 s–11.76 s) | 3769 / 2206 | $0.0100 |
| httpbin.org/forms/post, 1 page, filled not submitted | (a) reads pages, no Usher | Agent B (Muse Spark Open, MCP) | 5/5 | 9.93 s (9.90 s–9.94 s) | 9.41 s (9.40 s–9.42 s) | 3920 / 1920 | $0.0108 |
| httpbin.org/forms/post, 1 page, filled not submitted | (b) maps via knock / lookup | Agent A (Muse Spark, HTTP) | 5/5 | 2.46 s (2.44 s–2.47 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| httpbin.org/forms/post, 1 page, filled not submitted | (b) maps via knock / lookup | Agent B (Muse Spark Open, MCP) | 5/5 | 2.47 s (2.46 s–2.52 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| httpbin.org/forms/post, 1 page, filled not submitted | (c) plan, then maps | Agent A (Muse Spark, HTTP) | 5/5 | 2.44 s (2.44 s–2.46 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |
| httpbin.org/forms/post, 1 page, filled not submitted | (c) plan, then maps | Agent B (Muse Spark Open, MCP) | 5/5 | 2.48 s (2.46 s–2.49 s) | 0.00 s (0.00 s–0.00 s) | 0 / 0 | $0.0000 |

No live runs in this report: every run replayed recorded responses.
