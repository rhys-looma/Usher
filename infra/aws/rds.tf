resource "aws_db_subnet_group" "usher" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_instance" "usher" {
  identifier                 = var.name
  engine                     = "postgres"
  engine_version             = "16"
  instance_class             = var.db_instance_class
  allocated_storage          = var.db_allocated_storage
  storage_type               = "gp3"
  storage_encrypted          = true
  db_name                    = "usher"
  username                   = "usher"
  password                   = random_password.db.result
  db_subnet_group_name       = aws_db_subnet_group.usher.name
  vpc_security_group_ids     = [aws_security_group.db.id]
  publicly_accessible        = false
  multi_az                   = false
  backup_retention_period    = var.backup_retention_days
  backup_window              = "02:30-03:30"
  maintenance_window         = "sun:04:00-sun:05:00"
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${var.name}-final"
}
