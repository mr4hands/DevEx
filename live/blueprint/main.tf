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

# Blueprint resources land below this line. The DevEx Platform UI's
# Blueprint tab is the primary writer; manual edits are supported but
# the canvas will reorganize the layout on next load.
