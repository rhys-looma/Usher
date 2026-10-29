#!/usr/bin/env bash
# Pushes the student's deployment (deploy/baseten/student) to Baseten, once: vLLM with Muse Glimmer,
# loading whichever adapter the registry has promoted each time it starts.
#
#   scripts/baseten-student.sh
#
# Needs the truss CLI (pip install truss), BASETEN_TRAINING_API_KEY in .env or the environment, and
# REGISTRY_HOST in deploy/ecs/config.env. Before the first start, add the Baseten secret
# usher_training_secret with the registry's USHER_TRAINING_SECRET. Afterwards: set min replicas to
# 0 in the deployment's autoscaling settings, then give the registry USHER_STUDENT_URL,
# USHER_STUDENT_BASETEN_MODEL and USHER_STUDENT_KEY (DEPLOY.md, "Automatic retraining").
source "$(dirname "$0")/deploy-config.sh"
need truss
require REGISTRY_HOST
cd "$ROOT"
KEY="${BASETEN_TRAINING_API_KEY:-$(grep -E '^BASETEN_TRAINING_API_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"' ")}"
[ -n "$KEY" ] || { echo "BASETEN_TRAINING_API_KEY is not set (.env or the environment)." >&2; exit 1; }

DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
cp -R deploy/baseten/student/. "$DIR/"
sed -i.bak "s#REGISTRY_URL_PLACEHOLDER#https://$REGISTRY_HOST#" "$DIR/config.yaml" && rm "$DIR/config.yaml.bak"
BASETEN_API_KEY="$KEY" truss push "$DIR" --publish --promote
