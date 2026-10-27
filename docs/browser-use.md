# Browser Use with Usher

[Browser Use](https://github.com/browser-use/browser-use) 0.13.14, a general-purpose browser agent, unmodified, running on Muse Spark (`muse-spark-1.3`) through the Meta Model API. Usher's MCP server, `npx @usher-run/mcp`, is registered as tools. The task: complete the Brightwater car insurance quote against the live registry. One run each way, on 27 October; `usher_fill` is measured below as it lands. Runner: [`examples/browser-use/run.py`](../examples/browser-use/run.py). Raw results: [`results.jsonl`](../examples/browser-use/results.jsonl).

## Results

| | Without Usher | With Usher as plain MCP tools |
| --- | --- | --- |
| Completed the quote | yes (`/quote/result`) | yes (£308.70 a year, ref. BW-CFD9FAD4) |
| Time | **124 s** | **424 s** |
| Steps (cap 60) | 27 | 60 |
| Knocks | 0 | 18 (4 would do) |

**As plain MCP tools, Usher made Browser Use slower, because the agent still read every page.** Browser Use's model reads and acts on each page itself whatever it's given. The knock, binding the pass and re-knocking (when the map fell out of its running memory) were all steps on top of that reading, never instead of it. Usher's own agent fills the same quote in about 2.7 s on the map against about 14 s reading the pages (`reports/benchmark.md`), because it fills by the map in code. The next step, `usher_fill`, gives any agent that.

## What the site saw

The dashboard shows Browser Use's agent as a **verified identity** (Web Bot Auth: the MCP server signs every knock with its key).

**Session `s_C9kFM5KvFGZyAwML`**, after the agent bound its pass, logged 26 events, with no values:
- every field on "About you" and "Your car", by semantic key: `site:fill:person.first_name`, `site:select:person.occupation`, `site:choose:person.claims.has_any`, `site:fill:vehicle.registration` and the rest;
- both "Continue" presses (`site:submit:nav.next`);
- the knocks.

**The cover step wasn't logged.** The agent knocked again there but didn't bind the new pass before filling. Its other knocks opened twelve more sessions, with one event each.

**Without Usher**, Browser Use doesn't identify itself as an agent. The demo site treats it as a person, so it gets through, and the site sees nothing.

## Why "with Usher" was slower

From the run log:
1. **The map didn't stay in the agent's memory.** Browser Use keeps a short running summary between steps. The map, every field with its key, label and risk, is too long for that, so the agent noted "map details not retained" and knocked again for it, several times per page.
2. **The pass is a long string the model has to copy.** Binding means the model writes `window.usher.bind("<token>")` with a token of about 600 characters. One attempt failed on a quoting error and led to another knock.
3. **Session continuity is left to the model.** Knocks that don't pass the earlier session id start new sessions.
4. **Muse Spark sometimes answered in prose** where Browser Use expected JSON. That happened equally in both runs, so it isn't down to Usher.

## What would make Usher pay off for agents like this

These are changes to Usher, not to Browser Use:
- **A short bind code.** Knock returns a short handle alongside the token, and the site script exchanges it with the registry. Copying 12 characters is reliable where 600 isn't.
- **A compact map view for language-model agents:** label → key → risk, one line each, without locators. It fits in a running summary.
- **A `fill_plan` tool:** from the map and the user's data by key, return the actions to take, so the agent doesn't re-derive them every step.
- **Session continuity by default:** the MCP server remembers the session per origin and passes it on the next knock.

Each of these removes model steps. The win Usher already shows comes from an agent that doesn't spend model steps on the form at all.

## Reproduce

```bash
python3.13 -m venv .venv && .venv/bin/pip install -r examples/browser-use/requirements.txt
cd /tmp && /path/to/Usher/.venv/bin/python /path/to/Usher/examples/browser-use/run.py --mode both
```

Run it from outside the repository: inside it, `npx` resolves `@usher-run/mcp` to the local workspace copy rather than the published package. `MODEL_API_KEY` comes from the environment or the repository's `.env`. `CHROME_PATH` picks the browser if Browser Use doesn't find one. The driver is fictional (`packages/agent/profiles/test-driver.json`).
