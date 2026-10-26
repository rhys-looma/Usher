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

- key accuracy, risk accuracy, and both together;
- risk under-calls and over-calls, separately, because an under-call means an agent acts where the site wanted its user asked;
- custom keys outside the vocabulary, and unusable answers;
- the risk confusion.

`--save` keeps the predictions and `--report` writes the table.

Results on the 41 held-out elements, with the prompt in `packages/core/scripts/finetune-shared.ts` (live on 26 October):

| Predictions | Key | Risk | Both | Risk under-called | Spend |
| --- | --- | --- | --- | --- | --- |
| Baseline: commonest per control | 7.3% | 85.4% | 7.3% | 6 | $0 |
| Muse Spark Open, untuned, per element | 56.1% | 92.7% | 56.1% | 2 (1 more unanswered) | $0.183 |
| Muse Spark, per element | 61.0% | 92.7% | 61.0% | 2 | $0.219 |

Both models see one element at a time here, and the reference labels came from Muse Spark seeing the whole form with a screenshot.

- **Key misses.** Every miss by Muse Spark involves a `custom.*` key on one side or the other, and all but one by Spark Open. These are elements outside the vocabulary named differently (`custom.room_count` against `booking.party_size`), not wrong meanings. Exact-match key accuracy is a harsh measure for custom keys; scoring custom keys by vocabulary-or-not would be fairer.
- **The risk under-calls are all search boxes.** The "Search" buttons on ICO's and GOV.UK's site search were labelled `form.submit` and consequential by the teacher, and a safe custom key by both models. Arguably the teacher over-calls here: a site search commits to nothing. The vocabulary could say so, with a `search.submit` key that defaults to safe.

On the earlier, smaller split (30 elements from 3 forms), Spark Open scored 86.7% on keys and Muse Spark 83.3%. The forms added since are the ones with the most custom keys.

A tuned Muse Glimmer would need to match the untuned models' key accuracy with no risk under-calls, outside search, to earn its place.
