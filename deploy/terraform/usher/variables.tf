variable "region" {
  type    = string
  default = "eu-west-2"
}

variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "usher"
}

variable "registry_host" {
  description = "The registry's host name (the apex domain)."
  type        = string
}

variable "site_host" {
  description = "The demo site's host name."
  type        = string
}

variable "image_tag" {
  description = "The image tag pushed by deploy/terraform/ecr (the git SHA). Later deploys: scripts/ecs-deploy.sh."
  type        = string
}

variable "contact_email" {
  description = "Named on /privacy and in /.well-known/security.txt."
  type        = string
}

variable "daily_model_budget_usd" {
  type    = string
  default = "5"
}

variable "mock_site_key" {
  description = "The demo site's public site key, from /sites/new. Empty until it is registered."
  type        = string
  default     = ""
}

variable "certificates_issued" {
  description = "Phase 2: set true once both certificates are issued (validation records in DNS)."
  type        = bool
  default     = false
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "db_instance_class" {
  description = "The smallest Graviton class; enough for the registry."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_backup_retention_days" {
  type    = number
  default = 7
}

variable "log_retention_days" {
  type    = number
  default = 30
}
