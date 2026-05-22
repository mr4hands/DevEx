# Per-stack inputs (non-secret shape). Region must match the leaf's path
# segment. Secrets / cross-cutting account context come from Spacelift
# contexts (TF_VAR_*), not this file.
aws_region  = "us-east-1"
environment = "prod"

vpc_cidr = "10.20.0.0/16"
public_subnets = {
  "us-east-1a" = "10.20.1.0/24"
  "us-east-1b" = "10.20.2.0/24"
}
