variable "vpc_cidr_block" {
  type        = string
  description = "CIDR for the VPC. Must match the VPC that was previously created out-of-band."
}

variable "subnet_cidr_block" {
  type        = string
  description = "CIDR for the public subnet. Must match the subnet created out-of-band."
}

variable "availability_zone" {
  type        = string
  description = "AZ for the subnet. Must match the subnet's existing AZ."
}

variable "vpc_name_tag" {
  type        = string
  description = "Value of the Name tag on the VPC."
}

variable "subnet_name_tag" {
  type        = string
  description = "Value of the Name tag on the subnet."
}
