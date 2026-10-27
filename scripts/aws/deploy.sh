#!/usr/bin/env bash
# Rolls both services to the images tagged <sha> (default: the current commit) and waits until they
# are stable. A deployment that fails its health checks rolls back on its own (circuit breaker).
#
#   scripts/aws/deploy.sh [sha]
source "$(dirname "$0")/lib.sh"
SHA="${1:-$(git -C "$ROOT" rev-parse --short=12 HEAD)}"

roll() { # service repository
  local current family revision
  current="$(aws ecs describe-services --cluster "$CLUSTER" --services "$1" --query 'services[0].taskDefinition' --output text)"
  aws ecr describe-images --repository-name "${2#*/}" --image-ids imageTag="$SHA" >/dev/null \
    || { echo "No image $2:$SHA: run scripts/aws/build-push.sh first." >&2; exit 1; }
  # The same task definition with the new image; everything else stays as Terraform wrote it.
  revision="$(aws ecs describe-task-definition --task-definition "$current" --query taskDefinition --output json \
    | jq --arg image "$2:$SHA" '.containerDefinitions[0].image = $image
        | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)')"
  family="$(aws ecs register-task-definition --cli-input-json "$revision" --query 'taskDefinition.taskDefinitionArn' --output text)"
  aws ecs update-service --cluster "$CLUSTER" --service "$1" --task-definition "$family" --desired-count 1 >/dev/null
  echo "$1 → $family"
}
roll "$SERVICE_REGISTRY" "$ECR_REGISTRY_REPO"
roll "$SERVICE_SITE" "$ECR_SITE_REPO"
echo "waiting for both services to be stable (a few minutes)…"
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE_REGISTRY" "$SERVICE_SITE"
for url in "$REGISTRY_URL" "$SITE_URL"; do
  printf '%s/healthz: ' "$url"; curl -fsS --max-time 10 "$url/healthz" || echo "not reachable yet (DNS or certificate?)"; echo
done
echo "deployed $SHA"
