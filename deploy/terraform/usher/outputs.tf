output "certificate_validation_records" {
  description = "Phase 1: the CNAMEs that validate both certificates (made automatically when route53_zone_id is set)."
  value       = { for o in aws_acm_certificate.alb.domain_validation_options : o.domain_name => { name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value } }
}

output "dns_records" {
  description = "Phase 2: both hosts point at CloudFront (made automatically when route53_zone_id is set)."
  value       = var.certificates_issued ? { for h in [var.registry_host, var.site_host] : h => aws_cloudfront_distribution.usher[0].domain_name } : null
}

output "secrets" {
  description = "Fill with scripts/put-secrets.sh."
  value       = { for k, s in aws_secretsmanager_secret.usher : k => s.arn }
}

output "database" {
  value = { identifier = aws_db_instance.usher.identifier, endpoint = aws_db_instance.usher.address }
}

output "config_env" {
  description = "For deploy/ecs/config.env, so scripts/ecs-deploy.sh, ecs-migrate.sh and db-backup.sh find this deployment."
  value       = <<-EOT
    AWS_ACCOUNT_ID=${data.aws_caller_identity.current.account_id}
    AWS_REGION=${var.region}
    REGISTRY_REPO=usher-registry
    SITE_REPO=usher-mock-site
    REGISTRY_HOST=${var.registry_host}
    SITE_HOST=${var.site_host}
    ECS_CLUSTER=${aws_ecs_cluster.usher.name}
    REGISTRY_SERVICE=usher-registry
    SITE_SERVICE=usher-mock-site
    EXECUTION_ROLE_ARN=${aws_iam_role.execution.arn}
    TASK_ROLE_ARN=${aws_iam_role.task.arn}
    TASK_SUBNETS=${join(",", aws_subnet.public[*].id)}
    TASK_SECURITY_GROUP=${aws_security_group.registry.id}
    ASSIGN_PUBLIC_IP=ENABLED
    SECRET_PREFIX=${var.name}
    CONTACT_EMAIL=${var.contact_email}
    DAILY_MODEL_BUDGET_USD=${var.daily_model_budget_usd}
    MOCK_SITE_KEY=${var.mock_site_key}
  EOT
}
