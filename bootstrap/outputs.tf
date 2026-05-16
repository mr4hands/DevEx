output "state_bucket_name" {
  value       = aws_s3_bucket.tfstate.id
  description = "S3 bucket holding OpenTofu remote state."
}

output "state_lock_table_name" {
  value       = aws_dynamodb_table.tfstate_lock.name
  description = "DynamoDB table used for state locking."
}

output "state_kms_key_arn" {
  value       = aws_kms_key.tfstate.arn
  description = "KMS key ARN used for state encryption."
}

output "state_kms_alias" {
  value       = aws_kms_alias.tfstate.name
  description = "KMS alias for state encryption. Reference this from live configs."
}

output "aws_region" {
  value       = var.aws_region
  description = "Region where backend resources live."
}
