output "alb_dns_name" {
  description = "Point both hosts here (CNAME, DNS only)."
  value       = data.aws_lb.alb.dns_name
}

output "certificate_validation_records" {
  description = "Add these CNAME records where the domain's DNS is, then apply with attach_certificate = true."
  value       = { for o in aws_acm_certificate.usher.domain_validation_options : o.domain_name => { name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value } }
}

output "ecr" {
  value = { registry = aws_ecr_repository.registry.repository_url, site = aws_ecr_repository.site.repository_url }
}

output "services" {
  value = { cluster = var.cluster_name, registry = aws_ecs_service.registry.name, site = aws_ecs_service.site.name }
}

output "database" {
  value = { identifier = aws_db_instance.usher.identifier, address = aws_db_instance.usher.address }
}

output "secrets" {
  description = "Secrets Manager names."
  value       = { for k, s in aws_secretsmanager_secret.usher : k => s.name }
}

output "region" {
  value = var.region
}

output "urls" {
  value = { registry = local.registry_url, site = local.site_url }
}
