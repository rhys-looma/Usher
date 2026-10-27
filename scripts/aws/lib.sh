# Shared by the scripts in scripts/aws: names come from Terraform's outputs (infra/aws), so nothing
# here repeats an address. Needs terraform (initialised in infra/aws), the AWS CLI and jq.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_DIR="$ROOT/infra/aws"

for tool in aws jq terraform; do
  command -v "$tool" >/dev/null || { echo "Needs $tool on PATH." >&2; exit 2; }
done

OUTPUTS="$(terraform -chdir="$TF_DIR" output -json)"
out() { jq -r "$1" <<<"$OUTPUTS"; }

export AWS_REGION="$(out .region.value)"
ECR_REGISTRY_REPO="$(out .ecr.value.registry)"
ECR_SITE_REPO="$(out .ecr.value.site)"
CLUSTER="$(out .services.value.cluster)"
SERVICE_REGISTRY="$(out .services.value.registry)"
SERVICE_SITE="$(out .services.value.site)"
SECRET_PREFIX="$(out '.secrets.value.DATABASE_URL' | sed 's#/DATABASE_URL$##')"
REGISTRY_URL="$(out .urls.value.registry)"
SITE_URL="$(out .urls.value.site)"
