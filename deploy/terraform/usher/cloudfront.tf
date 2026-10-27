# One distribution for both hosts. Static paths are cached by what the origin says, with Host in
# the cache key (both hosts answer /.well-known/ differently); everything else is not cached and
# reaches the ALB with every viewer header and CloudFront's own (CloudFront-Forwarded-Proto).

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_and_cloudfront" {
  name = "Managed-AllViewerAndCloudFrontHeaders-2022-06"
}

resource "aws_cloudfront_cache_policy" "static" {
  name        = "${var.name}-static"
  comment     = "Usher static paths: origin max-age, Host in the key"
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 31536000
  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
    headers_config {
      header_behavior = "whitelist"
      headers {
        items = ["Host"]
      }
    }
    cookies_config {
      cookie_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

locals {
  static_paths = ["/usher.js", "/usher/*", "/.well-known/*", "/spec/*", "/og.png", "/robots.txt"]
}

resource "aws_cloudfront_distribution" "usher" {
  count           = var.certificates_issued ? 1 : 0
  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3"
  price_class     = "PriceClass_100"
  aliases         = [var.registry_host, var.site_host]
  comment         = "Usher"

  origin {
    origin_id   = "alb"
    domain_name = aws_lb.usher.dns_name
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 5
    }
  }

  default_cache_behavior {
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_and_cloudfront.id
    compress                 = true
  }

  dynamic "ordered_cache_behavior" {
    for_each = local.static_paths
    content {
      path_pattern           = ordered_cache_behavior.value
      target_origin_id       = "alb"
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["GET", "HEAD", "OPTIONS"]
      cached_methods         = ["GET", "HEAD"]
      cache_policy_id        = aws_cloudfront_cache_policy.static.id
      compress               = true
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cloudfront[0].certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  depends_on = [aws_lb_listener.https]
}
