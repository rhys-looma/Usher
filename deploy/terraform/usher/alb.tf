resource "aws_lb" "usher" {
  name                       = var.name
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  idle_timeout               = 120
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "registry" {
  name                 = "${var.name}-registry"
  port                 = 4200
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.usher.id
  deregistration_delay = 30
  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_target_group" "site" {
  name                 = "${var.name}-mock-site"
  port                 = 4100
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.usher.id
  deregistration_delay = 30
  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  count             = var.certificates_issued ? 1 : 0
  load_balancer_arn = aws_lb.usher.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.alb[0].certificate_arn
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "registry" {
  count        = var.certificates_issued ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 10
  condition {
    host_header {
      values = [var.registry_host]
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.registry.arn
  }
}

resource "aws_lb_listener_rule" "site" {
  count        = var.certificates_issued ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 20
  condition {
    host_header {
      values = [var.site_host]
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.site.arn
  }
}

# The demo sites: one container serving each at its own host name. A rule takes five host names at
# most, so the hosts are split across rules.
resource "aws_lb_target_group" "demo_sites" {
  count                = length(var.demo_sites) > 0 ? 1 : 0
  name                 = "${var.name}-demo-sites"
  port                 = 4300
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.usher.id
  deregistration_delay = 30
  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener_rule" "demo_sites" {
  for_each     = var.certificates_issued && length(var.demo_sites) > 0 ? { for i, hosts in chunklist(local.demo_hosts, 5) : tostring(i) => hosts } : {}
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 30 + tonumber(each.key)
  condition {
    host_header {
      values = each.value
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.demo_sites[0].arn
  }
}
