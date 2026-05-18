output "vpc_id" {
  description = "ID of the imported VPC."
  value       = aws_vpc.this.id
}

output "subnet_id" {
  description = "ID of the imported public subnet."
  value       = aws_subnet.this.id
}
