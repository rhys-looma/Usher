variable "region" {
  type    = string
  default = "eu-west-2"
}

variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "usher"
}

# Existing infrastructure.
variable "cluster_name" {
  description = "The existing ECS cluster."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Subnets for the tasks and the database: private subnets with a NAT gateway, or public subnets with assign_public_ip = true. At least two, in different availability zones."
  type        = list(string)
}

variable "assign_public_ip" {
  description = "True when subnet_ids are public subnets without a NAT gateway (tasks need outbound internet: images, model APIs, sites to map)."
  type        = bool
  default     = false
}

variable "alb_arn" {
  description = "The existing internet-facing ALB."
  type        = string
}

variable "listener_port" {
  description = "The ALB's HTTPS listener."
  type        = number
  default     = 443
}

variable "rule_priorities" {
  description = "Listener rule priorities for the registry and the demo site; must be free on the listener."
  type        = object({ registry = number, site = number })
  default     = { registry = 100, site = 101 }
}

# Hosts.
variable "registry_host" {
  description = "The registry's host name (the front page, dashboard, API, /usher.js). REGISTRY_PUBLIC_URL is https://<this>."
  type        = string
}

variable "site_host" {
  description = "The demo quote site's host name."
  type        = string
}

variable "attach_certificate" {
  description = "Set true once the certificate's DNS validation records are in place: waits for it to be issued and adds it to the listener."
  type        = bool
  default     = false
}

# Application settings (not secret).
variable "image_tag" {
  description = "Image tag in the task definitions Terraform writes. Services start at zero tasks; scripts/aws/deploy.sh registers revisions with each pushed git SHA."
  type        = string
  default     = "latest"
}

variable "daily_model_budget_usd" {
  description = "Hard daily cap on model spend, in dollars."
  type        = string
  default     = "5"
}

variable "contact_email" {
  description = "Named on /privacy and in /.well-known/security.txt."
  type        = string
}

variable "mock_site_key" {
  description = "The demo site's public site key, from registering it at /sites/new. Empty until then."
  type        = string
  default     = ""
}

# Sizes.
variable "registry_cpu" {
  type    = number
  default = 1024
}

variable "registry_memory" {
  description = "MiB. At least 2048: the map viewer runs Chromium."
  type        = number
  default     = 2048
  validation {
    condition     = var.registry_memory >= 2048
    error_message = "The registry needs at least 2048 MiB for Chromium."
  }
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "GiB."
  type        = number
  default     = 20
}

variable "backup_retention_days" {
  type    = number
  default = 7
}

variable "log_retention_days" {
  type    = number
  default = 30
}
