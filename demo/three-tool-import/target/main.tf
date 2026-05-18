provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  endpoints {
    ec2 = "http://localhost:4566"
    sts = "http://localhost:4566"
    iam = "http://localhost:4566"
  }

  default_tags {
    tags = {
      Project     = "DevEx-Platform"
      Environment = "demo-import"
      ManagedBy   = "OpenTofu"
    }
  }
}

# ---------------------------------------------------------------------------
# Two modules wired together.
# vpc creates the VPC + subnet (originally from TF + Terragrunt).
# ec2 consumes vpc's outputs and owns the SG + instance (originally from CDKTF).
# ---------------------------------------------------------------------------

module "vpc" {
  source = "./modules/vpc"

  vpc_cidr_block    = "10.99.0.0/16"
  subnet_cidr_block = "10.99.5.0/24"
  availability_zone = "us-east-1a"
  vpc_name_tag      = "imported-from-tf"
  subnet_name_tag   = "imported-from-tg"
}

module "ec2" {
  source = "./modules/ec2"

  vpc_id                     = module.vpc.vpc_id
  subnet_id                  = module.vpc.subnet_id
  ami_id                     = var.ami_id
  instance_type              = "t3.micro"
  instance_name_tag          = "imported-from-cdktf"
  security_group_name        = "imported-from-cdktf-sg"
  security_group_description = "Allow nothing; demo SG attached to imported EC2."
}

# ---------------------------------------------------------------------------
# Imports: one block per resource the source tools created, addressed through
# the module path so state lands at the right hierarchical location.
# ---------------------------------------------------------------------------

# From Terraform (source/tf)
import {
  to = module.vpc.aws_vpc.this
  id = var.vpc_id
}

# From Terragrunt (source/tg)
import {
  to = module.vpc.aws_subnet.this
  id = var.subnet_id
}

# From CDKTF (source/cdktf) -- security group
import {
  to = module.ec2.aws_security_group.this
  id = var.security_group_id
}

# From CDKTF (source/cdktf) -- EC2 instance
import {
  to = module.ec2.aws_instance.this
  id = var.instance_id
}
