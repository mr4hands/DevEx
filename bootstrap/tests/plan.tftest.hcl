mock_provider "aws" {}

variables {
  use_localstack = false
}

run "plan_with_default_inputs" {
  command = plan

  # Pin the account_id so the derived bucket name is deterministic — the
  # mock provider would otherwise stub aws_caller_identity with a random
  # string and the assertion below could never match.
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  # mock_provider stubs the policy JSON with a random string; aws_kms_key
  # validates that its `policy` argument is real JSON at plan time and the
  # plan errors before any assertion runs. Override with a stub that parses.
  override_data {
    target = data.aws_iam_policy_document.tfstate_kms
    values = {
      json = "{}"
    }
  }

  # DynamoDB SSE and S3 SSE validate the kms_key_arn shape; mock_provider's
  # random stub fails ARN parsing. Pin to a well-formed Moto-style ARN.
  override_resource {
    target = aws_kms_key.tfstate
    values = {
      arn = "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000"
    }
  }

  assert {
    condition     = aws_s3_bucket.tfstate.bucket == "devex-platform-tfstate-123456789012-us-east-1"
    error_message = "State bucket name must be devex-platform-tfstate-<account>-<region>."
  }

  assert {
    condition     = aws_dynamodb_table.tfstate_lock.hash_key == "LockID"
    error_message = "Lock table hash_key must be LockID."
  }

  assert {
    condition     = startswith(aws_kms_alias.tfstate.name, "alias/devex-platform-tfstate")
    error_message = "KMS alias must start with alias/devex-platform-tfstate."
  }

  assert {
    condition = one(
      aws_s3_bucket_versioning.tfstate.versioning_configuration
    ).status == "Enabled"
    error_message = "State bucket versioning must be Enabled."
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.tfstate.block_public_acls == true
    error_message = "block_public_acls must be true on the state bucket."
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.tfstate.restrict_public_buckets == true
    error_message = "restrict_public_buckets must be true on the state bucket."
  }
}
