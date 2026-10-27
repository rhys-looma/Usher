# The two ECR repositories, and both images built and pushed to them. Nothing else: the rest of the
# AWS setup is made by hand (DEPLOY.md).
#
#   cd deploy/terraform/ecr
#   terraform init
#   terraform apply -var git_sha=$(git rev-parse --short=12 HEAD)
#
# The push runs scripts/ecr-push.sh (linux/amd64, tagged with the git SHA and latest) whenever the
# SHA changes. It needs Docker with buildx and a clean working tree.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.80" }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "usher", ManagedBy = "terraform" }
  }
}

variable "region" {
  type    = string
  default = "eu-west-2"
}

variable "registry_repo" {
  type    = string
  default = "usher-registry"
}

variable "site_repo" {
  type    = string
  default = "usher-mock-site"
}

variable "git_sha" {
  description = "The commit to build: git rev-parse --short=12 HEAD. The images are tagged with it."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{7,40}$", var.git_sha))
    error_message = "git_sha must be a commit SHA: -var git_sha=$(git rev-parse --short=12 HEAD)."
  }
}

data "aws_caller_identity" "current" {}

# Mutable tags: :latest moves with each push; SHA tags are never reused.
resource "aws_ecr_repository" "usher" {
  for_each             = { registry = var.registry_repo, site = var.site_repo }
  name                 = each.value
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "usher" {
  for_each   = aws_ecr_repository.usher
  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Untagged layers go after a day"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 1 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the 20 most recent images"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }
        action       = { type = "expire" }
      },
    ]
  })
}

resource "terraform_data" "push" {
  triggers_replace = [var.git_sha, aws_ecr_repository.usher["registry"].repository_url, aws_ecr_repository.usher["site"].repository_url]

  provisioner "local-exec" {
    command     = "scripts/ecr-push.sh"
    working_dir = "${path.module}/../../.."
    environment = {
      AWS_ACCOUNT_ID = data.aws_caller_identity.current.account_id
      AWS_REGION     = var.region
      REGISTRY_REPO  = aws_ecr_repository.usher["registry"].name
      SITE_REPO      = aws_ecr_repository.usher["site"].name
      EXPECTED_SHA   = var.git_sha
    }
  }
}

output "repositories" {
  value = { for k, r in aws_ecr_repository.usher : k => r.repository_url }
}

output "images" {
  description = "What the ECS task definitions run."
  value       = { for k, r in aws_ecr_repository.usher : k => "${r.repository_url}:${var.git_sha}" }
  depends_on  = [terraform_data.push]
}
