#!/usr/bin/env bash
# Builds both images for Fargate (linux/arm64) and pushes them to ECR, tagged by the git SHA.
#
#   scripts/aws/build-push.sh            the current commit; the working tree must be clean
#
# A tag always means that commit: the repositories are immutable, and a tag already pushed is skipped.
source "$(dirname "$0")/lib.sh"
cd "$ROOT"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Uncommitted changes: commit them first, so the image matches its tag." >&2
  exit 1
fi
SHA="$(git rev-parse --short=12 HEAD)"
aws ecr get-login-password | docker login --username AWS --password-stdin "${ECR_REGISTRY_REPO%%/*}" >/dev/null

build() { # repository dockerfile
  if aws ecr describe-images --repository-name "${1#*/}" --image-ids imageTag="$SHA" >/dev/null 2>&1; then
    echo "$1:$SHA already pushed"
    return
  fi
  docker build --platform linux/arm64 -f "$2" -t "$1:$SHA" .
  docker push "$1:$SHA"
}
build "$ECR_REGISTRY_REPO" Dockerfile.registry
build "$ECR_SITE_REPO" Dockerfile.mock-site
echo "pushed $SHA; deploy with: scripts/aws/deploy.sh $SHA"
