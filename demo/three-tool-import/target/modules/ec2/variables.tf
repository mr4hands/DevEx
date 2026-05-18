variable "vpc_id" {
  type        = string
  description = "VPC the SG attaches to. Wired from the vpc module."
}

variable "subnet_id" {
  type        = string
  description = "Subnet the instance launches in. Wired from the vpc module."
}

variable "ami_id" {
  type        = string
  description = "AMI the instance was launched from. Must match the existing instance's AMI."
}

variable "instance_type" {
  type        = string
  description = "EC2 instance type. Must match the existing instance."
  default     = "t3.micro"
}

variable "instance_name_tag" {
  type        = string
  description = "Name tag on the EC2 instance."
}

variable "security_group_name" {
  type        = string
  description = "Name attribute on the security group. AWS treats this as identifying — must match cloud."
}

variable "security_group_description" {
  type        = string
  description = "Description on the security group. AWS treats this as immutable — must match cloud."
}
