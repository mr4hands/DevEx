variable "instance_name" {
  type        = string
  description = "Name tag applied to the EC2 instance and its security group."
}

variable "ami_id" {
  type        = string
  description = "AMI ID to launch. Caller is responsible for selecting the correct AMI for the target region."
}

variable "instance_type" {
  type        = string
  description = "EC2 instance type."
  default     = "t3.micro"
}

variable "vpc_id" {
  type        = string
  description = "ID of the VPC in which to create the security group and instance."
}

variable "subnet_id" {
  type        = string
  description = "ID of the subnet in which to launch the instance."
}

variable "allowed_cidrs" {
  type        = list(string)
  description = "CIDR blocks permitted to reach ports 22 (SSH) and 443 (HTTPS) on the instance."
}
