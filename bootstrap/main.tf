provider "aws" {
  region = var.aws_region

  default_tags {
    tags = var.common_tags
  }

  # LocalStack-only overrides. When use_localstack = false, every line below
  # becomes a no-op (null/false) and the provider behaves as real AWS.
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

data "aws_caller_identity" "current" {}

locals {
  account_id      = data.aws_caller_identity.current.account_id
  bucket_name     = "${var.name_prefix}-tfstate-${local.account_id}-${var.aws_region}"
  lock_table_name = "${var.name_prefix}-tfstate-locks"
  kms_alias_name  = "alias/${var.name_prefix}-tfstate"
}

# KMS key used by OpenTofu native state encryption (1.7+) and S3 SSE-KMS.
resource "aws_kms_key" "tfstate" {
  description             = "Encrypts OpenTofu state and plan artifacts for ${var.name_prefix}."
  deletion_window_in_days = 7
  enable_key_rotation     = true
}

resource "aws_kms_alias" "tfstate" {
  name          = local.kms_alias_name
  target_key_id = aws_kms_key.tfstate.key_id
}

# S3 bucket holding remote state.
resource "aws_s3_bucket" "tfstate" {
  bucket = local.bucket_name
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.tfstate.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# DynamoDB table for state locking.
resource "aws_dynamodb_table" "tfstate_lock" {
  name         = local.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}
