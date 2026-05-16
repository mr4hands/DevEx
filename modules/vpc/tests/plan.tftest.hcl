mock_provider "aws" {}

variables {
  name       = "tftest"
  cidr_block = "10.0.0.0/16"
  public_subnets = {
    "us-east-1a" = "10.0.1.0/24"
    "us-east-1b" = "10.0.2.0/24"
  }
  private_subnets = {
    "us-east-1a" = "10.0.11.0/24"
    "us-east-1b" = "10.0.12.0/24"
  }
}

run "plan_with_minimum_inputs" {
  command = plan

  assert {
    condition     = output.vpc_id != null && output.vpc_id != ""
    error_message = "vpc_id output must be non-empty."
  }

  assert {
    condition     = output.vpc_cidr_block == "10.0.0.0/16"
    error_message = "vpc_cidr_block output must mirror the cidr_block input."
  }

  assert {
    condition     = length(output.public_subnet_ids) == 2
    error_message = "public_subnet_ids must have one entry per public subnet."
  }

  assert {
    condition     = length(output.private_subnet_ids) == 2
    error_message = "private_subnet_ids must have one entry per private subnet."
  }

  assert {
    condition     = output.internet_gateway_id != null && output.internet_gateway_id != ""
    error_message = "internet_gateway_id must be non-empty."
  }

  assert {
    condition     = length(output.nat_gateway_ids) == 0
    error_message = "nat_gateway_ids must be empty when enable_nat_gateway is false."
  }
}
