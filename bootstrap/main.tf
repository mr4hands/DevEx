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
  policy                  = data.aws_iam_policy_document.tfstate_kms.json
}

# Locked-down key policy: account root has full admin; no broader grants.
# This is the AWS-recommended default key policy — it delegates auth to IAM
# so individual users/roles in this account control access via their own
# policies. Within a key policy, `resources = ["*"]` resolves to "this
# key" — the policy itself can't reference other resources.
data "aws_iam_policy_document" "tfstate_kms" {
  # checkov:skip=CKV_AWS_111: Account-root-as-admin is the default key policy pattern; delegates auth to IAM rather than maintaining a sprawling explicit grant list.
  # checkov:skip=CKV_AWS_356: In a KMS key policy, `resources = ["*"]` means "this key" — the policy itself cannot reference other resources.
  # checkov:skip=CKV_AWS_109: Same IAM-delegation pattern; permissions management is gated by the account root's own IAM policies.
  statement {
    sid    = "AllowAccountRootFullAdmin"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }
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

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.tfstate.arn
  }
}
