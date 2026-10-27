#!/usr/bin/env bash
# Builds both images for linux/amd64, tags them with the git SHA and latest, and pushes them to ECR.
#
#   scripts/ecr-push.sh
#
# Inputs from deploy/ecs/config.env: AWS_ACCOUNT_ID, AWS_REGION (default eu-west-2), REGISTRY_REPO,
# SITE_REPO. The working tree must be clean, so the SHA tag means that commit.
source "$(dirname "$0")/deploy-config.sh"
need docker git
cd "$ROOT"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Uncommitted changes: commit them first, so the image matches its tag." >&2
  exit 1
fi
SHA="$(git rev-parse --short=12 HEAD)"
aws ecr get-login-password | docker login --username AWS --password-stdin "$ECR" >/dev/null

push() { # repository dockerfile
  docker buildx build --platform linux/amd64 -f "$2" -t "$ECR/$1:$SHA" -t "$ECR/$1:latest" --push .
  echo "pushed $ECR/$1:$SHA (and :latest)"
}
push "$REGISTRY_REPO" Dockerfile.registry
push "$SITE_REPO" Dockerfile.mock-site
echo "next: scripts/ecs-migrate.sh $SHA, then scripts/ecs-deploy.sh $SHA"
