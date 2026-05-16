---
name: opentofu-tftest-author
description: Author OpenTofu `.tftest.hcl` tests for modules and root configs in the DevEx Platform. Load when the user mentions tests, tftest, test coverage, "add a test", `tofu test`, assertions, mocking the AWS provider, or asks why a test is failing. Authors plan-first tests with `mock_provider`, falls back to apply tests against Moto only when computed attributes matter and the user has opted in. Never runs apply against real AWS.
---

# OpenTofu tftest author

You author and maintain `.tftest.hcl` tests for the DevEx Platform repo.
Tests are how modules earn the right to be reused — every module ships
with at least one test exercising required inputs and asserting required
outputs (per `opentofu-style-guide`). This skill teaches you how.

## When to invoke

Trigger on user mentions of: tests, tftest, `tofu test`, test coverage,
"add a test", "test for this module", assertions, `mock_provider`,
`override_resource`, "why is the test failing", broken plan asserts.

## File layout

```
modules/<name>/
  main.tf
  variables.tf
  outputs.tf
  versions.tf
  tests/
    plan.tftest.hcl              # baseline plan + output assertions
    <scenario>.tftest.hcl        # variant inputs, edge cases, failure paths
```

Repo-level integration tests that exercise composition across modules
live in `/tests/`, not under any single module.

One `.tftest.hcl` file per scenario family. Inside a file, each `run`
block is one named scenario. Prefer many small `run` blocks in one file
over many files when the scenarios share the same module under test.

## The canonical plan test

This is what every new module must ship with on day one. Pattern lifted
from `modules/s3-bucket/tests/plan.tftest.hcl`:

```hcl
mock_provider "aws" {}

variables {
  bucket_name = "devex-platform-<module>-tftest"
}

run "plan_with_minimum_inputs" {
  command = plan

  assert {
    condition     = output.bucket_id != null && output.bucket_id != ""
    error_message = "bucket_id output must be non-empty."
  }
}
```

Why this shape:

- **`mock_provider "aws" {}`** — no AWS calls, no creds, no Moto needed.
  Plan tests run anywhere `tofu` runs. Computed attributes are filled
  with realistic mock values automatically.
- **Top-level `variables {}`** — defaults for every `run` in the file.
  Individual runs can override.
- **`command = plan`** — read-only, fast, deterministic. The default,
  but state it explicitly so a future reader knows the intent.
- **Asserts on `output.<name>`** — locks down the module's public
  contract. If someone renames or removes the output, the test fails.

## Variant scenarios

Add `run` blocks for the inputs that meaningfully change the plan:

```hcl
run "plan_with_kms_encryption" {
  command = plan

  variables {
    bucket_name = "devex-platform-s3-module-tftest-kms"
    kms_key_arn = "arn:aws:kms:us-east-1:123456789012:key/test"
  }

  assert {
    condition = one(
      aws_s3_bucket_server_side_encryption_configuration.this.rule
    ).apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms"
    error_message = "Setting kms_key_arn must switch SSE to aws:kms."
  }
}

run "plan_with_versioning_disabled" {
  command = plan

  variables {
    bucket_name       = "devex-platform-s3-module-tftest-noversion"
    enable_versioning = false
  }

  assert {
    condition = one(
      aws_s3_bucket_versioning.this.versioning_configuration
    ).status == "Disabled"
    error_message = "enable_versioning = false must produce Disabled status."
  }
}
```

Inside a `run` block, you assert against **resource addresses** in
addition to outputs — every resource the module creates is in scope.

## Failure-path tests

For variable `validation` blocks, prove they reject what they're meant
to reject. Use `expect_failures`:

```hcl
run "rejects_uppercase_bucket_name" {
  command = plan

  variables {
    bucket_name = "Has-Uppercase"
  }

  expect_failures = [
    var.bucket_name,
  ]
}
```

If the validation passes when it should have failed, `tofu test` reports
the run as failed — which is the right outcome.

## Apply tests (use sparingly)

Plan tests catch ~all module-shape regressions. Reach for `command = apply`
only when:

- The assertion depends on a value the provider only computes at apply
  time (e.g., a generated ID that mock_provider stubs differently).
- The module's behavior is tied to side effects that won't surface in a
  plan (rare for our modules so far).

Rules for apply tests:

- **Always against Moto, never real AWS from tftest.** Tests run in CI
  and against any contributor's clone — assume real-AWS credentials will
  eventually be present and that an apply against them is destructive.
- Source `dev.local.env` before `tofu test`, or front the command with
  `make test` once that target is wired to load it.
- Mark apply tests clearly in their `run` block name:
  `run "apply_against_moto_<scenario>" { ... }`.
- Confirm with the user before adding the first apply test to a module
  — the maintenance and cost profile is different.

## Surgical mocking with overrides

When `mock_provider "aws" {}` is too coarse (you want most resources
real, one resource fake), use `override_resource` / `override_data` /
`override_module` inside a `run` block:

```hcl
run "plan_with_iam_overridden" {
  command = plan

  override_resource {
    target = aws_iam_role.executor
    values = {
      arn = "arn:aws:iam::123456789012:role/test-executor"
    }
  }

  assert {
    condition     = output.executor_arn == "arn:aws:iam::123456789012:role/test-executor"
    error_message = "Module must expose the executor role ARN unchanged."
  }
}
```

Same shape exists for `data "..."` (`override_data`) and `module ".."`
(`override_module`). Prefer overrides to a full `mock_provider` when
most of the module is fine to plan normally.

## Running tests

```bash
# Single module
cd modules/s3-bucket
tofu test

# Repo-wide (Makefile target sources dev.local.env)
make test
```

`tofu test` reports per-`run` pass/fail and surfaces assertion messages
on failure. The exit code is non-zero if any run fails — wire into CI
once CI exists.

## Style nits

- `run "..." {}` block names are `snake_case` and describe what's being
  proved (`plan_with_kms_encryption`), not what the test does
  (`test_kms`).
- `error_message` reads as a sentence ending in `.` and explains the
  invariant in business terms, not the assertion mechanics.
- One assertion per logical fact. Don't chain unrelated conditions with
  `&&` into one assert — when it fails, you can't tell which fact
  broke.
- Hard-coded test values that look like ARNs/IDs use the Moto default
  account `123456789012` so they remain plausible if a test ever flips
  to apply-against-Moto.

## What you must not do

- Run `command = apply` against real AWS from a tftest. If the project
  ever grows a real-AWS test, it goes outside `.tftest.hcl` with
  explicit human gating.
- Use `mock_provider` to hide a real assertion failure. If a plan
  changes when it shouldn't, the answer is to update the test or fix
  the module — not to mock the diff away.
- Skip the day-one plan test on a new module. Even a one-assert plan
  test catches the most common breakage (renamed/removed output).
- Commit a `.tftest.hcl` that asserts on values you haven't actually
  observed. Run `tofu test` locally first; capture real mocked output
  shapes before pasting them into asserts.

## Before declaring a test done

1. `tofu fmt -recursive` — pre-allowed.
2. `cd <module-dir> && tofu test` — pre-allowed. All runs pass.
3. If you added an apply test against Moto: `make local-up` first,
   then `make test`.
4. Report each `run` block's name and what invariant it locks down.
