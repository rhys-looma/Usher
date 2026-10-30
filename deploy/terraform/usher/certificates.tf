# One certificate for every host (the registry, the demo site and the demo sites) in each region: eu-west-2 for the ALB, us-east-1 for CloudFront.
# Validated by DNS records you add (the same records serve both).

locals {
  demo_hosts = [for s in var.demo_sites : "${s}.${var.registry_host}"]
  site_hosts = concat([var.site_host], local.demo_hosts)
}

resource "aws_acm_certificate" "alb" {
  domain_name               = var.registry_host
  subject_alternative_names = local.site_hosts
  validation_method         = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate" "cloudfront" {
  provider                  = aws.us_east_1
  domain_name               = var.registry_host
  subject_alternative_names = local.site_hosts
  validation_method         = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

locals {
  validate = var.route53_zone_id != "" || var.certificates_issued
}

# With a Route 53 zone the records are made here and issuing is awaited in phase 1.
resource "aws_route53_record" "validation" {
  for_each        = var.route53_zone_id == "" ? {} : { for o in aws_acm_certificate.alb.domain_validation_options : o.domain_name => o }
  zone_id         = var.route53_zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = false
}

resource "aws_acm_certificate_validation" "alb" {
  count                   = local.validate ? 1 : 0
  certificate_arn         = aws_acm_certificate.alb.arn
  validation_record_fqdns = var.route53_zone_id == "" ? null : [for r in aws_route53_record.validation : r.fqdn]
}

resource "aws_acm_certificate_validation" "cloudfront" {
  count                   = local.validate ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.cloudfront.arn
  validation_record_fqdns = var.route53_zone_id == "" ? null : [for r in aws_route53_record.validation : r.fqdn]
}
