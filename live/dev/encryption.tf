# OpenTofu native client-side state encryption (1.7+).
# Encrypts state and plan files using the KMS key created by bootstrap,
# in addition to the S3 SSE-KMS at the storage layer.
terraform {
  encryption {
    key_provider "aws_kms" "state" {
      kms_key_id = "alias/devex-platform-tfstate"
      region     = "us-east-1"
      key_spec   = "AES_256"
    }

    method "aes_gcm" "state" {
      keys = key_provider.aws_kms.state
    }

    state {
      method = method.aes_gcm.state
    }

    plan {
      method = method.aes_gcm.state
    }
  }
}
