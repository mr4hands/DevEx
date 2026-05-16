variable "bucket_name" {
  type        = string
  description = "Globally-unique S3 bucket name. Must follow DNS naming rules (3-63 lowercase chars, digits, dots, or hyphens)."

  validation {
    condition     = can(regex("^[a-z0-9.-]{3,63}$", var.bucket_name))
    error_message = "bucket_name must be 3-63 lowercase chars, digits, dots, or hyphens."
  }
}

variable "tags" {
  type        = map(string)
  description = "Tags merged onto the bucket on top of the caller's provider default_tags."
  default     = {}
}

variable "enable_versioning" {
  type        = bool
  description = "Whether to enable S3 object versioning. Defaults to true so accidental deletes and overwrites are recoverable."
  default     = true
}

variable "kms_key_arn" {
  type        = string
  description = "Optional KMS key ARN for SSE-KMS encryption. When null, SSE-S3 (AES256) is used."
  default     = null
}
