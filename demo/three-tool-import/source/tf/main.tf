terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

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
      ManagedBy    = "Terraform"
      Origin       = "team-platform"
      DemoArtifact = "three-tool-import"
    }
  }
}

resource "aws_vpc" "this" {
  cidr_block           = "10.99.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "imported-from-tf"
  }
}

output "vpc_id" {
  value = aws_vpc.this.id
}
