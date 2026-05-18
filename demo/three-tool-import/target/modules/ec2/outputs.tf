output "instance_id" {
  description = "ID of the imported EC2 instance."
  value       = aws_instance.this.id
}

output "security_group_id" {
  description = "ID of the imported security group."
  value       = aws_security_group.this.id
}
