# One certificate for both hosts in each region: eu-west-2 for the ALB, us-east-1 for CloudFront.
# Validated by DNS records you add (the same records serve both).

resource "aws_acm_certificate" "alb" {
  domain_name               = var.registry_host
  subject_alternative_names = [var.site_host]
  validation_method         = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate" "cloudfront" {
  provider                  = aws.us_east_1
  domain_name               = var.registry_host
  subject_alternative_names = [var.site_host]
  validation_method         = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "alb" {
  count           = var.certificates_issued ? 1 : 0
  certificate_arn = aws_acm_certificate.alb.arn
}

resource "aws_acm_certificate_validation" "cloudfront" {
  count           = var.certificates_issued ? 1 : 0
  provider        = aws.us_east_1
  certificate_arn = aws_acm_certificate.cloudfront.arn
}
