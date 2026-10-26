# Hackathon work statement

Usher is an entry in the **Meta Global AI Developer Hackathon** (Startups track, problem statement: Push the Frontier).

- Building period: 26 October 2026 (kickoff) to 4 November 2026
- Repository created: 26 October 2026, after kickoff

## What was built during the hackathon

**Everything in this repository.** No code, specifications or data here existed before the hackathon. The repository started empty apart from the licence file, and the commit history is the record of the work.

Looma has an existing consumer app that automates car insurance quote journeys. **None of its code, plans or insurer data is in this repository, and none of it appears in the demo.** Usher is a new, general-purpose system; insurance is used only as an example of a hard, multi-step form.

## Meta models used

| Job | Model |
| --- | --- |
| Compile forms into maps (semantic labels, risk, conditions) | Muse Spark `muse-spark-1.3` (Meta Model API): strict structured output from the extraction plus a screenshot. In use. |
| Turn site rules written in plain English into a policy file | Muse Spark `muse-spark-1.3`, strict structured output, validated against the policy schema and the never-looser check. In use. |
| Explain agent sessions to site owners | Muse Spark `muse-spark-1.3`, or Muse Spark Open on Baseten for self-hosters (`--explain-open`); code computes the facts, the model writes 1 to 3 sentences. In use. |
| Flag consequential fields and actions: a second opinion on every element's risk; disagreements keep the stricter risk and are flagged | Muse Spark Open on Baseten (open weights). In use: 95.6% agreement with Muse Spark on the mock site, 90% on five public forms ([report](reports/classifier-agreement.md)). |
| Reference agent's fallback when a page has no map: labels the page, then acts on it | Muse Spark `muse-spark-1.3`. In use. |
| Keeper triage: is a changed form's change cosmetic or real, and did anything consequential change? Cheap, so only real changes reach Muse Spark | Muse Spark Open on Baseten. In use: $0.004 to $0.005 per changed form; unchanged forms cost nothing. |
| Second, independent agent using the registry (and its fallback when a page has no map) | Muse Spark Open on Baseten (`meta-models/muse-spark-open-1026`; JSON mode, schema in the prompt). In use. |

This table is updated as the build progresses.

## Build log

| Date | Work |
| --- | --- |
| 26 Oct | Repository, map schema spec and vocabulary, mock quote site |
| 26 Oct | Workspace and test runner; form extractor, locators and usher-fp-1 fingerprint |
| 26 Oct | Vocabulary as data, label validator and map merge (LU-49) |
| 26 Oct | Muse Spark map compiler with request log, CLI and recorded fixtures (LU-19) |
| 26 Oct | Knock protocol spec (LU-14); Ed25519 tokens and signed agent requests (LU-22) |
| 26 Oct | Registry over HTTP and MCP with fingerprint matching, sessions and drift (LU-21, LU-23) |
| 26 Oct | Server-side check (LU-26) and one-tag site script (LU-25) on the mock site |
| 26 Oct | Reference agent with a Muse Spark fallback; end-to-end test and first benchmark (LU-28, LU-29) |
| 26 Oct | Knock loop fixes: no drift beacons, site keys, threshold 0.3, edges on shared maps |
| 26 Oct | Second agent on Muse Spark Open via Baseten (LU-30) |
| 26 Oct | Policy format (LU-15) and plain-English rules with Muse Spark, enforced at knock, in the page and on the server (LU-32) |
| 26 Oct | Map viewer (LU-38) and site dashboard (LU-37), server-rendered by the registry; blocked attempts recorded |
| 26 Oct | Session explanations on the dashboard with Muse Spark or Spark Open (LU-34) |
| 26 Oct | Field-risk classifier on Muse Spark Open as a second opinion in the compiler (LU-33) |
| 27 Oct | Postgres storage, Docker images and compose, deployment hardening, DEPLOY.md (LU-52) |
| 27 Oct | Accuracy evaluation and review workflow; mock site and five public forms (LU-50) |
| 27 Oct | Drift rebuilds and the keeper: Spark Open triage, Muse Spark recompile, map versions (LU-42, LU-51) |
| 27 Oct | Plans across steps with get_plan; pre-flight validation and structured errors for agents (LU-40) |
| 27 Oct | Benchmark harness: raw pages vs maps vs plans, both agents, mock site and a public form (LU-41) |
