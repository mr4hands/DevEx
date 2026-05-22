variable "aws_region" {
  type        = string
  description = "Region this stack deploys into. Per-stack input (set in terraform.tfvars); the leaf's region path segment must match."
}

variable "environment" {
  type        = string
  description = "Environment name for tagging. With env == account, this mirrors the account's environment (e.g. prod)."
}

variable "common_tags" {
  type        = map(string)
  description = "Cross-cutting default_tags applied to every resource. Environment is merged on top from var.environment."
  default = {
    Project   = "DevEx"
    ManagedBy = "OpenTofu"
  }
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for this stack's VPC. Per-stack input."
}

variable "public_subnets" {
  type        = map(string)
  description = "Map of AZ name to public subnet CIDR for this stack. Per-stack input."
  default     = {}
}

variable "use_localstack" {
  type        = bool
  description = "When true, point the provider at the local Moto emulator. Set via TF_VAR_use_localstack (dev.local.env); a no-op against real AWS, where Spacelift's per-stack AWS integration supplies credentials."
  default     = false
}
