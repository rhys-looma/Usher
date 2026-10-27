# Loaded by the deploy scripts: deploy/ecs/config.env (or USHER_DEPLOY_CONFIG), plus checks for tools.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${USHER_DEPLOY_CONFIG:-$ROOT/deploy/ecs/config.env}"
# The file is optional when the caller sets what a script needs in the environment (Terraform does).
if [ -f "$CONFIG" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG"
  set +a
fi
require() { for name in "$@"; do [ -n "${!name:-}" ] || { echo "Set $name (in $CONFIG or the environment; DEPLOY.md)." >&2; exit 2; }; done; }
AWS_REGION="${AWS_REGION:-eu-west-2}"
export AWS_REGION USHER_DEPLOY_CONFIG="$CONFIG"
ECR="${AWS_ACCOUNT_ID:-}.dkr.ecr.$AWS_REGION.amazonaws.com"
need() { for tool in "$@"; do command -v "$tool" >/dev/null || { echo "Needs $tool on PATH." >&2; exit 2; }; done; }
need aws
