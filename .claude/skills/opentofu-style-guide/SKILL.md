---
name: opentofu-style-guide
description: Enforce OpenTofu/HCL conventions for the DevEx Platform repo — file layout, naming, tagging, variable typing, iteration choice, module boundaries, state safety, and per-module test requirements. Load when authoring or editing any .tf, .tofu, or .tfvars file in this workspace.
---

# OpenTofu style guide

You are editing OpenTofu HCL in the DevEx Platform repo. Apply every rule
below to every change. If a rule is impossible to apply for a specific reason,
say so explicitly in your response — never silently skip.

## File layout (per directory)

Each config directory contains, in this order:

1. `versions.tf` — `terraform { required_version, required_providers, encryption }`.
2. `variables.tf` — all `variable` blocks.
3. `locals.tf` — only when locals are non-trivial; inline otherwise.
4. `main.tf` — providers and resources/data sources.
5. `outputs.tf` — all `output` blocks.
6. `backend.tf` — when this dir has a remote backend.

Never split resources across `main.tf` and ad-hoc `*.tf` files unless the
directory has >300 lines of resources. If splitting, group by domain
(e.g., `network.tf`, `iam.tf`, `compute.tf`).

## Naming

- `snake_case` for every resource label, variable name, output name, local name.
- Resource labels describe purpose, not type: `aws_s3_bucket.logs` not
  `aws_s3_bucket.logs_bucket`.
- Module directories use `kebab-case`: `modules/s3-bucket/`, not `s3_bucket`.
- Avoid `this` as a resource label except in single-resource modules where
  no other label would be more descriptive.

## Variables

- Always set `type`. Use precise object/map types instead of `any`.
- Always set `description`. Describe the *purpose*, not the type.
- Set `sensitive = true` on anything that could carry credentials, keys, or
  customer data.
- Set sensible `default`s only for genuinely optional inputs. Required inputs
  have no default.
- Add `validation` blocks for inputs with non-obvious constraints
  (allowed values, length, regex).

```hcl
variable "bucket_name" {
  type        = string
  description = "Globally-unique S3 bucket name. Must follow DNS naming rules."
  validation {
    condition     = can(regex("^[a-z0-9.-]{3,63}$", var.bucket_name))
    error_message = "bucket_name must be 3-63 lowercase chars, digits, dots, or hyphens."
  }
}
```

## Outputs

- Always set `description`.
- Set `sensitive = true` if the output could surface in logs and would leak
  anything.
- Outputs are the module's public contract. Removing or renaming one is a
  breaking change — flag it explicitly in any refactor.

## Tagging

Every AWS provider block sets `default_tags` with at least:

```hcl
default_tags {
  tags = {
    Project     = "DevEx-Platform"
    Environment = "dev"   # or staging/prod
    ManagedBy   = "OpenTofu"
  }
}
```

Resource-specific tags merge on top via the resource's own `tags` argument —
they do NOT replace `default_tags`.

## Iteration

- Prefer `for_each` with a stable key set (map or set of strings) over `count`.
  Reordering a list with `count` rebuilds every resource after the change.
- Use `count` only for `0`-or-`1` conditional resources.

```hcl
# Good
resource "aws_s3_bucket" "log" {
  for_each = toset(var.log_bucket_names)
  bucket   = each.value
}

# Avoid (unless toggling existence)
resource "aws_s3_bucket" "log" {
  count  = length(var.log_bucket_names)
  bucket = var.log_bucket_names[count.index]
}
```

## Modules

- Modules do NOT contain `provider` blocks. The caller passes providers.
- Module inputs are documented via `description` on each `variable`.
- Module outputs are documented via `description` on each `output`.
- Modules ship with at least one `.tftest.hcl` exercising a `plan` against
  required inputs and asserting required outputs exist.
- For registry modules, pin `source` with `version = "~> X.Y"` — never an
  unpinned major.

## State safety

- Never edit state with `state rm`, `state mv`, `state push`, or
  `force-unlock`. These are denied in `settings.json`.
- For refactors that move resources between addresses, emit `moved { }` blocks:

```hcl
moved {
  from = aws_s3_bucket.old_name
  to   = module.s3_bucket.aws_s3_bucket.this
}
```

- Always commit `.terraform.lock.hcl`.

## Encryption

`live/*/` root configs include the OpenTofu native client-side state
encryption block (`terraform { encryption { ... } }`) keyed to the
`alias/devex-platform-tfstate` KMS key created by `bootstrap/`. Do not remove
or weaken this block.

## Before declaring a change done

Run, in order:

1. `tofu fmt -recursive` — pre-allowed.
2. `tofu validate` — pre-allowed.
3. `tofu plan -out=plan.tfplan` — pre-allowed. Read the plan carefully.
4. Report the plan summary to the user. **Do not run `apply`**; that's
   denied in settings and reserved for human invocation.

If `checkov` is installed, run `checkov -d <changed-dir> --quiet --compact`
before reporting done. Treat HIGH/CRITICAL findings as blocking; document
any explicit skip in `policies/checkov-skip.yaml` with a reason.
