variable "name" {
  type        = string
  description = "Name prefix applied to every resource's Name tag. Use a short, dash-friendly slug like 'dev' or 'app-staging'."

  validation {
    condition     = can(regex("^[a-z0-9-]{1,32}$", var.name))
    error_message = "name must be 1-32 lowercase chars, digits, or hyphens."
  }
}

variable "cidr_block" {
  type        = string
  description = "CIDR block for the VPC. Must be a valid IPv4 CIDR like 10.0.0.0/16."

  validation {
    condition     = can(cidrhost(var.cidr_block, 0))
    error_message = "cidr_block must be a valid IPv4 CIDR."
  }
}

variable "public_subnets" {
  type        = map(string)
  description = "Map of AZ name to public subnet CIDR. Keys are AZ names (e.g. us-east-1a); values are CIDRs contained within the VPC CIDR. Pass an empty map to skip public subnets entirely."
  default     = {}
}

variable "private_subnets" {
  type        = map(string)
  description = "Map of AZ name to private subnet CIDR. Same shape as public_subnets. Private subnets have no default-route to the IGW; enable a NAT gateway for egress."
  default     = {}
}

variable "enable_nat_gateway" {
  type        = bool
  description = "Provision NAT gateway(s) so private subnets can reach the internet. NAT gateways carry real cost on AWS — leave false for cost-sensitive labs or Moto-only workspaces where the egress path doesn't matter."
  default     = false
}

variable "single_nat_gateway" {
  type        = bool
  description = "When enable_nat_gateway is true, provision exactly one NAT shared across all private subnets instead of one per AZ. Defaults to true to keep cost and resource count down at the price of AZ-local egress redundancy."
  default     = true
}

variable "tags" {
  type        = map(string)
  description = "Extra tags merged onto every resource on top of the caller's provider default_tags."
  default     = {}
}
