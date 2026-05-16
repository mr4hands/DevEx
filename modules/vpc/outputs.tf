output "vpc_id" {
  description = "The VPC ID."
  value       = aws_vpc.this.id
}

output "vpc_cidr_block" {
  description = "The VPC's CIDR block (mirrors the cidr_block input)."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Map of AZ name to public subnet ID."
  value       = { for k, s in aws_subnet.public : k => s.id }
}

output "private_subnet_ids" {
  description = "Map of AZ name to private subnet ID."
  value       = { for k, s in aws_subnet.private : k => s.id }
}

output "internet_gateway_id" {
  description = "The Internet Gateway attached to the VPC."
  value       = aws_internet_gateway.this.id
}

output "nat_gateway_ids" {
  description = "Map of AZ name to NAT Gateway ID. Empty when enable_nat_gateway is false."
  value       = { for k, n in aws_nat_gateway.this : k => n.id }
}
