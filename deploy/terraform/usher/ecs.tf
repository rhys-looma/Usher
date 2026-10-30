data "aws_caller_identity" "current" {}

resource "aws_ecs_cluster" "usher" {
  name = var.name
}

resource "aws_cloudwatch_log_group" "registry" {
  name              = "/ecs/usher-registry"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "site" {
  name              = "/ecs/usher-mock-site"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "demo_sites" {
  count             = length(var.demo_sites) > 0 ? 1 : 0
  name              = "/ecs/usher-demo-sites"
  retention_in_days = var.log_retention_days
}

# The task definitions are the templates in deploy/ecs, the same ones scripts/ecs-deploy.sh renders.
locals {
  template_values = merge({
    AWS_ACCOUNT_ID         = data.aws_caller_identity.current.account_id
    AWS_REGION             = var.region
    REGISTRY_REPO          = "usher-registry"
    SITE_REPO              = "usher-mock-site"
    IMAGE_TAG              = var.image_tag
    REGISTRY_HOST          = var.registry_host
    SITE_HOST              = var.site_host
    EXECUTION_ROLE_ARN     = aws_iam_role.execution.arn
    TASK_ROLE_ARN          = aws_iam_role.task.arn
    CONTACT_EMAIL          = var.contact_email
    DAILY_MODEL_BUDGET_USD = var.daily_model_budget_usd
    MOCK_SITE_KEY          = var.mock_site_key
    DEMO_SITES             = join(",", var.demo_sites)
  }, { for k, s in aws_secretsmanager_secret.usher : "SECRET_ARN_${k}" => s.arn })
  task = { for name in concat(["registry", "mock-site", "migrate"], length(var.demo_sites) > 0 ? ["demo-sites"] : []) : name => jsondecode(templatefile("${path.module}/../../ecs/${name}.json", local.template_values)) }
}

resource "aws_ecs_task_definition" "usher" {
  for_each                 = local.task
  family                   = each.value.family
  requires_compatibilities = each.value.requiresCompatibilities
  network_mode             = each.value.networkMode
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = each.value.executionRoleArn
  task_role_arn            = try(each.value.taskRoleArn, null)
  container_definitions    = jsonencode(each.value.containerDefinitions)
  runtime_platform {
    cpu_architecture        = each.value.runtimePlatform.cpuArchitecture
    operating_system_family = each.value.runtimePlatform.operatingSystemFamily
  }
}

resource "aws_ecs_service" "registry" {
  count                              = var.certificates_issued ? 1 : 0
  name                               = "usher-registry"
  cluster                            = aws_ecs_cluster.usher.id
  task_definition                    = aws_ecs_task_definition.usher["registry"].arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  enable_execute_command             = true
  health_check_grace_period_seconds  = 120
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.registry.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.registry.arn
    container_name   = "registry"
    container_port   = 4200
  }
  # scripts/ecs-deploy.sh rolls new images by registering revisions.
  lifecycle {
    ignore_changes = [task_definition]
  }
  depends_on = [aws_lb_listener_rule.registry]
}

resource "aws_ecs_service" "site" {
  count                              = var.certificates_issued ? 1 : 0
  name                               = "usher-mock-site"
  cluster                            = aws_ecs_cluster.usher.id
  task_definition                    = aws_ecs_task_definition.usher["mock-site"].arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  health_check_grace_period_seconds  = 30
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.site.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.site.arn
    container_name   = "mock-site"
    container_port   = 4100
  }
  lifecycle {
    ignore_changes = [task_definition]
  }
  depends_on = [aws_lb_listener_rule.site]
}

resource "aws_ecs_service" "demo_sites" {
  count                              = var.certificates_issued && length(var.demo_sites) > 0 ? 1 : 0
  name                               = "usher-demo-sites"
  cluster                            = aws_ecs_cluster.usher.id
  task_definition                    = aws_ecs_task_definition.usher["demo-sites"].arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  health_check_grace_period_seconds  = 30
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.demo_sites.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.demo_sites[0].arn
    container_name   = "demo-sites"
    container_port   = 4300
  }
  lifecycle {
    ignore_changes = [task_definition]
  }
  depends_on = [aws_lb_listener_rule.demo_sites]
}
