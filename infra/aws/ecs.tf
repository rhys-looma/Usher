data "aws_ecs_cluster" "cluster" {
  cluster_name = var.cluster_name
}

resource "aws_cloudwatch_log_group" "registry" {
  name              = "/ecs/${var.name}-registry"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "site" {
  name              = "/ecs/${var.name}-mock-site"
  retention_in_days = var.log_retention_days
}

locals {
  registry_url = "https://${var.registry_host}"
  site_url     = "https://${var.site_host}"
  secret_arn   = { for k, s in aws_secretsmanager_secret.usher : k => s.arn }
  logging = { for k, g in { registry = aws_cloudwatch_log_group.registry.name, site = aws_cloudwatch_log_group.site.name } : k => {
    logDriver = "awslogs"
    options   = { "awslogs-group" = g, "awslogs-region" = var.region, "awslogs-stream-prefix" = "ecs" }
  } }
}

resource "aws_ecs_task_definition" "registry" {
  family                   = "${var.name}-registry"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.registry_cpu
  memory                   = var.registry_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name         = "registry"
    image        = "${aws_ecr_repository.registry.repository_url}:${var.image_tag}"
    essential    = true
    portMappings = [{ containerPort = 4200, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "REGISTRY_PUBLIC_URL", value = local.registry_url },
      { name = "USHER_DAILY_MODEL_BUDGET_USD", value = var.daily_model_budget_usd },
      { name = "USHER_CONTACT_EMAIL", value = var.contact_email },
      # The demo site's maps, so agents skip the model on its first run. In production seeding never
      # registers the site; it signs up at /sites/new like any other.
      { name = "USHER_SEED", value = "mock-site" },
      { name = "USHER_SEED_ORIGIN", value = local.site_url },
    ]
    secrets          = [for k in ["DATABASE_URL", "MODEL_API_KEY", "BASETEN_API_KEY", "USHER_SIGNING_KEY", "USHER_ADMIN_KEY"] : { name = k, valueFrom = local.secret_arn[k] }]
    logConfiguration = local.logging.registry
    linuxParameters  = { initProcessEnabled = true }
  }])
}

resource "aws_ecs_task_definition" "site" {
  family                   = "${var.name}-mock-site"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name         = "site"
    image        = "${aws_ecr_repository.site.repository_url}:${var.image_tag}"
    essential    = true
    portMappings = [{ containerPort = 4100, protocol = "tcp" }]
    environment = concat([
      { name = "NODE_ENV", value = "production" },
      { name = "USHER_REGISTRY_URL", value = local.registry_url },
      { name = "USHER_SITE_ORIGIN", value = local.site_url },
    ], var.mock_site_key == "" ? [] : [{ name = "USHER_SITE_KEY", value = var.mock_site_key }])
    # The same admin key guards the demo's layout switch.
    secrets          = [{ name = "USHER_ADMIN_KEY", valueFrom = local.secret_arn["USHER_ADMIN_KEY"] }]
    logConfiguration = local.logging.site
  }])
}

resource "aws_ecs_service" "registry" {
  name            = "${var.name}-registry"
  cluster         = data.aws_ecs_cluster.cluster.arn
  task_definition = aws_ecs_task_definition.registry.arn
  # Zero until scripts/aws/deploy.sh has an image to run; it sets one task.
  desired_count                      = 0
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
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.registry.id]
    assign_public_ip = var.assign_public_ip
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.registry.arn
    container_name   = "registry"
    container_port   = 4200
  }
  # scripts/aws/deploy.sh rolls new images by registering task definition revisions.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
  depends_on = [aws_lb_listener_rule.registry]
}

resource "aws_ecs_service" "site" {
  name                               = "${var.name}-mock-site"
  cluster                            = data.aws_ecs_cluster.cluster.arn
  task_definition                    = aws_ecs_task_definition.site.arn
  desired_count                      = 0
  launch_type                        = "FARGATE"
  health_check_grace_period_seconds  = 30
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.site.id]
    assign_public_ip = var.assign_public_ip
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.site.arn
    container_name   = "site"
    container_port   = 4100
  }
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
  depends_on = [aws_lb_listener_rule.site]
}
