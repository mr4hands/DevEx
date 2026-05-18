variable "vpc_id" {
  type        = string
  description = "Cloud ID of the VPC originally created via Terraform. Sourced from source/ids.env."
}

variable "subnet_id" {
  type        = string
  description = "Cloud ID of the subnet originally created via Terragrunt. Sourced from source/ids.env."
}

variable "instance_id" {
  type        = string
  description = "Cloud ID of the EC2 instance originally created via CDKTF. Sourced from source/ids.env."
}

variable "security_group_id" {
  type        = string
  description = "Cloud ID of the security group originally created via CDKTF. Sourced from source/ids.env."
}

variable "ami_id" {
  type        = string
  description = "AMI ID the imported instance was launched from. Sourced from source/ids.env."
}
