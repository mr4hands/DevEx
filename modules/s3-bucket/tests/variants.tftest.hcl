mock_provider "aws" {}

variables {
  bucket_name = "devex-platform-s3-module-tftest"
}

run "plan_with_kms_encryption" {
  command = plan

  variables {
    bucket_name = "devex-platform-s3-module-tftest-kms"
    kms_key_arn = "arn:aws:kms:us-east-1:123456789012:key/abcd1234-test"
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.this.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms"
    error_message = "Setting kms_key_arn must switch SSE to aws:kms."
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.this.rule).apply_server_side_encryption_by_default[0].kms_master_key_id == "arn:aws:kms:us-east-1:123456789012:key/abcd1234-test"
    error_message = "kms_key_arn input must flow through to the KMS master key id."
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.this.rule).bucket_key_enabled == true
    error_message = "bucket_key_enabled must be true when SSE-KMS is in use."
  }
}

run "plan_with_versioning_disabled" {
  command = plan

  variables {
    bucket_name       = "devex-platform-s3-module-tftest-noversion"
    enable_versioning = false
  }

  assert {
    condition     = aws_s3_bucket_versioning.this.versioning_configuration[0].status == "Disabled"
    error_message = "enable_versioning = false must produce Disabled status."
  }
}

run "rejects_uppercase_bucket_name" {
  command = plan

  variables {
    bucket_name = "Has-Uppercase"
  }

  expect_failures = [
    var.bucket_name,
  ]
}
