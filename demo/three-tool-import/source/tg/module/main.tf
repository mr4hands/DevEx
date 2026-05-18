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
      ManagedBy    = "Terragrunt"
      Origin       = "team-network"
      DemoArtifact = "three-tool-import"
    }
  }
}

variable "vpc_id" {
  type = string
}

variable "cidr_block" {
  type = string
}

variable "availability_zone" {
  type = string
}

resource "aws_subnet" "this" {
  vpc_id                  = var.vpc_id
  cidr_block              = var.cidr_block
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = true

  tags = {
    Name = "imported-from-tg"
  }
}

output "subnet_id" {
  value = aws_subnet.this.id
}
