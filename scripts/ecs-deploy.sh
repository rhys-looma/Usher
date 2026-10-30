#!/usr/bin/env bash
# Registers the task definitions for an image tag and rolls the services to them, then waits until
# they are stable. A deployment that fails its health checks rolls back if the service has the
# deployment circuit breaker on (DEPLOY.md).
#
#   scripts/ecs-deploy.sh [tag] [registry|mock-site|both|demo-sites|all]     defaults: the current git SHA, both
#
# both is the registry and the demo site; all adds the demo sites (examples/sites) when DEMO_SITES is set.
source "$(dirname "$0")/deploy-config.sh"
need node git
require AWS_ACCOUNT_ID ECS_CLUSTER REGISTRY_SERVICE SITE_SERVICE REGISTRY_HOST SITE_HOST
TAG="${1:-$(git -C "$ROOT" rev-parse --short=12 HEAD)}"
WHICH="${2:-both}"

roll() { # template service
  local arn status
  arn="$(aws ecs register-task-definition --cli-input-json "$(node "$ROOT/deploy/ecs/render.mjs" "$1" "$TAG")" --query 'taskDefinition.taskDefinitionArn' --output text)"
  status="$(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$2" --query 'services[0].status' --output text 2>/dev/null || true)"
  if [ "$status" != ACTIVE ]; then
    # The first time: the service is created by hand from this task definition (DEPLOY.md).
    echo "Registered $arn. Service $2 doesn't exist in $ECS_CLUSTER yet: create it with this task definition, then run this again." >&2
    exit 1
  fi
  aws ecs update-service --cluster "$ECS_CLUSTER" --service "$2" --task-definition "$arn" >/dev/null
  echo "$2 → $arn"
}
services=()
if [ "$WHICH" = registry ] || [ "$WHICH" = both ] || [ "$WHICH" = all ]; then roll registry "$REGISTRY_SERVICE"; services+=("$REGISTRY_SERVICE"); fi
if [ "$WHICH" = mock-site ] || [ "$WHICH" = both ] || [ "$WHICH" = all ]; then roll mock-site "$SITE_SERVICE"; services+=("$SITE_SERVICE"); fi
demo=()
if [ "$WHICH" = demo-sites ] || { [ "$WHICH" = all ] && [ -n "${DEMO_SITES:-}" ]; }; then
  require DEMO_SITES DEMO_SITES_SERVICE
  roll demo-sites "$DEMO_SITES_SERVICE"; services+=("$DEMO_SITES_SERVICE")
  IFS=, read -ra demo <<< "$DEMO_SITES"
fi
echo "waiting for ${services[*]} to be stable (a few minutes)…"
aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "${services[@]}"
for host in "$REGISTRY_HOST" "$SITE_HOST" "${demo[@]/%/.$REGISTRY_HOST}"; do
  printf 'https://%s/healthz: ' "$host"; curl -fsS --max-time 10 "https://$host/healthz" || echo "not reachable yet"; echo
done
echo "deployed $TAG"
