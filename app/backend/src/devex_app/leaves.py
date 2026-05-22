"""Leaf path math, coord validation, and per-leaf boilerplate for the
devex-live overlay. A leaf is account/region/layer/component."""

from __future__ import annotations

import re

# Path segments become directory names, so they must be safe path components:
# lowercase letters, digits, hyphens; no separators, dots, or spaces.
_COORD_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def validate_coord(value: str) -> str:
    if not _COORD_RE.fullmatch(value):
        raise ValueError(
            f"Invalid coord {value!r}: 1-64 chars, lowercase/digits/hyphen, "
            "no separators or dots."
        )
    return value


def leaf_relpath(account: str, region: str, layer: str, component: str) -> str:
    parts = [
        validate_coord(account),
        validate_coord(region),
        validate_coord(layer),
        validate_coord(component),
    ]
    return "/".join(parts)


BOILERPLATE_FILENAMES = frozenset(
    {"versions.tf", "variables.tf", "provider.tf", "terraform.tfvars"}
)

_VERSIONS_TF = """\
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
"""

_VARIABLES_TF = """\
variable "aws_region" {
  type        = string
  description = "Region this stack deploys into (per-stack input)."
}

variable "environment" {
  type        = string
  description = "Environment name for tagging (env == account)."
}

variable "common_tags" {
  type        = map(string)
  description = "Cross-cutting default_tags; Environment is merged on top."
  default = {
    Project   = "DevEx"
    ManagedBy = "OpenTofu"
  }
}

variable "use_localstack" {
  type        = bool
  description = "Point the provider at Moto. Set via TF_VAR_use_localstack; a no-op against real AWS where Spacelift injects the account role."
  default     = false
}
"""

_PROVIDER_TF = """\
# Minimal provider. Spacelift owns state per stack (none declared here). No
# assume_role — Spacelift's per-stack AWS integration injects the account role.
# The localstack overrides are no-ops against real AWS.
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge(var.common_tags, { Environment = var.environment })
  }

  access_key                  = var.use_localstack ? "test" : null
  secret_key                  = var.use_localstack ? "test" : null
  skip_credentials_validation = var.use_localstack
  skip_metadata_api_check     = var.use_localstack
  skip_requesting_account_id  = var.use_localstack
  s3_use_path_style           = var.use_localstack

  dynamic "endpoints" {
    for_each = var.use_localstack ? [1] : []
    content {
      ec2      = "http://localhost:4566"
      s3       = "http://localhost:4566"
      sts      = "http://localhost:4566"
      iam      = "http://localhost:4566"
      kms      = "http://localhost:4566"
      dynamodb = "http://localhost:4566"
    }
  }
}
"""


def boilerplate_files(*, aws_region: str, environment: str) -> dict[str, str]:
    tfvars = (
        "# Per-stack inputs (non-secret). Secrets go to Spacelift contexts.\n"
        f'aws_region  = "{aws_region}"\n'
        f'environment = "{environment}"\n'
    )
    return {
        "versions.tf": _VERSIONS_TF,
        "variables.tf": _VARIABLES_TF,
        "provider.tf": _PROVIDER_TF,
        "terraform.tfvars": tfvars,
    }
