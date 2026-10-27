data "aws_lb" "alb" {
  arn = var.alb_arn
}

data "aws_lb_listener" "https" {
  load_balancer_arn = var.alb_arn
  port              = var.listener_port
}

# The tasks accept traffic only from the ALB; the database only from the registry.
resource "aws_security_group" "registry" {
  name        = "${var.name}-registry"
  description = "Usher registry tasks"
  vpc_id      = var.vpc_id
}

resource "aws_security_group" "site" {
  name        = "${var.name}-site"
  description = "Usher demo site tasks"
  vpc_id      = var.vpc_id
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "Usher Postgres"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "registry_from_alb" {
  for_each                     = toset(data.aws_lb.alb.security_groups)
  security_group_id            = aws_security_group.registry.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 4200
  to_port                      = 4200
}

resource "aws_vpc_security_group_ingress_rule" "site_from_alb" {
  for_each                     = toset(data.aws_lb.alb.security_groups)
  security_group_id            = aws_security_group.site.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 4100
  to_port                      = 4100
}

resource "aws_vpc_security_group_ingress_rule" "db_from_registry" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.registry.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

# Outbound: images, the model APIs, the sites the registry maps and checks.
resource "aws_vpc_security_group_egress_rule" "registry_out" {
  security_group_id = aws_security_group.registry.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "site_out" {
  security_group_id = aws_security_group.site.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
