# The secrets. Terraform writes DATABASE_URL (database.tf, write-only); scripts/put-secrets.sh
# fills MODEL_API_KEY, BASETEN_API_KEY, USHER_SIGNING_KEY and USHER_ADMIN_KEY, so no value is ever
# in Terraform state. BASETEN_TRAINING_API_KEY (Baseten Training and the student's deployment, never
# Spark Open) is set by hand in the console, before the registry's first deploy: a task fails to
# start if it references a secret with no value.

locals {
  secret_names = ["DATABASE_URL", "MODEL_API_KEY", "BASETEN_API_KEY", "USHER_SIGNING_KEY", "USHER_ADMIN_KEY", "BASETEN_TRAINING_API_KEY"]
}

resource "aws_secretsmanager_secret" "usher" {
  for_each                = toset(local.secret_names)
  name                    = "${var.name}/${each.value}"
  recovery_window_in_days = 7
}
