variable "aws_region" {
  type        = string
  description = "AWS region for backend resources."
  default     = "us-east-1"
}

variable "name_prefix" {
  type        = string
  description = "Prefix applied to all backend resource names. Change once; everything else follows."
  default     = "devex-platform"
}

variable "common_tags" {
  type        = map(string)
  description = "Tags applied to all bootstrap resources via the provider default_tags block."
  default = {
    Project   = "DevEx-Platform"
    Component = "iac-bootstrap"
    ManagedBy = "OpenTofu"
  }
}

variable "use_localstack" {
  type        = bool
  description = "When true, point the AWS provider at LocalStack (http://localhost:4566) and skip credential/metadata validation. Set via TF_VAR_use_localstack=true (dev.local.env)."
  default     = false
}
