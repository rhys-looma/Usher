#!/usr/bin/env bash
# One LoRA training job on a Baseten H100, by hand: no registry involved, nothing in production
# changes. Paid: about $6.50 an hour, and the job stops itself after --minutes.
#
#   scripts/baseten-train.sh --minutes 20 --smoke    20 training steps on 64 examples, to prove it fits
#   scripts/baseten-train.sh --minutes 75            the full run on data/finetune
#
# Needs the truss CLI (pip install truss) and BASETEN_TRAINING_API_KEY in .env or the environment.
# Prints the job's id. The adapter, scores.json and answers.jsonl stay with the job:
#   truss train download --job-id <id>
set -euo pipefail
cd "$(dirname "$0")/.."

export USHER_JOB_MINUTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --minutes) USHER_JOB_MINUTES="$2"; shift 2 ;;
    --smoke) export USHER_MAX_STEPS=20 USHER_LIMIT=64; shift ;;
    --batch) export USHER_BATCH_SIZE="$2"; shift 2 ;;
    *) echo "Unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$USHER_JOB_MINUTES" ] || { echo "--minutes is required: it is the job's hard stop." >&2; exit 2; }
[ -f data/finetune/train.chat.jsonl ] || { echo "No dataset: npm run finetune:export first." >&2; exit 2; }

KEY="${BASETEN_TRAINING_API_KEY:-$(grep -E '^BASETEN_TRAINING_API_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"' ")}"
[ -n "$KEY" ] || { echo "BASETEN_TRAINING_API_KEY is not set (.env or the environment)." >&2; exit 1; }

DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
cp deploy/baseten/train/config.py deploy/finetune/train.py deploy/finetune/requirements.txt data/finetune/train.chat.jsonl data/finetune/eval.chat.jsonl "$DIR/"

export BASETEN_TRUSS_AUTH_REMOTE_URL=https://app.baseten.co BASETEN_TRUSS_AUTH_API_KEY="$KEY"
truss train push "$DIR/config.py" --non-interactive
