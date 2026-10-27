# Usher on AWS: the new pieces only. The ECS cluster, VPC, subnets and ALB already exist and are
# inputs. State holds the database password: keep it in an encrypted S3 bucket (see DEPLOY.md).

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.80" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Partial configuration: terraform init -backend-config=backend.hcl
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "usher", ManagedBy = "terraform" }
  }
}
