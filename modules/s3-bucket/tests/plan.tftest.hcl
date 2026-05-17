mock_provider "aws" {}

variables {
  bucket_name = "devex-platform-s3-module-tftest"
}

run "plan_with_minimum_inputs" {
  command = plan

  assert {
    condition     = output.bucket_id != null && output.bucket_id != ""
    error_message = "bucket_id output must be non-empty."
  }

  assert {
    condition     = output.bucket_arn != null && output.bucket_arn != ""
    error_message = "bucket_arn output must be non-empty."
  }

  assert {
    condition = one(
      aws_s3_bucket_versioning.this.versioning_configuration
    ).status == "Enabled"
    error_message = "Default versioning_configuration.status must be Enabled."
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.this.block_public_acls == true
    error_message = "block_public_acls must be true."
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.this.restrict_public_buckets == true
    error_message = "restrict_public_buckets must be true."
  }
}
