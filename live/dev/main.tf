provider "aws" {
  region = var.aws_region

  default_tags {
    tags = var.common_tags
  }

  # LocalStack-only overrides (no-ops when use_localstack = false).
  access_key                  = var.use_localstack ? "test" : null
  secret_key                  = var.use_localstack ? "test" : null
  skip_credentials_validation = var.use_localstack
  skip_metadata_api_check     = var.use_localstack
  skip_requesting_account_id  = var.use_localstack
  s3_use_path_style           = var.use_localstack

  dynamic "endpoints" {
    for_each = var.use_localstack ? [1] : []
    content {
      s3       = "http://localhost:4566"
      dynamodb = "http://localhost:4566"
      kms      = "http://localhost:4566"
      iam      = "http://localhost:4566"
      sts      = "http://localhost:4566"
      ec2      = "http://localhost:4566"
    }
  }
}

module "logs_bucket" {
  source = "../../modules/s3-bucket"

  bucket_name = "devex-platform-logs-dev"
}

module "network" {
  source = "../../modules/vpc"

  name       = "dev"
  cidr_block = "10.20.0.0/16"

  public_subnets = {
    "us-east-1a" = "10.20.1.0/24"
    "us-east-1b" = "10.20.2.0/24"
  }

  private_subnets = {
    "us-east-1a" = "10.20.11.0/24"
    "us-east-1b" = "10.20.12.0/24"
  }

  # NAT off by default: real AWS charges per gateway, Moto doesn't need
  # internet egress to be functional. Flip on when private workloads
  # actually need outbound traffic.
  enable_nat_gateway = false
}
