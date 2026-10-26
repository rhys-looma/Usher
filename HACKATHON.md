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
| Compile forms into maps (semantic labels, risk, conditions) | Muse Spark (Meta Model API) |
| Turn site rules written in plain English into a policy file | Muse Spark |
| Explain agent sessions to site owners | Muse Spark |
| Flag consequential fields and actions | Muse Glimmer / Muse Spark Open (open weights) |
| Second, independent agent using the registry | Muse Spark Open |

This table is updated as the build progresses.

## Build log

| Date | Work |
| --- | --- |
| 26 Oct | Repository, map schema spec and vocabulary, mock quote site |
| 26 Oct | Workspace and test runner; form extractor, locators and usher-fp-1 fingerprint |
