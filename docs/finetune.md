# A small labeller: no training first, fine-tuning ready to run

Muse Spark labels whole forms well, but most of what it does per element is routine: "First name" is `person.first_name`, and "Get my quote" is `form.submit` and consequential. A small open-weights model could do that part cheaply, beside a self-hosted registry. There are two ways to get it there:

- **No training** (built, and measured below): code proposes the candidate keys for each element (the short list), and the nearest labelled examples from other sites go into the prompt (retrieval few-shot). This works with Muse Spark Open as it is.
- **Fine-tuning** (ready to run): a LoRA-tuned Muse Glimmer on Muse Spark's labels and site owners' corrections. The export, the training script (Modal, one H100), the serving app (vLLM) and the student's place in the compiler are built and tested. The pipeline has passed a dry run on CPU; **no GPU training has been run yet**. See [Running it](#running-it).
- **Automatic retraining** (built, off): the registry retrains the student on Baseten as owners correct maps, and promotes a run only if it does no worse than the adapter serving. See [Automatic retraining](#automatic-retraining).

## The no-training path

### Retrieval few-shot

Before Muse Spark Open labels or classifies an element, the nearest labelled examples go into its prompt, as `control: "label" → key (risk)` (`packages/core/src/compile/retrieval.ts`):

- **Where they come from:** the exported training set (`data/finetune/train.jsonl`), so never from a form held out for eval. 78 distinct labelled elements in the rebuilt set (97 in the 26 October set) once repeats of the same label and key are merged.
- **Nearest:** the same kind (field or action), ranked by the words shared between labels and options (Jaccard, the same word handling as the short list), with a little extra for the same control. Only examples that share a word are used: unrelated ones mislead (a declaration tick box was being shown pizza toppings).
- **Per element:** up to five, for the per-element eval. **Per form:** the nearest few for each element without repeats, at most 40, for the whole-form labeller and the risk classifier.

It is optional everywhere: `npm run compile -- <url> --open --examples data/finetune/train.jsonl` labels with Spark Open with retrieval, `--classify --examples …` adds it to the classifier, and `npm run finetune:eval -- --model … --retrieval` measures it.

### Results

Per element on the 28 held-out elements of the set rebuilt on 27 October from today's labels (see [How many examples there are](#how-many-examples-there-are)), with the short list in every row. Three runs of each, because answers change between runs at temperature 0:

| Model | Key, exact | Key, equivalent | Risk | Risk under-called | Spend a run |
| --- | --- | --- | --- | --- | --- |
| Baseline: commonest per control | 7.1% | 7.1% | 85.7% | 4 | $0 |
| Muse Spark | 64.3 / 60.7 / 64.3% (mean 63.1%) | 75.0 / 71.4 / 75.0% (mean 73.8%) | 96.4 / 100 / 100% | 0 | $0.17 |
| Muse Spark, with retrieval | 64.3 / 64.3 / 60.7% (mean 63.1%) | 71.4 / 75.0 / 71.4% (mean 72.6%) | 100% ×3 | 0 | $0.19 |
| Muse Spark Open (`-1026`) | 60.7% ×3 | 64.3 / 67.9 / 67.9% (mean 66.7%) | 100% ×3 | 0 | $0.12 |
| Muse Spark Open (`-1026`), with retrieval | 60.7 / 60.7 / 67.9% (mean 63.1%) | 64.3 / 71.4 / 71.4% (mean 69.0%) | 100% ×3 | 0 | $0.12 |

- **Risk is right everywhere it matters.** No model under-calls a single element now that the reference labels know about `search.submit`.
- **Retrieval is a wash.** Muse Spark gains nothing, and Spark Open gains about one element on average (+2.4 points exact, +2.3 equivalent), within the spread of its own runs.
- **The key misses are mostly one page, and defensible.** Eventbrite's home page has two search boxes labelled only "autocomplete" (what and where), filter tabs ("For you", "Today", "This weekend") that the whole-form labels call `search.submit` and the per-element runs call `custom.filter_…`, and carousel arrows. The rest are GOV.UK links whose custom slugs are worded differently (`custom.help_pages` against `custom.help_pages_link`). Per element, the model can't see the screenshot that tells the whole-form run what an unlabelled box is for.

On the set from 26 October (41 elements, labels from older prompts), the same comparison gave Spark Open 65.0% exact with the short list and 63.4% with retrieval added. Only 3 elements changed then, all custom-key wording. Some of those examples were out of date (three "Search" buttons labelled `form.submit`, `custom.search` and `nav.next`), which is why the set was rebuilt from today's labels only.

Retrieval should earn its place when the log covers many more forms, and above all for custom keys that recur across sites (`custom.how_did_you_hear`), where examples are the only guide. The short list is what moved the numbers (see [The short list](#the-short-list) below).

## The dataset

```bash
npm run finetune:export
```

This reads the compiler log (`data/compiler-log/*.jsonl`, written by every labelling call, gitignored) and writes to `data/finetune/` (also gitignored):

| File | What |
| --- | --- |
| `train.jsonl`, `eval.jsonl` | One example per labelled element: `{ id, input, output, meta }` |
| `train.chat.jsonl`, `eval.chat.jsonl` | The same examples as chat messages (system, user, assistant), the format SFT services take |
| `stats.json` | The counts below, and which forms are held out |

Each example looks like this:

- **Input:** the element's label, kind and control, whether it is required, an options summary ("6 options: Mr, Mrs, Miss, Ms, Mx, Dr"), any validation constraints, the form's purpose and page title, and its neighbours (the two elements before and after it, as "control: label").
- **Output:** the semantic key and the risk.

How it is built:

- **Teacher.** Only Muse Spark's labels are used, from responses that passed the compiler's validation, with its risk floors applied. Excluded elements (hidden, with no condition) are skipped.
- **De-duplicated.** Duplicates are removed by the element's structure and neighbours. The purpose and title the model wrote vary in wording between runs, so they don't count. If the same element was labelled two ways, the commonest label wins.
- **Split by form.** Whole forms are held out until eval holds about 20% of the examples, so no eval form is ever seen in training. Layouts A and B of the same mock-site page count as one form.
- **Structure only, like the log itself.** Labels, options and constraints come from the page's markup, never from anything a person typed.

### How many examples there are

Rebuilt on 27 October from labels compiled with the current prompt only (`npm run finetune:export -- --since 2026-10-27T10:00:00Z`): the mock site's recordings and a fresh live accuracy run over `evals/forms.json`. That run compiled 19 of the 28 pages that load in an automated browser. The other 9 have no form to map: Admiral and Churchill show only a consent widget, now left out, and Direct Line's page has no visible form field.

| | |
| --- | --- |
| Labelling calls by Muse Spark | 33 (2 failed validation) |
| Element examples before de-duplication | 137 |
| **Unique examples** | **131** |
| Train | 103, from 13 forms |
| Eval | 28, from 3 forms: the mock site's cover step, GOV.UK contact, Eventbrite |
| By source | mock quote site 62, GOV.UK 23, httpbin 11, Eventbrite 9, Travelodge 6, National Rail 4, Aviva 4, and 2 each from ICO, Mozilla, Wikipedia, ONS, NHS, BBC |
| By risk | safe 124, consequential 5, needs_user 2 |

The set from 26 October (161 unique, 120 train and 41 eval) mixed labels from older prompts, before `search.submit` and the short list. It also held 24 Direct Line elements from controls outside any form, FAQ accordions beside hidden cookie toggles, with no visible field. The page is no longer mapped.

That is still far too few to tune on. It shows the pipeline, not a training set. Consequential and needs_user elements are rare, and they are the ones that matter. Growing it means more forms: more entries in `evals/forms.json` (`npm run accuracy -- --forms all --live`, about $0.01 a form), plus the keeper's recompiles and the map viewer, which write to the same log. A few hundred forms would give a few thousand elements. Before tuning, oversample the consequential and needs_user examples, or weight them.

## Scoring a model

```bash
npm run finetune:eval -- --predictions preds.jsonl   # any model's answers: lines of { "id", "key", "risk" }
npm run finetune:eval -- --model <id> [--provider baseten]   # call a model live, one element at a time, with the student's prompt
npm run finetune:eval -- --baseline                  # the commonest key and risk per control in train
```

It reports:

- key accuracy, exact and equivalent, risk accuracy, and both together. Equivalent forgives listed synonyms (`contact.phone` and `contact.mobile`), a full name against a first or last name where the form has one name field, and custom keys whose slugs match once filler words and plurals are removed (`custom.room_count` and `custom.rooms`). The rules are in `packages/core/scripts/key-equivalence.ts`;
- key misses by kind: synonym, custom wording, custom against vocabulary, or different vocabulary keys;
- risk under-calls and over-calls, separately, because an under-call means an agent acts where the site wanted its user asked;
- custom keys outside the vocabulary, and unusable answers;
- the risk confusion.

`--save` keeps the predictions and `--report` writes the table.

The short list was measured on the 26 October set (41 held-out elements), before it was rebuilt; results on the rebuilt set are [above](#results). Both models see one element at a time here; the reference labels came from Muse Spark seeing the whole form with a screenshot.

### The short list

Before the model labels anything, code proposes candidates for each element: the vocabulary keys whose meaning is closest to its label, best first (`packages/core/src/compile/shortlist.ts`). Words in the label, options and placeholder are matched against each key's meaning, its own words and the usual ways sites say it. A label word that is part of the key's own name counts half again, so "Address" ranks `address.line1` above `contact.email`, whose meaning is "Email address". The control type and the HTML `autocomplete` token add a nudge. Fields get up to six field keys, or none when nothing matches. An action gets the action keys it has words in common with, plus `ui.expand` when it is a button, because a button labelled by its content (an FAQ question, a cover feature) usually reveals more. A link with nothing in common gets none, because it usually leads somewhere else.

The prompt then says: choose the most specific candidate that fits, never invent a custom key when a vocabulary key fits, use `custom.*` only when no candidate fits, and treat `nav.next` and `form.submit` as the form's own way forward, never a link to another page. The compiler's whole-form prompt and the per-element prompt both work this way. The right key is among the candidates for every element of the mock site's maps, and for 124 of the 129 elements with vocabulary keys in train and eval. Of the 5 that aren't, four are "Search" buttons the reference labelled `form.submit` or `nav.next`, from before `search.submit` existed, and one is National Rail's "Show live trains", labelled `nav.next`.

| Per element, 41 held-out elements | Key, exact | Key, equivalent | Risk | Risk under-called | Custom keys used | Spend |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline: commonest per control | 7.3% | 7.3% | 85.4% | 6 | – | $0 |
| Muse Spark, before | 65.9% | 68.3% | 92.7% | 2 | 12 | $0.202 |
| Muse Spark, with the short list | **73.2%** | **80.5%** | **95.1%** | 2 | 16 | $0.246 |
| Muse Spark Open (`-1026`), before, two runs | 56.1% / 53.7% | 63.4% / 63.4% | 95.1% / 92.7% | 2 / 2 | 14 / 13 | $0.185 / $0.165 |
| Muse Spark Open (`-1026`), with the short list, two runs | **65.9% / 61.0%** | **70.7% / 75.6%** | 95.1% / 95.1% | 2 / 2 | 13 / 15 | $0.139 / $0.134 |

"Before" is today's prompt without candidates. On 26 October, before `search.submit` was in the vocabulary, the same prompt scored 61.0% for Muse Spark. A first version of the short list offered every action key to every action, in vocabulary order. Muse Spark then labelled three GOV.UK search-result links `nav.next` (63.4% exact); the link rule and the `ui.expand` fallback fixed that.

Spark Open's answers change between runs at temperature 0, so it is shown twice.

- **Key misses.** `npm run keys:disagreements` writes [reports/key-disagreements.md](../reports/key-disagreements.md): every element where Muse Spark's key isn't settled, between runs, per element against whole form, or against the review, grouped by kind. Before the short list, 13 of Muse Spark's 16 per-element misses were on one page, GOV.UK's search results, where links to services got a specific custom key from the whole form and `custom.search_result_link` per element. None was two different vocabulary keys.
- **The risk under-calls are the two "Search" buttons.** The reference has them as `form.submit`, consequential; both models now say `search.submit`, safe, which the vocabulary has since added. The reference is out of date there rather than the models wrong; a fresh export from labels compiled with today's prompt would fix it.

On the earlier, smaller split (30 elements from 3 forms), Spark Open scored 86.7% on keys and Muse Spark 83.3%. The forms added since are the ones with the most custom keys.

A tuned Muse Glimmer would need to match Spark Open with the short list (on the rebuilt set, about 61% of keys exact and 67% equivalent, with no risk under-called) to earn its place.

## Running it

Everything is in `deploy/finetune/` and behind `npm run finetune:*`:

| Command | What it does | Cost |
| --- | --- | --- |
| `npm run finetune:export -- [--since …] [--corrections corrections.jsonl] [--publish]` | The dataset (below). Owners' corrections outrank model labels. `--publish` writes the counts to `reports/learning.json`, which `/learning` shows | Free |
| `npm run finetune:train -- --dry-run` | One training step on 10 examples, on CPU, with a tiny stand-in model (`hf-internal-testing/tiny-random-LlamaForCausalLM`): proves the chat format, completion-only loss and the adapter save. Needs Python with `deploy/finetune/requirements.txt` (`FINETUNE_PYTHON` points at it) | Free |
| `npm run finetune:train -- --confirm-spend` | The real run on one Modal H100: fetches `meta-models/Muse-Glimmer-30B` into the `usher-finetune` volume once, trains, saves the adapter beside it | Paid: Modal GPU time |
| `npm run finetune:status` | Modal apps, and the latest run in the volume | Free |
| `npm run finetune:serve` | Deploys vLLM with the base and the latest adapter (`deploy/finetune/serve.py`), an OpenAI-compatible endpoint behind a key (Modal secret `usher-student`). Scales to zero | Paid while serving |
| `npm run finetune:stop` | Stops both apps | – |

The dry run passed on 28 October with torch 2.15, transformers 5.21, peft 0.21 and trl 1.16 (pinned in `requirements.txt`, and the Modal image installs the same): one step, loss 10.4 on the random stand-in, adapter files written. Examples are about 1,000 tokens with the vocabulary in the system prompt, so sequences are 2,048: truncation cuts from the end, which is the answer.

**Using the student.** Set `USHER_STUDENT_MODEL=usher-labeller`, `USHER_STUDENT_URL` (from `finetune:serve`) and `USHER_STUDENT_KEY`. The compiler's classifier step then asks the student about each element, with exactly the prompt and input it was trained on (`packages/core/src/compile/student.ts`, which the export also uses), in place of Muse Spark Open's whole-form opinion. As with Spark Open, the stricter risk is kept, so the student can only make a map more careful. `npm run compile -- <url> --classify` and the registry's map viewer use it when the flag is set. **It is off in production**, and should stay off until `npm run finetune:eval -- --model usher-labeller --provider student` beats Spark Open with the short list on the held-out set.

No Fireworks key was available on 28 October, so the Fireworks route below is described, not configured.

## Automatic retraining

With `USHER_AUTO_TRAIN=1` the registry retrains the student itself, on Baseten (`packages/registry/src/trainer.ts`). Once an hour it counts owners' corrections made since the last run that used its set. It starts a run only when:

- there are at least 10 new corrections (`USHER_TRAINING_MIN_CORRECTIONS`);
- the last run started at least 24 hours ago (`USHER_TRAINING_COOLDOWN_HOURS`);
- the month's GPU spend plus the next run's estimate (the last run's cost, or 45 minutes before there is one) stays within $40 (`USHER_TRAINING_MONTHLY_CAP_USD`).

**A run.** The training set is the base set plus every owner correction in the registry's log, built with the same code as the export (`packages/core/src/compile/training-set.ts`): owners' answers win, and train and eval are split by form. The base set is the export's model labels from the compiler log, sent once with `npm run training:upload-base -- <registry URL>` (admin key from the environment). The registry starts a job on one H100 through Baseten's Training API, with the base weights mounted from `hf://meta-models/Muse-Glimmer-30B` and cached by Baseten. The job fetches `train.py`, its requirements and its data from the registry with a token good for that run only, then runs `train.py --baseten`:

1. Trains the LoRA adapter (the settings below) and saves it to `$BT_CHECKPOINT_DIR`, which Baseten keeps.
2. Scores the new adapter and the adapter serving now on the same held-out examples: valid JSON, and agreement on key and on risk.
3. Posts the scores back to the registry.

**The gate.** The registry promotes the run only if its answers are valid JSON at least 90% of the time and it is no worse than the adapter serving on both key and risk. The first run has nothing to beat, so it must agree on at least 60% of keys and 80% of risks. A run still going after two hours is stopped. A failed run's corrections count towards the next one; a rejected run's do not, so the next run waits for 10 more.

**Serving.** One Baseten deployment serves every run (`deploy/baseten/student`, pushed once with `scripts/baseten-student.sh`). At each start it asks the registry which run is promoted (`GET /training/student`, with `USHER_TRAINING_SECRET`), downloads that adapter, and starts vLLM with it. On promotion the registry deactivates and reactivates the deployment, so its next start loads the new adapter. It scales to zero when idle. With retraining on, the compiler asks the student only once a run has been promoted; until then Muse Spark Open gives the second opinion. As always, the stricter risk is kept.

**Cost.** Baseten bills an H100 at $0.10833 a minute (about $6.50 an hour). A run on today's set (about 600 examples) should take 20 to 30 minutes, about $2 to $4; the job's own start and finish times are what the registry counts against the cap. Serving costs the same rate while the deployment is up, and nothing once it has scaled to zero.

**What has not been checked.** No job has run on Baseten yet. Before turning it on, run one by hand and check that Muse Glimmer 30B trains on one H100 at these settings (bf16 with gradient checkpointing; it may need a smaller batch), how long it takes, and that the deployment starts with the adapter.

**Status.** `GET /admin/training` (admin key) lists runs, the promoted run, pending corrections and the month's spend. `POST /admin/training/check` runs the hourly check now. `/learning` shows the promoted run's held-out scores.

## Tuning Muse Glimmer with LoRA

The task is narrow (one JSON object of two fields out) and the prompt is fixed, so a low-rank adapter on the attention projections is enough. A reasonable first run:

- **LoRA:** rank 16, alpha 32, dropout 0.05, on the q, k, v and o projections.
- **Training:** 3 epochs, learning rate 1e-4 with a 10-step warmup, sequence length 2,048. The system prompt with the vocabulary is about 3,000 characters; an element is a few hundred more, about 1,000 tokens in all.
- **Loss on the assistant turn only**, so the model learns the answer, not the prompt.
- **Base model:** [`meta-models/Muse-Glimmer-30B`](https://huggingface.co/meta-models/Muse-Glimmer-30B), checked on Hugging Face on 27 October: Apache-2.0, not gated, `transformers`, image-text-to-text, about 29.8 billion parameters, last updated 22 October. Meta also publishes GGUF and ExecuTorch builds and an `-assistant` variant; tune the base.
- **Data:** 212 unique examples on 28 October (168 train, 44 eval, from 19 forms), up from 131 the day before (see [How many examples there are](#how-many-examples-there-are)). That is still too few: the paid run should wait until the log holds a few thousand, with owners' corrections among them.

### On Fireworks

Fireworks runs supervised fine-tuning as a managed job on chat-format JSONL, which is exactly `train.chat.jsonl`.

1. Upload the dataset: `firectl create dataset usher-labels data/finetune/train.chat.jsonl`.
2. Start the job against `meta-models/Muse-Glimmer-30B` (or the name Fireworks lists it under), with the LoRA settings above and `eval.chat.jsonl` as the evaluation set. Check the flag names against the current `firectl` documentation.
3. Deploy the resulting adapter on a serverless or on-demand deployment. It is called through Fireworks' OpenAI-compatible endpoint, the same shape as the model client in `packages/core/src/compile/model.ts`. Adding Fireworks there means one more provider entry.

### On Modal

On Modal you run the training yourself on a rented GPU, with full control:

1. Write a Modal function on one A100 or H100 with `transformers`, `peft` and `trl` installed. It pulls the base weights into a Modal volume once.
2. Upload `data/finetune/` to the volume, and run TRL's `SFTTrainer` with a `LoraConfig` matching the settings above, on the chat-format files with completion-only loss.
3. Save the adapter to the volume. Serve it with vLLM on Modal behind an OpenAI-compatible endpoint, or merge it into the base for a single artefact.

Either way, the tuned model would be a third provider for the classifier step. That step already takes a second opinion on risk from Muse Spark Open (see `packages/core/src/compile/classify.ts`), and the compiler's reconciliation keeps the stricter risk. A small model that under-calls risk can't make a map less safe.
