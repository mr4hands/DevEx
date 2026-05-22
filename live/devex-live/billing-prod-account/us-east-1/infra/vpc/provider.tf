# Minimal provider. No backend block — Spacelift manages state per stack.
# No assume_role — Spacelift's per-stack AWS integration injects the account
# role at runtime. The localstack overrides below are no-ops against real AWS
# (use_localstack = false), so the same leaf validates against Moto and AWS.
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge(var.common_tags, { Environment = var.environment })
  }

  access_key                  = var.use_localstack ? "test" : null
  secret_key                  = var.use_localstack ? "test" : null
  skip_credentials_validation = var.use_localstack
  skip_metadata_api_check     = var.use_localstack
  skip_requesting_account_id  = var.use_localstack
  s3_use_path_style           = var.use_localstack

  dynamic "endpoints" {
    for_each = var.use_localstack ? [1] : []
    content {
      ec2      = "http://localhost:4566"
      s3       = "http://localhost:4566"
      sts      = "http://localhost:4566"
      iam      = "http://localhost:4566"
      kms      = "http://localhost:4566"
      dynamodb = "http://localhost:4566"
    }
  }
}
