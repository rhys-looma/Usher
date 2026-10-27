#!/usr/bin/env bash
# Fills the four secrets Terraform doesn't write (deploy/terraform/usher writes DATABASE_URL).
# Values go from this terminal to Secrets Manager on stdin: nothing is echoed, logged, written to
# a file or passed on a command line.
#
#   scripts/put-secrets.sh           fills those that have no value yet
#   scripts/put-secrets.sh --force   replaces them (a new signing key ends every token in flight)
#
# AWS_REGION (default eu-west-2) and SECRET_PREFIX (default usher) from the environment.
set -euo pipefail
cd "$(dirname "$0")/.."
export AWS_REGION="${AWS_REGION:-eu-west-2}"
PREFIX="${SECRET_PREFIX:-usher}"
FORCE="${1:-}"

has_value() { aws secretsmanager get-secret-value --secret-id "$PREFIX/$1" --query VersionId --output text >/dev/null 2>&1; }
put() { aws secretsmanager put-secret-value --secret-id "$PREFIX/$1" --secret-string file:///dev/stdin >/dev/null && echo "$1 stored"; }
skip() { [ "$FORCE" != "--force" ] && has_value "$1" && echo "$1 already set (--force to replace)"; }

for name in MODEL_API_KEY BASETEN_API_KEY; do
  skip "$name" && continue
  read -r -s -p "$name: " value && echo
  [ -n "$value" ] || { echo "$name left empty." >&2; exit 1; }
  printf '%s' "$value" | put "$name"
  unset value
done

# The token signing key, generated here and sent straight to Secrets Manager.
skip USHER_SIGNING_KEY || npm run --silent keygen | tr -d '\n' | put USHER_SIGNING_KEY

# The admin key: /admin and the demo site's layout switch. Shown once.
if ! skip USHER_ADMIN_KEY; then
  admin="$(openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-40)"
  printf '%s' "$admin" | put USHER_ADMIN_KEY
  echo "Admin key (shown once; keep it in your password manager): $admin"
  unset admin
fi
