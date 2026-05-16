terraform {
  # Partial backend config. Concrete values come from backend.hcl at init time:
  #   tofu init -backend-config=backend.hcl
  backend "s3" {
    encrypt = true
  }
}
