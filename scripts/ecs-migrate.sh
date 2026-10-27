#!/usr/bin/env bash
# Runs the database migrations once, as a one-off Fargate task on the registry image, and waits
# for it to finish. The registry also migrates on start; this runs them before a deploy.
#
#   scripts/ecs-migrate.sh [tag]      default: the current git SHA
source "$(dirname "$0")/deploy-config.sh"
need node git
TAG="${1:-$(git -C "$ROOT" rev-parse --short=12 HEAD)}"

arn="$(aws ecs register-task-definition --cli-input-json "$(node "$ROOT/deploy/ecs/render.mjs" migrate "$TAG")" --query 'taskDefinition.taskDefinitionArn' --output text)"
task="$(aws ecs run-task --cluster "$ECS_CLUSTER" --launch-type FARGATE --task-definition "$arn" \
  --network-configuration "awsvpcConfiguration={subnets=[$TASK_SUBNETS],securityGroups=[$TASK_SECURITY_GROUP],assignPublicIp=${ASSIGN_PUBLIC_IP:-DISABLED}}" \
  --query 'tasks[0].taskArn' --output text)"
echo "migrating with $arn ($task)…"
aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER" --tasks "$task"
code="$(aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text)"
echo "logs: CloudWatch /ecs/usher-registry, stream migrate/migrate/${task##*/}"
[ "$code" = 0 ] || { echo "migration failed (exit $code)" >&2; exit 1; }
echo "migrations are up to date"
