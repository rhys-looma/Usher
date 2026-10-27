# Loaded by the deploy scripts: deploy/ecs/config.env (or USHER_DEPLOY_CONFIG), plus checks for tools.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${USHER_DEPLOY_CONFIG:-$ROOT/deploy/ecs/config.env}"
[ -f "$CONFIG" ] || { echo "No $CONFIG: copy deploy/ecs/config.example.env and fill it in (DEPLOY.md)." >&2; exit 2; }
set -a
# shellcheck disable=SC1090
source "$CONFIG"
set +a
AWS_REGION="${AWS_REGION:-eu-west-2}"
export AWS_REGION USHER_DEPLOY_CONFIG="$CONFIG"
ECR="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
need() { for tool in "$@"; do command -v "$tool" >/dev/null || { echo "Needs $tool on PATH." >&2; exit 2; }; done; }
need aws
