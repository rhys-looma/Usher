#!/usr/bin/env bash
# Puts the four secrets Terraform doesn't write (DATABASE_URL it does). Values go from this terminal
# to Secrets Manager on stdin; nothing is echoed, logged or passed on a command line.
#
#   scripts/aws/secrets.sh           fills the ones that have no value yet
#   scripts/aws/secrets.sh --force   replaces them all (a new signing key ends every token in flight)
source "$(dirname "$0")/lib.sh"
cd "$ROOT"
FORCE="${1:-}"

has_value() { aws secretsmanager get-secret-value --secret-id "$SECRET_PREFIX/$1" --query VersionId --output text >/dev/null 2>&1; }
put() { # name; value on stdin
  aws secretsmanager put-secret-value --secret-id "$SECRET_PREFIX/$1" --secret-string file:///dev/stdin >/dev/null
  echo "$1 stored"
}
skip() {
  if [ "$FORCE" != "--force" ] && has_value "$1"; then echo "$1 already set (--force to replace)"; return 0; fi
  return 1
}

for name in MODEL_API_KEY BASETEN_API_KEY; do
  skip "$name" && continue
  read -r -s -p "$name: " value && echo
  [ -n "$value" ] || { echo "$name left empty." >&2; exit 1; }
  printf '%s' "$value" | put "$name"
  unset value
done

# The token signing key: generated here and sent straight to Secrets Manager (npm run keygen).
if ! skip USHER_SIGNING_KEY; then
  npm run --silent keygen | tr -d '\n' | put USHER_SIGNING_KEY
fi

# The admin key signs in to /admin and switches the demo's layout. Shown once.
if ! skip USHER_ADMIN_KEY; then
  admin="$(openssl rand -base64 36 | tr -d '\n/+=' | cut -c1-40)"
  printf '%s' "$admin" | put USHER_ADMIN_KEY
  echo "Admin key (shown once; keep it in your password manager): $admin"
  unset admin
fi
