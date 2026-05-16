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

run "plan_with_single_nat_gateway" {
  command = plan

  variables {
    enable_nat_gateway = true
    single_nat_gateway = true
  }

  assert {
    condition     = length(output.nat_gateway_ids) == 1
    error_message = "single_nat_gateway must produce exactly one NAT gateway regardless of private subnet count."
  }
}

run "plan_with_nat_per_az" {
  command = plan

  variables {
    enable_nat_gateway = true
    single_nat_gateway = false
  }

  assert {
    condition     = length(output.nat_gateway_ids) == length(var.private_subnets)
    error_message = "With single_nat_gateway = false, NAT gateway count must match private subnet count."
  }
}

run "plan_skips_nat_when_disabled" {
  command = plan

  variables {
    enable_nat_gateway = false
    single_nat_gateway = false
  }

  assert {
    condition     = length(output.nat_gateway_ids) == 0
    error_message = "enable_nat_gateway = false must skip NAT regardless of single_nat_gateway."
  }
}

run "rejects_invalid_cidr" {
  command = plan

  variables {
    cidr_block = "not-a-cidr"
  }

  expect_failures = [
    var.cidr_block,
  ]
}

run "rejects_uppercase_name" {
  command = plan

  variables {
    name = "Has-Uppercase"
  }

  expect_failures = [
    var.name,
  ]
}
