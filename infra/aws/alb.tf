# One certificate for both hosts, validated by DNS records you add where the domain's DNS is.
resource "aws_acm_certificate" "usher" {
  domain_name               = var.registry_host
  subject_alternative_names = [var.site_host]
  validation_method         = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "usher" {
  count           = var.attach_certificate ? 1 : 0
  certificate_arn = aws_acm_certificate.usher.arn
}

resource "aws_lb_listener_certificate" "usher" {
  count           = var.attach_certificate ? 1 : 0
  listener_arn    = data.aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.usher[0].certificate_arn
}

resource "aws_lb_target_group" "registry" {
  name                 = "${var.name}-registry"
  port                 = 4200
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
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
  name                 = "${var.name}-site"
  port                 = 4100
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener_rule" "registry" {
  listener_arn = data.aws_lb_listener.https.arn
  priority     = var.rule_priorities.registry
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
  listener_arn = data.aws_lb_listener.https.arn
  priority     = var.rule_priorities.site
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
