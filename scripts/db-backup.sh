#!/usr/bin/env bash
# One-command backup and restore of the RDS database. The database is private, so this tunnels
# through the running registry task (ECS Exec port forwarding) and runs pg_dump / pg_restore
# (Postgres 16) in Docker.
#
#   scripts/db-backup.sh dump [file]      custom-format dump (default backups/usher-<UTC time>.dump)
#   scripts/db-backup.sh restore <file>   replaces the database's contents, in one transaction
#
# Needs the Session Manager plugin, ECS Exec on the registry service, and deploy/ecs/config.env.
source "$(dirname "$0")/deploy-config.sh"
need docker session-manager-plugin nc
cd "$ROOT"

MODE="${1:-}"; FILE="${2:-}"
case "$MODE" in
  dump) FILE="${FILE:-backups/usher-$(date -u +%Y%m%d-%H%M%S).dump}" ;;
  restore) [ -f "$FILE" ] || { echo "Usage: $0 restore <file under this repository>" >&2; exit 2; } ;;
  *) echo "Usage: $0 dump [file] | restore <file>" >&2; exit 2 ;;
esac

# The connection string stays in this process.
DATABASE_URL="$(aws secretsmanager get-secret-value --secret-id "${SECRET_ARN_DATABASE_URL:-$SECRET_PREFIX/DATABASE_URL}" --query SecretString --output text)"
DB_HOST="$(sed -E 's#^[^@]*@([^:/]+).*#\1#' <<<"$DATABASE_URL")"
DB_PORT="$(sed -E 's#^[^@]*@[^:/]+:?([0-9]*).*#\1#' <<<"$DATABASE_URL")"; DB_PORT="${DB_PORT:-5432}"
DB_USER="$(sed -E 's#^postgres(ql)?://([^:]+):.*#\2#' <<<"$DATABASE_URL")"
DB_NAME="$(sed -E 's#^[^@]*@[^/]+/([^?]+).*#\1#' <<<"$DATABASE_URL")"
PGPASSWORD="$(sed -E 's#^postgres(ql)?://[^:]+:([^@]+)@.*#\2#' <<<"$DATABASE_URL")"
export PGPASSWORD
unset DATABASE_URL

TASK="$(aws ecs list-tasks --cluster "$ECS_CLUSTER" --service-name "$REGISTRY_SERVICE" --desired-status RUNNING --query 'taskArns[0]' --output text)"
[ "$TASK" != "None" ] || { echo "No running registry task to tunnel through." >&2; exit 1; }
RUNTIME="$(aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks "$TASK" --query 'tasks[0].containers[?name==`registry`].runtimeId | [0]' --output text)"
LOCAL_PORT=15432
aws ssm start-session --target "ecs:${ECS_CLUSTER}_${TASK##*/}_${RUNTIME}" --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$DB_HOST\"],\"portNumber\":[\"$DB_PORT\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}" >/dev/null &
TUNNEL=$!
trap 'kill $TUNNEL 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do nc -z 127.0.0.1 "$LOCAL_PORT" 2>/dev/null && break; sleep 1; done

pg() { docker run --rm -i -e PGPASSWORD -e PGSSLMODE=require -v "$ROOT:/work" -w /work postgres:16 "$@" -h host.docker.internal -p "$LOCAL_PORT" -U "$DB_USER" -d "$DB_NAME"; }
if [ "$MODE" = dump ]; then
  mkdir -p "$(dirname "$FILE")"
  pg pg_dump --format=custom --no-owner --file "$FILE"
  echo "wrote $FILE ($(du -h "$FILE" | cut -f1))"
else
  read -r -p "Replace everything in $DB_NAME with $FILE? Type the database name to confirm: " answer
  [ "$answer" = "$DB_NAME" ] || { echo "Not restored."; exit 1; }
  pg pg_restore --clean --if-exists --no-owner --single-transaction "$FILE"
  echo "restored $FILE"
fi
