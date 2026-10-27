# The five secrets. Terraform writes DATABASE_URL (database.tf, write-only); scripts/put-secrets.sh
# fills the other four, so no value is ever in Terraform state.

locals {
  secret_names = ["DATABASE_URL", "MODEL_API_KEY", "BASETEN_API_KEY", "USHER_SIGNING_KEY", "USHER_ADMIN_KEY"]
}

resource "aws_secretsmanager_secret" "usher" {
  for_each                = toset(local.secret_names)
  name                    = "${var.name}/${each.value}"
  recovery_window_in_days = 7
}
