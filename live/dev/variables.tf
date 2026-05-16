variable "aws_region" {
  type        = string
  description = "AWS region for live/dev resources."
  default     = "us-east-1"
}

variable "common_tags" {
  type        = map(string)
  description = "Tags applied to all live/dev resources via the provider default_tags block."
  default = {
    Project     = "DevEx-Platform"
    Environment = "dev"
    ManagedBy   = "OpenTofu"
  }
}

variable "use_localstack" {
  type        = bool
  description = "When true, point the AWS provider at LocalStack (http://localhost:4566) and skip credential/metadata validation. Set via TF_VAR_use_localstack=true (dev.local.env)."
  default     = false
}
