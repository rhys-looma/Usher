# A small Postgres for Usher alone: single-AZ, encrypted, private (reachable only from the
# registry's tasks), 7 days of automated backups. The password is generated per apply as an
# ephemeral value and only ever written (write-only arguments), so it is never in Terraform state;
# bump password_version to rotate it.

resource "aws_subnet" "database" {
  count             = 2
  vpc_id            = aws_vpc.usher.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 10 + count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = { Name = "${var.name}-database-${count.index}" }
}

resource "aws_db_subnet_group" "usher" {
  name       = var.name
  subnet_ids = aws_subnet.database[*].id
}

resource "aws_security_group" "database" {
  name        = "${var.name}-database"
  description = "Usher Postgres: the registry and migrate tasks only"
  vpc_id      = aws_vpc.usher.id
}

resource "aws_vpc_security_group_ingress_rule" "database_from_registry" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.registry.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

ephemeral "random_password" "database" {
  length  = 32
  special = false
}

locals {
  password_version = 1
}

resource "aws_db_instance" "usher" {
  identifier                   = var.name
  engine                       = "postgres"
  engine_version               = "16"
  instance_class               = var.db_instance_class
  allocated_storage            = 20
  max_allocated_storage        = 50
  storage_type                 = "gp3"
  storage_encrypted            = true
  db_name                      = "usher"
  username                     = "usher"
  password_wo                  = ephemeral.random_password.database.result
  password_wo_version          = local.password_version
  db_subnet_group_name         = aws_db_subnet_group.usher.name
  vpc_security_group_ids       = [aws_security_group.database.id]
  publicly_accessible          = false
  multi_az                     = false
  backup_retention_period      = var.db_backup_retention_days
  backup_window                = "02:30-03:30"
  maintenance_window           = "sun:04:00-sun:05:00"
  auto_minor_version_upgrade   = true
  performance_insights_enabled = false
  monitoring_interval          = 0
  copy_tags_to_snapshot        = true
  deletion_protection          = true
  skip_final_snapshot          = false
  final_snapshot_identifier    = "${var.name}-final"
}

# RDS requires TLS; no-verify encrypts without pinning the RDS certificate authority.
resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id                = aws_secretsmanager_secret.usher["DATABASE_URL"].id
  secret_string_wo         = "postgres://usher:${ephemeral.random_password.database.result}@${aws_db_instance.usher.address}:${aws_db_instance.usher.port}/usher?sslmode=no-verify"
  secret_string_wo_version = local.password_version
}
