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
}
