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

From this machine's compiler log on 26 October:

| | |
| --- | --- |
| Labelling calls by Muse Spark | 88 (4 failed validation) |
| Element examples before de-duplication | 241 |
| **Unique examples** | **104** |
| Train | 74, from 6 forms |
| Eval | 30, from 3 forms: the mock site's cover step, GOV.UK contact, Travelodge search |
| By source | mock quote site 62, httpbin 11, Travelodge 11, Aviva 8, GOV.UK 7, Wikipedia 3, Mozilla 2 |
| By risk | safe 95, consequential 6, needs_user 3 |

That is far too few to tune on. It shows the pipeline, not a training set. Consequential and needs_user elements are rare, and they are the ones that matter. To grow it, run the accuracy evaluation over the 28 forms in `evals/forms.json` (`npm run accuracy`, about $0.01 a form). The keeper's recompiles and the map viewer write to the same log. A few hundred forms would give a few thousand elements. Before tuning, oversample the consequential and needs_user examples, or weight them.

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

Results on the 30 held-out elements, with the prompt in `packages/core/scripts/finetune-shared.ts` (live on 26 October):

| Predictions | Key | Risk | Both | Risk under-called | Spend |
| --- | --- | --- | --- | --- | --- |
| Baseline: commonest per control | 6.7% | 83.3% | 6.7% | 5 | $0 |
| Muse Spark Open, untuned, per element | 86.7% | 96.7% | 86.7% | 1 | $0.098 |
| Muse Spark, per element | 83.3% | 96.7% | 83.3% | 1 | $0.136 |

Both models see one element at a time here, and the reference labels came from Muse Spark seeing the whole form with a screenshot. So the misses are mostly where the whole form matters:

- **Room-occupancy pickers.** Travelodge's "Room 1" adults and children pickers came out as `booking.party_size`.
- **"Add another room".** Called `custom.add_another_room` where the teacher said `ui.expand`.
- **Travelodge's "Search" button.** The teacher called it `form.submit` and consequential; both models coined a safe custom key. That is the one under-call. In a real map the compiler's floor applies only to vocabulary keys, which is why the classifier's stricter-risk reconciliation matters.

A tuned Muse Glimmer would need to beat 86.7% on keys with no risk under-calls to earn its place.
