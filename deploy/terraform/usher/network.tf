# A VPC of its own: the registry runs a browser, so it shares no network with anything else.
# Public subnets and public task IPs, no NAT gateway; nothing reaches the tasks except the ALB,
# and nothing reaches the ALB except CloudFront.

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "usher" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "usher" {
  vpc_id = aws_vpc.usher.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  count             = 2
  vpc_id            = aws_vpc.usher.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = { Name = "${var.name}-public-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.usher.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.usher.id
  }
  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Usher ALB: CloudFront only"
  vpc_id      = aws_vpc.usher.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  security_group_id = aws_security_group.alb.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 4100
  to_port           = 4200
}

resource "aws_security_group" "registry" {
  name        = "${var.name}-registry"
  description = "Usher registry tasks: the ALB only"
  vpc_id      = aws_vpc.usher.id
}

resource "aws_security_group" "site" {
  name        = "${var.name}-site"
  description = "Usher demo site tasks: the ALB only"
  vpc_id      = aws_vpc.usher.id
}

resource "aws_vpc_security_group_ingress_rule" "registry_from_alb" {
  security_group_id            = aws_security_group.registry.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 4200
  to_port                      = 4200
}

resource "aws_vpc_security_group_ingress_rule" "site_from_alb" {
  security_group_id            = aws_security_group.site.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 4100
  to_port                      = 4100
}

# Outbound: images, the model APIs, your Postgres, sites' claim files.
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

resource "aws_security_group" "demo_sites" {
  name        = "${var.name}-demo-sites"
  description = "Usher demo sites (examples/sites): the ALB only"
  vpc_id      = aws_vpc.usher.id
}

resource "aws_vpc_security_group_egress_rule" "alb_to_demo_sites" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.demo_sites.id
  ip_protocol                  = "tcp"
  from_port                    = 4300
  to_port                      = 4300
}

resource "aws_vpc_security_group_ingress_rule" "demo_sites_from_alb" {
  security_group_id            = aws_security_group.demo_sites.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 4300
  to_port                      = 4300
}

# Outbound: images, and the registry for the token check.
resource "aws_vpc_security_group_egress_rule" "demo_sites_out" {
  security_group_id = aws_security_group.demo_sites.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
