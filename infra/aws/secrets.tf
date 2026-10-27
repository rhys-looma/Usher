# Five secrets. Terraform writes DATABASE_URL (it made the password); scripts/aws/secrets.sh puts the
# other four, so their values never pass through Terraform state.

locals {
  secret_names = ["DATABASE_URL", "MODEL_API_KEY", "BASETEN_API_KEY", "USHER_SIGNING_KEY", "USHER_ADMIN_KEY"]
}

resource "aws_secretsmanager_secret" "usher" {
  for_each                = toset(local.secret_names)
  name                    = "${var.name}/${each.value}"
  recovery_window_in_days = 7
}

# RDS requires TLS; no-verify encrypts without pinning the RDS certificate authority.
resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.usher["DATABASE_URL"].id
  secret_string = "postgres://${aws_db_instance.usher.username}:${random_password.db.result}@${aws_db_instance.usher.address}:${aws_db_instance.usher.port}/${aws_db_instance.usher.db_name}?sslmode=no-verify"
}
