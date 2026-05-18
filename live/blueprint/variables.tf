variable "aws_region" {
  type        = string
  description = "AWS region for the blueprint workspace's provider."
  default     = "us-east-1"
}

variable "use_localstack" {
  type        = bool
  description = "When true, point the provider at Moto/LocalStack at http://localhost:4566 for local dev. Defaults to false so a fresh shell talks to real AWS."
  default     = false
}

variable "common_tags" {
  type        = map(string)
  description = "default_tags applied to every resource the blueprint creates."
  default = {
    Project     = "DevEx-Platform"
    Environment = "blueprint"
    ManagedBy   = "OpenTofu"
  }
}
