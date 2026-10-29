"""LoRA fine-tuning of Muse Glimmer on Muse Spark's labels (docs/finetune.md).

One script, three ways to run it:

- On Modal, one H100 (the real run): `npm run finetune:train -- --confirm-spend`. The base weights
  live in a Modal volume, fetched once; the adapter is saved beside them.
- On Baseten, one H100, started by the registry's automatic retraining (packages/registry/src/
  trainer.ts): `train.py --baseten`. The job fetches this file and its data from the registry, trains,
  scores the new adapter and the one serving now on the same held-out examples, saves the adapter
  to $BT_CHECKPOINT_DIR and posts the scores back. The registry promotes it only if it is no worse.
- Locally on CPU, with a tiny stand-in model (the dry run): `npm run finetune:train -- --dry-run`.
  One training step on 10 examples, to prove the data, the chat format, completion-only loss and
  the adapter save work end to end, at no cost.

The data is data/finetune/train.chat.jsonl and eval.chat.jsonl from `npm run finetune:export`:
system, user and assistant messages. Each row becomes a prompt (system and user) and a completion
(the assistant's JSON), so the loss falls on the answer only. Structure only: the export never
holds anything a person typed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

BASE_MODEL = "meta-models/Muse-Glimmer-30B"
# A tiny random Llama with a tokenizer, for the CPU dry run only.
STAND_IN = "hf-internal-testing/tiny-random-LlamaForCausalLM"
VOLUME = "usher-finetune"
VOLUME_DIR = "/vol"

# docs/finetune.md: rank 16, alpha 32, dropout 0.05 on q, k, v and o; 3 epochs at 1e-4 with a
# short warmup (10 steps); sequences of 2,048 tokens (an example is about 1,000; truncation would cut the answer).
LORA = {"r": 16, "lora_alpha": 32, "lora_dropout": 0.05, "target_modules": ["q_proj", "k_proj", "v_proj", "o_proj"]}
TRAIN = {"num_train_epochs": 3, "learning_rate": 1e-4, "warmup_steps": 10, "max_length": 2048}

# A plain chat template for a stand-in tokenizer that has none. The real base brings its own.
FALLBACK_TEMPLATE = (
    "{% for m in messages %}<|{{ m['role'] }}|>\n{{ m['content'] }}\n{% endfor %}"
    "{% if add_generation_prompt %}<|assistant|>\n{% endif %}"
)


def prompt_completion(rows: list[dict]) -> list[dict]:
    """Chat rows to conversational prompt/completion pairs: the loss is on the completion only."""
    out = []
    for row in rows:
        messages = row["messages"]
        out.append({"prompt": [m for m in messages if m["role"] != "assistant"], "completion": [m for m in messages if m["role"] == "assistant"]})
    return out


def read_jsonl(path: Path, limit: int | None = None) -> list[dict]:
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return rows[:limit] if limit else rows


def load_base(model_id: str, dtype):
    """The base model. Muse Glimmer is published as image-text-to-text; its language model loads as either class."""
    from transformers import AutoModelForCausalLM, AutoModelForImageTextToText

    try:
        return AutoModelForCausalLM.from_pretrained(model_id, dtype=dtype)
    except ValueError:
        return AutoModelForImageTextToText.from_pretrained(model_id, dtype=dtype)


def train(data_dir: Path, out_dir: Path, model_id: str, *, max_steps: int = -1, limit: int | None = None, cpu: bool = False) -> tuple[dict, object]:
    """Trains the adapter and saves it to out_dir. Returns a short summary, and the trainer."""
    import torch
    from datasets import Dataset
    from peft import LoraConfig
    from transformers import AutoTokenizer
    from trl import SFTConfig, SFTTrainer

    train_rows = prompt_completion(read_jsonl(data_dir / "train.chat.jsonl", limit))
    eval_path = data_dir / "eval.chat.jsonl"
    eval_rows = prompt_completion(read_jsonl(eval_path, limit)) if eval_path.exists() else []

    tokenizer = AutoTokenizer.from_pretrained(model_id)
    if not tokenizer.chat_template:
        tokenizer.chat_template = FALLBACK_TEMPLATE
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    dtype = torch.float32 if cpu else torch.bfloat16
    model = load_base(model_id, dtype)

    config = SFTConfig(
        output_dir=str(out_dir / "checkpoints"),
        num_train_epochs=TRAIN["num_train_epochs"],
        learning_rate=TRAIN["learning_rate"],
        warmup_steps=0 if cpu else TRAIN["warmup_steps"],
        max_length=TRAIN["max_length"],
        max_steps=max_steps,
        per_device_train_batch_size=1 if cpu else 4,
        gradient_accumulation_steps=1 if cpu else 4,
        # 30B in bf16 is about 60 GB of the H100's 80: recompute activations rather than keep them.
        gradient_checkpointing=not cpu,
        # Loss on the assistant's answer only, never the prompt.
        completion_only_loss=True,
        logging_steps=1,
        save_strategy="no",
        eval_strategy="no" if cpu or not eval_rows else "epoch",
        report_to=[],
        bf16=not cpu,
        use_cpu=cpu,
    )
    trainer = SFTTrainer(
        model=model,
        args=config,
        train_dataset=Dataset.from_list(train_rows),
        eval_dataset=Dataset.from_list(eval_rows) if eval_rows and not cpu else None,
        processing_class=tokenizer,
        peft_config=LoraConfig(task_type="CAUSAL_LM", bias="none", **LORA),
    )
    result = trainer.train()
    adapter = out_dir / "adapter"
    trainer.model.save_pretrained(str(adapter))
    tokenizer.save_pretrained(str(adapter))
    summary = {
        "base": model_id,
        "examples": len(train_rows),
        "eval_examples": len(eval_rows),
        "steps": result.global_step,
        "train_loss": round(float(result.training_loss), 4),
        "adapter": str(adapter),
        "adapter_files": sorted(p.name for p in adapter.iterdir()),
        "lora": LORA,
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary, trainer


def parse_answer(text: str) -> dict | None:
    """The first JSON object in a reply, or None."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        answer = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    return answer if isinstance(answer, dict) else None


def evaluate(model, tokenizer, rows: list[dict], batch_size: int = 8) -> dict:
    """Share of held-out examples where the active adapter gives the expected key and risk, and valid JSON."""
    import torch

    tokenizer.padding_side = "left"
    model.eval()
    key = risk = valid = 0
    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        prompts = [tokenizer.apply_chat_template(r["prompt"], tokenize=False, add_generation_prompt=True) for r in batch]
        enc = tokenizer(prompts, return_tensors="pt", padding=True, add_special_tokens=False).to(model.device)
        with torch.no_grad():
            out = model.generate(**enc, max_new_tokens=64, do_sample=False, pad_token_id=tokenizer.pad_token_id)
        replies = tokenizer.batch_decode(out[:, enc["input_ids"].shape[1] :], skip_special_tokens=True)
        for row, reply in zip(batch, replies):
            want = json.loads(row["completion"][0]["content"])
            got = parse_answer(reply)
            if got is None or "key" not in got or got.get("risk") not in ("safe", "consequential", "needs_user"):
                continue
            valid += 1
            key += got["key"] == want["key"]
            risk += got["risk"] == want["risk"]
    n = max(len(rows), 1)
    return {"examples": len(rows), "key": round(key / n, 4), "risk": round(risk / n, 4), "valid": round(valid / n, 4)}


def registry_call(path: str, body: dict | None = None):
    """GET or POST to this run's URL on the registry, with the run's token."""
    import urllib.request

    request = urllib.request.Request(
        f"{os.environ['USHER_RUN_URL']}/{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {os.environ['USHER_RUN_TOKEN']}", "Content-Type": "application/json"},
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read() or b"null")


def fetch_files(files: list[dict], prefix: str, dest: Path) -> bool:
    """Downloads the checkpoint files under prefix (presigned URLs) into dest. False if there are none."""
    import urllib.request

    wanted = [f for f in files if f["relative_file_name"].startswith(prefix)]
    for f in wanted:
        target = dest / f["relative_file_name"][len(prefix) :]
        target.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(f["url"], target)
    return bool(wanted)


def baseten_run() -> None:
    """The automatic retraining job on Baseten: train, score against the adapter serving now, report."""
    data = Path.cwd()
    out = Path(os.environ.get("BT_CHECKPOINT_DIR", "/tmp/training_checkpoints"))
    summary, trainer = train(data, out, os.environ.get("USHER_BASE_DIR", "/app/models/base"))
    model, tokenizer = trainer.model, trainer.processing_class
    rows = prompt_completion(read_jsonl(data / "eval.chat.jsonl"))
    scores = {"new": evaluate(model, tokenizer, rows), "previous": None}
    previous = Path("/tmp/previous-adapter")
    if fetch_files(registry_call("previous") or [], "adapter/", previous):
        model.load_adapter(str(previous), adapter_name="previous")
        model.set_adapter("previous")
        scores["previous"] = evaluate(model, tokenizer, rows)
    registry_call("result", {**scores, "train_loss": summary["train_loss"], "steps": summary["steps"], "examples": summary["examples"]})
    print(json.dumps(scores, indent=2))


# --- Modal -------------------------------------------------------------------------------------
# Defined only when the modal package is installed, so the dry run needs none of it.

try:
    import modal
except ImportError:  # the local dry run
    modal = None

if modal is not None:
    image = (
        modal.Image.debian_slim(python_version="3.11")
        # The versions the CPU dry run passed with (requirements.txt).
        .pip_install_from_requirements(str(Path(__file__).with_name("requirements.txt")))
    )
    app = modal.App("usher-finetune", image=image)
    volume = modal.Volume.from_name(VOLUME, create_if_missing=True)

    @app.function(volumes={VOLUME_DIR: volume}, timeout=3 * 3600)
    def fetch_base() -> str:
        """Pulls the base weights into the volume once."""
        from huggingface_hub import snapshot_download

        target = Path(VOLUME_DIR) / "base"
        if not (target / "config.json").exists():
            snapshot_download(BASE_MODEL, local_dir=str(target))
            volume.commit()
        return str(target)

    @app.function(gpu="H100", volumes={VOLUME_DIR: volume}, timeout=6 * 3600)
    def train_remote(train_chat: str, eval_chat: str, run: str) -> dict:
        data = Path(VOLUME_DIR) / "runs" / run / "data"
        data.mkdir(parents=True, exist_ok=True)
        (data / "train.chat.jsonl").write_text(train_chat)
        (data / "eval.chat.jsonl").write_text(eval_chat)
        summary, _ = train(data, data.parent, str(Path(VOLUME_DIR) / "base"))
        (Path(VOLUME_DIR) / "runs" / "latest").write_text(run)
        volume.commit()
        return summary

    @app.local_entrypoint()
    def main(data_dir: str = "data/finetune", run: str = ""):
        import time

        run = run or time.strftime("%Y%m%d-%H%M%S")
        fetch_base.remote()
        summary = train_remote.remote(Path(data_dir, "train.chat.jsonl").read_text(), Path(data_dir, "eval.chat.jsonl").read_text(), run)
        print(json.dumps(summary, indent=2))


def cli() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="one step on 10 examples, on CPU, with a tiny stand-in model")
    parser.add_argument("--baseten", action="store_true", help="the automatic retraining job on Baseten (started by the registry)")
    parser.add_argument("--data", default="data/finetune")
    parser.add_argument("--out", default="data/finetune/dry-run")
    args = parser.parse_args()
    if args.baseten:
        baseten_run()
        return
    if not args.dry_run:
        print("Real runs go through Modal: npm run finetune:train -- --confirm-spend", file=sys.stderr)
        sys.exit(2)
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    summary, trainer = train(Path(args.data), Path(args.out), STAND_IN, max_steps=1, limit=10, cpu=True)
    # The scoring the Baseten job does after training, on three held-out examples.
    rows = prompt_completion(read_jsonl(Path(args.data) / "eval.chat.jsonl", 3))
    summary["eval"] = evaluate(trainer.model, trainer.processing_class, rows)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    cli()
