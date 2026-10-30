# Phase 2 with a Route 53 zone: every host points at CloudFront (A and AAAA aliases).

resource "aws_route53_record" "hosts" {
  for_each        = var.route53_zone_id != "" && var.certificates_issued ? { for p in setproduct(concat([var.registry_host], local.site_hosts), ["A", "AAAA"]) : "${p[0]} ${p[1]}" => { name = p[0], type = p[1] } } : {}
  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  allow_overwrite = false
  alias {
    name                   = aws_cloudfront_distribution.usher[0].domain_name
    zone_id                = aws_cloudfront_distribution.usher[0].hosted_zone_id
    evaluate_target_health = false
  }
}
