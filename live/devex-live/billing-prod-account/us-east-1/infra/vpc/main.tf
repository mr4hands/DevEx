# Thin leaf: a single module instantiation. No resource logic lives here —
# it's all in the versioned catalog module. Per-stack values come from
# variables (terraform.tfvars); the rest is the module's job.
module "vpc" {
  # POC: this repo's catalog module by relative path (offline, no auth needed).
  # Real devex-live: source = "git::https://…/devex-modules.git//vpc?ref=vX.Y.Z"
  source = "../../../../../../modules/vpc"

  name           = "billing-prod-vpc"
  cidr_block     = var.vpc_cidr
  public_subnets = var.public_subnets

  tags = {
    Component = "vpc"
    Layer     = "infra"
  }
}
