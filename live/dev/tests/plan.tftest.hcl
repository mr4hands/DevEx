mock_provider "aws" {}

variables {
  use_localstack = false
}

run "plan_with_defaults" {
  command = plan

  assert {
    condition     = module.network.vpc_cidr_block == "10.20.0.0/16"
    error_message = "live/dev VPC CIDR must be 10.20.0.0/16."
  }

  assert {
    condition     = length(module.network.public_subnet_ids) == 2
    error_message = "live/dev must plan exactly 2 public subnets."
  }

  assert {
    condition     = length(module.network.private_subnet_ids) == 2
    error_message = "live/dev must plan exactly 2 private subnets."
  }

  assert {
    condition     = length(module.network.nat_gateway_ids) == 0
    error_message = "live/dev must keep NAT gateways off (enable_nat_gateway = false)."
  }

  assert {
    condition     = module.logs_bucket.bucket_name == "devex-platform-logs-dev"
    error_message = "Logs bucket name must be devex-platform-logs-dev."
  }
}
