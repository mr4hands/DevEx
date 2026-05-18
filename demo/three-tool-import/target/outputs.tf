output "vpc_id" {
  description = "VPC ID, now under OpenTofu management."
  value       = module.vpc.vpc_id
}

output "subnet_id" {
  description = "Subnet ID, now under OpenTofu management."
  value       = module.vpc.subnet_id
}

output "instance_id" {
  description = "EC2 instance ID, now under OpenTofu management."
  value       = module.ec2.instance_id
}

output "security_group_id" {
  description = "Security group ID, now under OpenTofu management."
  value       = module.ec2.security_group_id
}
