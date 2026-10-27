# Fine-tuning a small labeller

Muse Spark labels whole forms well, but most of what it does per element is routine: "First name" is `person.first_name`, and "Get my quote" is `form.submit` and consequential. A small open-weights model tuned on Muse Spark's own labels could do that part cheaply, and could run beside a self-hosted registry. That model would be Muse Glimmer, LoRA-tuned. This page covers the dataset, how the tuning would run, and how to score the result. **No training has been run.**

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

From this machine's compiler log on 26 October, after the live accuracy run over `evals/forms.json` (23 of 34 pages compiled; the rest refuse automated browsers, render their form with script only, or failed validation):

| | |
| --- | --- |
| Labelling calls by Muse Spark | 133 (11 failed validation) |
| Element examples before de-duplication | 316 |
| **Unique examples** | **161** (2 elements labelled two ways, settled by majority) |
| Train | 120, from 12 forms |
| Eval | 41, from 6 forms: the mock site's cover step, GOV.UK contact and site search, ICO, Churchill, Eventbrite |
| By source | mock quote site 62, Direct Line 24, GOV.UK 23, httpbin 11, Travelodge 11, Aviva 8, National Rail 4, Wikipedia 3, Admiral 3, Churchill 3, and 2 or fewer each from Mozilla, ICO, NHS, BBC, Eventbrite |
| By risk | safe 148, consequential 8, needs_user 5 |

That is still far too few to tune on. It shows the pipeline, not a training set. Consequential and needs_user elements are rare, and they are the ones that matter. Growing it means more forms: more entries in `evals/forms.json` (`npm run accuracy -- --forms all --live`, about $0.01 a form), plus the keeper's recompiles and the map viewer, which write to the same log. A few hundred forms would give a few thousand elements. Before tuning, oversample the consequential and needs_user examples, or weight them.

## Tuning Muse Glimmer with LoRA

The task is narrow (one JSON object of two fields out) and the prompt is fixed, so a low-rank adapter on the attention projections is enough. A reasonable first run:

- **LoRA:** rank 16, alpha 32, dropout 0.05, on the q, k, v and o projections.
- **Training:** 3 epochs, learning rate 1e-4 with a short warmup, sequence length 1,024. The system prompt with the vocabulary is about 2,600 characters; an element is a few hundred more.
- **Loss on the assistant turn only**, so the model learns the answer, not the prompt.
- **Base model:** Muse Glimmer's published open weights. Use the non-contributor licence terms, as everywhere in Usher.

### On Fireworks

Fireworks runs supervised fine-tuning as a managed job on chat-format JSONL, which is exactly `train.chat.jsonl`.

1. Upload the dataset: `firectl create dataset usher-labels data/finetune/train.chat.jsonl`.
2. Start the job against the Muse Glimmer base Fireworks lists, with the LoRA settings above and `eval.chat.jsonl` as the evaluation set. Check the flag names against the current `firectl` documentation.
3. Deploy the resulting adapter on a serverless or on-demand deployment. It is called through Fireworks' OpenAI-compatible endpoint, the same shape as the model client in `packages/core/src/compile/model.ts`. Adding Fireworks there means one more provider entry.

### On Modal

On Modal you run the training yourself on a rented GPU, with full control:

1. Write a Modal function on one A100 or H100 with `transformers`, `peft` and `trl` installed. It pulls the base weights into a Modal volume once.
2. Upload `data/finetune/` to the volume, and run TRL's `SFTTrainer` with a `LoraConfig` matching the settings above, on the chat-format files with completion-only loss.
3. Save the adapter to the volume. Serve it with vLLM on Modal behind an OpenAI-compatible endpoint, or merge it into the base for a single artefact.

Either way, the tuned model would be a third provider for the classifier step. That step already takes a second opinion on risk from Muse Spark Open (see `packages/core/src/compile/classify.ts`), and the compiler's reconciliation keeps the stricter risk. A small model that under-calls risk can't make a map less safe.

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

Results on the 41 held-out elements (live on 27 October). Both models see one element at a time here; the reference labels came from Muse Spark seeing the whole form with a screenshot, on 26 October.

### The short list

Before the model labels anything, code proposes candidates for each element: the vocabulary keys whose meaning is closest to its label, best first (`packages/core/src/compile/shortlist.ts`). Words in the label, options and placeholder are matched against each key's meaning, its own words and the usual ways sites say it; the control type and the HTML `autocomplete` token add a nudge. Fields get up to six field keys, or none when nothing matches. An action gets the action keys it has words in common with, plus `ui.expand` when it is a button, because a button labelled by its content (an FAQ question, a cover feature) usually reveals more. A link with nothing in common gets none, because it usually leads somewhere else.

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

A tuned Muse Glimmer would need to match the untuned models' key accuracy with no risk under-calls, outside search, to earn its place.
