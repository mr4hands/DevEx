---
name: opentofu-refactor-to-module
description: Extract resources from a root config (`live/<env>/`) into a reusable module under `modules/`, with `moved { }` blocks so state migrates cleanly. Load when the user mentions refactoring HCL into a module, "this should be a module", duplication between configs, extracting reusable patterns, or asks "how do I turn these resources into a module". Authors changes on a branch and verifies plan shows zero diff; never runs `tofu apply`, `tofu state mv`, or any other denied operation.
---

# OpenTofu refactor to module

You extract resources from a root config (typically `live/<env>/`) into
a new reusable module under `modules/`, using `moved { }` blocks so the
state references update without a destroy-and-recreate. The gold standard
is a post-refactor plan that shows **zero changes** — same resources at
new addresses, same attributes.

This skill is the inverse of `opentofu-aws-import`: aws-import brings
unmanaged cloud resources into state; refactor-to-module reshapes
already-managed HCL without changing what's in cloud.

## When to invoke

Trigger on: "refactor", "extract module", "extract these into a module",
"this should be a module", "turn this into a module", "modularize",
"reusable", "we copy-paste this pattern", "DRY this up", duplication
between root configs.

If the user wants to *adopt unmanaged resources* → route to
`opentofu-aws-import`.
If the user wants to *reconcile state with cloud* → route to
`opentofu-drift-detect`.

## Pre-refactor sanity checks

Before authoring anything:

1. **Confirm the resources are already managed.** Run `tofu state list`
   in the source workspace. Every resource you plan to move must be in
   state. If something isn't, either import it first (aws-import) or
   exclude it from the refactor.

2. **Confirm zero pending changes.** Run `tofu plan -no-color` in the
   source workspace. If there are pending adds/changes/destroys
   unrelated to the refactor, stop and ask — the refactor will obscure
   whether the diff is from your edits or pre-existing drift.

3. **Justify the extraction.** Per the style guide: *"Three similar
   lines is better than a premature abstraction."* Extract only when:
   - The pattern is genuinely duplicated across two or more root
     configs (or about to be), OR
   - The pattern is internally complex enough to warrant a tested
     contract (variables in, outputs out), OR
   - The user has stated they want this as a module despite the
     above caveats.

   If none apply, push back. The right move is often "don't refactor."

## Refactor flow

Once direction is confirmed:

1. **Create a branch:**
   ```bash
   git checkout -b refactor/<source>/<module-name>
   ```

2. **Draft the new module** under `modules/<name>/` per the style
   guide:
   ```
   modules/<name>/
     versions.tf
     variables.tf
     main.tf
     outputs.tf
     locals.tf       (only if non-trivial)
     tests/
       plan.tftest.hcl   (day-one)
   ```

   Rules:
   - Resource labels inside the module use the module's internal
     naming (`this` for single-resource modules, descriptive
     `snake_case` otherwise). They do **not** need to match the
     original root-config labels.
   - Module inputs are the values that were hardcoded or referenced
     from outside in the original HCL. Variable defaults belong in
     the module only when they're sensible across all callers;
     caller-specific values stay required.
   - Outputs are anything the root config currently exposes via
     `output { }` or that callers will need to reference downstream.
   - No `provider {}` blocks inside the module.

3. **Author `moved { }` blocks in the source workspace.** This is the
   load-bearing step:
   ```hcl
   moved {
     from = aws_s3_bucket.logs
     to   = module.logs_bucket.aws_s3_bucket.this
   }

   moved {
     from = aws_s3_bucket_versioning.logs
     to   = module.logs_bucket.aws_s3_bucket_versioning.this
   }
   # ...one per resource you're moving
   ```

   These tell OpenTofu: "the resource that was at address X is now at
   address Y." No `tofu state mv` needed — `moved` blocks are
   declarative state surgery, processed at plan/apply time.

   For `for_each`/`count` keys, the address includes the key:
   ```hcl
   moved {
     from = aws_subnet.public[0]
     to   = module.network.aws_subnet.public["us-east-1a"]
   }
   ```

   If you're changing iteration from `count` to `for_each` during the
   refactor (recommended per the style guide), every key shifts —
   write one `moved` block per element.

4. **Replace the original resources with the module call.** Delete
   the resource blocks from the source workspace's `main.tf`; replace
   them with:
   ```hcl
   module "logs_bucket" {
     source = "../../modules/<name>"

     # inputs derived from what the original resources hardcoded
   }
   ```

   Update any downstream references — anything that was
   `aws_s3_bucket.logs.arn` becomes `module.logs_bucket.bucket_arn`
   (matching the new module output names).

5. **Run `tofu plan -no-color`** and verify:
   - `Plan: 0 to add, 0 to change, 0 to destroy.`
   - The plan output should list each resource under "Changes to
     Outputs" as a no-op move, NOT as create-then-destroy.
   - If the plan shows `N to destroy, N to add` for the same logical
     resource, a `moved` block is missing or has the wrong addresses.
     Fix and re-plan; never accept a destroy-then-create as the
     "expected" outcome of a refactor.

6. **Author the day-one tftest** for the new module under
   `modules/<name>/tests/plan.tftest.hcl`. Use the
   `opentofu-tftest-author` skill's canonical plan-test pattern: at
   minimum, one `run` block with `mock_provider "aws" {}` and asserts
   on every required output.

7. **Run `tofu fmt -recursive` and `tofu test`** inside
   `modules/<name>/`. All runs pass.

8. **Stop.** Stage everything with `git add <files>`. Do not commit.
   Do not apply. Hand the branch back to the human — they review
   `git diff --staged`, open a PR via `gh pr create --fill` for CI to
   gate, then `tofu apply` locally after merge to migrate state
   addresses.

## On dropping `moved { }` blocks later

`moved` blocks stay in HCL forever from OpenTofu's perspective —
removing them doesn't trigger a state change, but the address-tracking
information is then lost. The convention varies:

- **Keep them indefinitely** — small overhead, clearest audit trail.
- **Remove after one successful apply** — common in fast-moving repos;
  the state has migrated, the blocks have done their job.

State a clear convention in the branch report so the human knows when
(if ever) to clean up.

## What you must not do

- `tofu apply` — denied. The apply is the human's deliberate act.
- `tofu state mv | rm | push | force-unlock` — denied. `moved { }` is
  the *only* state-address change you author. If the refactor needs
  state surgery that `moved` can't express (rare — virtually only
  cross-state operations), write the exact `tofu state` commands into
  the final report; the human runs them.
- `tofu import` — denied. If something needs to be imported, that's
  the `opentofu-aws-import` skill's job.
- `git commit` / `git push` — branches stay local until the human
  reviews `git diff --staged`.
- Combine a refactor with a feature change in the same branch. The
  zero-diff plan is what proves the refactor is safe; bundling a
  config change makes the plan ambiguous. If the user wants both,
  do the refactor first, land it, then change behavior in a follow-up.
- Extract a module for a single, internal caller without a stated
  reason. Three lines twice is fine; three lines duplicated three
  times across two environments is a real signal.

## Demonstrating the refactor pattern

A hypothetical example for shape — pretend `live/dev/main.tf` has:

```hcl
resource "aws_s3_bucket" "logs" {
  bucket = "my-logs-dev"
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration {
    status = "Enabled"
  }
}
```

The refactor would produce:

```hcl
# live/dev/main.tf — after refactor
moved {
  from = aws_s3_bucket.logs
  to   = module.logs_bucket.aws_s3_bucket.this
}

moved {
  from = aws_s3_bucket_versioning.logs
  to   = module.logs_bucket.aws_s3_bucket_versioning.this
}

module "logs_bucket" {
  source      = "../../modules/s3-bucket"
  bucket_name = "my-logs-dev"
}
```

And `modules/s3-bucket/` with the resources renamed to use `this` as
the label, variables exposed, outputs defined, and a `plan.tftest.hcl`
asserting the output contract.

Post-refactor `tofu plan`: `0 to add, 0 to change, 0 to destroy`.

## Report format

End every run with this structure:

```
Refactor summary
  Source:          <path>            (e.g., live/dev/)
  New module:      modules/<name>/
  Resources moved: N                 (list addresses if N <= 10)

Plan shape:
  Adds:            0
  Changes:         0
  Destroys:        0
  Moves:           N                 (one per moved { } block)

Files modified:
  - live/dev/main.tf                 (resources replaced with module call;
                                      moved { } blocks added)
  - modules/<name>/versions.tf       (new)
  - modules/<name>/variables.tf      (new)
  - modules/<name>/main.tf           (new)
  - modules/<name>/outputs.tf        (new)
  - modules/<name>/tests/plan.tftest.hcl  (new)

Branch:           refactor/<...>     (NOT pushed; staged changes ready)
Next step:        human runs `git diff --staged` + `tofu plan` (confirm
                  0 diff), opens a PR via `gh pr create --fill`, waits
                  for CI green, then `tofu apply` locally after merge
                  to migrate state addresses
moved {} cleanup: keep / remove-after-first-apply
Manual state ops: <exact tofu state commands needed, or "none">
```
