---
name: opentofu-aws-import
description: Bring out-of-band-created AWS resources under OpenTofu management via the `import { }` block + `tofu plan -generate-config-out`. Load when the user mentions importing AWS resources, ClickOps cleanup, "this bucket/role/instance exists already", "unmanaged", "bring under management", "out-of-band", or asks how to adopt an existing resource. Authors changes on a branch and runs read-only verification; never runs `tofu import` (denied), `tofu apply` (denied), or any state mutation.
---

# OpenTofu AWS import

You bring existing AWS resources (real or in Moto) under OpenTofu
management using the modern `import { }` block flow. The classic
`tofu import` CLI is denied in `settings.json` — and you wouldn't want
it anyway, because it imports without a corresponding HCL block, leaving
state and code out of sync.

Your output is always one of:

1. A clean "this resource is already managed" report (with the address).
2. A branch with an `import { }` block, a refined resource definition,
   and a `tofu plan` showing import-only changes — staged, not
   committed, not pushed.
3. A "can't safely import" report explaining why (missing required
   args, composite ID format unknown, conflicting state, etc.).

## When to invoke

Trigger on: "import", "click-ops", "this bucket / role / instance / VPC
already exists", "unmanaged", "bring under management", "out-of-band
created", "we made it in the console", "adopt this resource".

If the user mentions drift instead, route to `opentofu-drift-detect`.
The boundary: drift-detect handles "state and cloud disagree";
aws-import handles "cloud has something state doesn't know about".

## Detection flow

1. **Confirm the target resource exists** via read-only AWS CLI. Use the
   pre-allowed `aws s3api get-bucket-*`, `aws iam list-*`, `aws ec2
   describe-*`, etc. Record the resource's natural ID — the format
   varies:
   - S3 bucket: bucket name (`my-bucket-name`)
   - EC2 instance: instance ID (`i-0abc1234...`)
   - IAM role / user / policy: name (`my-role`)
   - VPC / subnet: VPC or subnet ID (`vpc-0abc...`, `subnet-0def...`)
   - Composite resources: `<parent-id>,<suffix>` — provider docs are
     authoritative. Examples:
     - `aws_s3_bucket_versioning`: `bucket-name`
     - `aws_s3_bucket_policy`: `bucket-name`
     - `aws_iam_role_policy_attachment`: `role-name/policy-arn`
   - When unsure, search the provider's "Import" section in
     terraform-registry docs (the Terraform MCP wired in `.mcp.json`
     resolves this).

2. **Check it's not already managed.** Run `tofu state list` from the
   workspace you're considering. If the resource address you'd use is
   already there, stop — this is drift, not import. Hand to
   `opentofu-drift-detect`.

3. **Pick a target workspace.** Usually `live/dev/` (or another root
   config); never a module directory directly — modules don't manage
   state of their own. If the right home is inside a module the live
   workspace already uses, the import target is
   `module.<name>.<resource_type>.<label>`.

## Authoring the import

Once direction is confirmed:

1. **Create a branch:**
   ```bash
   git checkout -b import/<workspace-slug>/<resource-slug>
   ```

2. **Write the `import { }` block.** Two variants:

   **A. Import block only** (when you don't know the resource's required
   arguments). No `resource {}` block — step 3's
   `-generate-config-out` will harvest every readable attribute from
   cloud and write the full resource block to file.
   ```hcl
   import {
     to = aws_s3_bucket.imported_logs
     id = "my-existing-bucket-name"
   }
   ```

   **B. Import block + minimal stub** (when you know the resource type
   and its bare-minimum arguments). Step 3 will plan the import but
   *will not* generate a file — `-generate-config-out` only fires when
   the import's target address has no matching `resource` block.
   ```hcl
   import {
     to = aws_s3_bucket.imported_logs
     id = "my-existing-bucket-name"
   }

   resource "aws_s3_bucket" "imported_logs" {
     bucket = "my-existing-bucket-name"
   }
   ```

   Variant B is cleaner when you know the schema (the path the
   `s3-bucket` and `vpc` modules are built on); variant A is the
   fallback for unfamiliar resource types.

3. **Generate config from reality (variant A):**
   ```bash
   tofu plan -generate-config-out=imported.generated.tf -no-color > /tmp/import-plan.txt 2>&1
   echo "exit=$?"
   ```
   OpenTofu reads the existing resource and writes the full HCL
   representation to `imported.generated.tf`. The plan output shows the
   "import" as the only change.

   Exit code mapping (same as drift-detect):
   - `0` → no changes detected → already at desired state, but the
     generated file is still useful.
   - `2` → changes detected (the import itself, plus any reconciliation).
     Inspect the diff carefully.
   - `1` → error. Common causes: ID format wrong, resource doesn't
     exist, principal lacks read permission. Fix and retry.

4. **Refine the generated config.** `-generate-config-out` writes
   *every* readable attribute, including:
   - Explicit `null` for unset optionals — delete these lines.
   - Computed/read-only attributes the resource block doesn't accept —
     delete these (tofu validate will tell you which).
   - Deprecated arguments emitted in deprecated form — replace with the
     current form (e.g., `versioning { enabled = true }` → use the
     standalone `aws_s3_bucket_versioning` resource on 4.x+).
   - Default values that match the provider default — delete for
     readability.

   Merge the refined config into the right file (`main.tf` or a
   topic-specific file). Delete `imported.generated.tf` once merged.

5. **Re-run `tofu plan -no-color`** and verify:
   - The `import` action appears for the target address.
   - **Zero `+ create` / `~ update` / `- destroy` actions** for that
     resource — only the import itself.
   - If a `~ update` shows up, the HCL doesn't match cloud reality.
     Decide: tighten the HCL to match (the import is "accept cloud"),
     or leave the HCL as the source of truth (the import will reconcile
     on apply).

   **Expected exception — `default_tags` reconciliation.** Resources
   created out-of-band (`aws s3 mb`, console clicks, any tool that
   bypasses the provider) won't carry the provider's `default_tags`.
   Bringing them under management correctly shows a `~ update` adding
   `Environment` / `ManagedBy` / `Project` (or whatever's in
   `default_tags`) to `tags_all`. This is intentional reconciliation,
   not residual drift — same pattern documented in
   `opentofu-drift-detect`. Apply with confidence.

6. **Stop.** Stage the changes with `git add <files>`. Do not commit.
   Do not apply. Hand the branch back to the human with a clear report
   (format below). They run `tofu apply` to perform the import.

## What you must not do

- `tofu import` CLI — denied in `settings.json`. Always use the
  `import { }` block flow.
- `tofu apply` — denied. The import is applied by the human.
- `tofu state rm | mv | push | force-unlock` — denied. If the existing
  state needs surgery (e.g., you want to remove a stub that
  accidentally got created), write the exact `tofu state rm <addr>`
  command into the final report; the human runs it.
- `git commit` / `git push` — branches stay local until the human
  reviews `git diff --staged`.
- Import a resource whose required arguments you don't know. Better to
  fail loudly with a "can't safely import" report than to write a
  stub that drifts on the next plan.
- Refine away security attributes that aren't in your HCL — e.g., if
  the cloud bucket has a bucket policy but your HCL doesn't model
  bucket policies, leave the generated `aws_s3_bucket_policy` resource
  in. Pruning silently is how drift starts.

## Demonstrating import on Moto

To prove the loop end-to-end without waiting for ClickOps:

```bash
source dev.local.env

# Create a resource directly in Moto (simulating ClickOps):
aws s3 mb s3://imported-from-clickops-dev

# Confirm it's not in state:
cd live/dev
tofu state list | grep imported-from-clickops || echo "not managed"

# Author import block + stub:
cat >> main.tf <<'HCL'

import {
  to = aws_s3_bucket.imported_logs
  id = "imported-from-clickops-dev"
}

resource "aws_s3_bucket" "imported_logs" {
  bucket = "imported-from-clickops-dev"
}
HCL

# Generate full config from cloud:
tofu plan -generate-config-out=imported.generated.tf -no-color

# Merge refined config into main.tf, delete the .generated.tf, re-plan:
tofu plan -no-color
# Expected: "Plan: 1 to import, 0 to add, 0 to change, 0 to destroy."
```

The post-merge plan output is what the human acts on. If it shows
"1 to import, 0 to change", apply is safe. If it shows "1 to import, N
to change", review each change — that's reconciliation, intentional or
not.

## Report format

End every run with this structure:

```
Import summary
  Workspace:       <path>
  Resource:        <addr>           (e.g., aws_s3_bucket.imported_logs)
  Cloud ID:        <id>             (e.g., my-bucket-name)
  Already managed? no               (or "yes — see opentofu-drift-detect")

Plan shape:
  Imports:         1
  Adds/changes:    0 (or: N + per-change rationale)
  Destroys:        0

Files modified:
  - live/dev/main.tf                 (merged refined config)
  - live/dev/imported.generated.tf   (deleted after merge)

Branch:           import/<...>      (NOT pushed; staged changes ready)
Next step:        human runs `git diff --staged`, then `tofu plan` on
                  the branch, then `tofu apply` to perform the import
Manual state ops: <exact tofu state commands needed, or "none">
```
