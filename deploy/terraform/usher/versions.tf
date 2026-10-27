# Usher on ECS behind CloudFront, all new: its own VPC, an ALB, the cluster and both services,
# a small private Postgres, the five secrets, the certificates and the CloudFront distribution.
# It changes nothing that already exists.
# Images come from deploy/terraform/ecr. Two phases (see DEPLOY.md):
#
#   terraform apply                                  certificates, network, database, cluster, roles, secrets
#   (add the certificate validation records to DNS, put the secret values)
#   terraform apply -var certificates_issued=true    ALB listener, services, CloudFront

terraform {
  # Write-only arguments and ephemeral resources keep the database password out of state.
  required_version = ">= 1.11"
  required_providers {
    aws    = { source = "hashicorp/aws", version = ">= 5.90, < 6.0" }
    random = { source = "hashicorp/random", version = ">= 3.7" }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "usher", ManagedBy = "terraform" }
  }
}

# CloudFront only uses certificates from us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = { Project = "usher", ManagedBy = "terraform" }
  }
}
