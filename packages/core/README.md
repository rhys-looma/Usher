# @usher/core

The pieces everything else is built on. Structure only: nothing here reads what anyone typed into a form.

| Module | What |
| --- | --- |
| `extract.ts` | Reads a page's forms in the browser: each field and action, its label, control, options and constraints. Never `.value`. |
| `locators.ts` | Ways to find each element again (id, name, label, role, placeholder), checked to match exactly one element. The model labels; the code locates. |
| `fingerprint.ts` | `usher-fp-1`: a digest of a form's structure, and a similarity score for near matches. |
| `labels.ts`, `map.ts` | Validates a model's labels against the extraction and the vocabulary, applies risk floors, and builds the map. |
| `compile/` | The Muse Spark map compiler: the short list of candidate keys, prompt, model client (Meta Model API, Baseten), budget cap, compiler log, risk classifier. |
| `token.ts`, `identity.ts`, `http-signatures.ts` | Ed25519 tokens (compact JWS), agent ids (JWK thumbprints), the signed-body scheme, and Web Bot Auth (RFC 9421) signing, verification and key directories. |
| `policy.ts`, `plan.ts`, `preflight.ts` | Site rules and how they combine with a map; journey plans; checking an agent's data against a map before filling. |
| `schemas.ts`, `vocabulary.ts` | The JSON Schemas and semantic-key vocabulary from [`spec/`](../../spec/). |

Commands, from the repository root:

```bash
npm run compile -- http://localhost:4100/quote/driver
```

That compiles one page into a map with Muse Spark (`MODEL_API_KEY`). Add `--classify` for a second opinion on risk from Muse Spark Open.

```bash
npm test --workspace packages/core
```

The tests run offline from the recorded model responses in `test/fixtures/`.

Also: `npm run fixtures:record` re-records those responses (live), `npm run accuracy` runs the accuracy evaluation, and `npm run finetune:export` builds the fine-tuning set ([docs/finetune.md](../../docs/finetune.md)).
