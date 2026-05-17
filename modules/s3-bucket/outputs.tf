output "bucket_id" {
  description = "The S3 bucket name (matches the bucket_name input)."
  value       = aws_s3_bucket.this.id
}

output "bucket_name" {
  description = "The bucket's configured name (echo of bucket_name input). Stable under mock_provider; prefer this in plan assertions."
  value       = aws_s3_bucket.this.bucket
}

output "bucket_arn" {
  description = "The S3 bucket ARN."
  value       = aws_s3_bucket.this.arn
}
