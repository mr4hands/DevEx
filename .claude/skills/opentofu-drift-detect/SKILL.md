---
name: opentofu-drift-detect
description: Detect, classify, and propose remediations for drift between OpenTofu state and live AWS infrastructure. Load when the user mentions drift, state divergence, out-of-sync infrastructure, reconcile state with reality, refresh-only plans, ClickOps cleanup, or asks "what's actually deployed". Reads via `tofu plan -refresh-only` and read-only AWS CLI; never applies, mutates state, or pushes branches.
---

# OpenTofu drift detection

You detect divergence between OpenTofu state and live AWS reality, then
propose a remediation. You never `tofu apply`, `tofu state rm|mv|push`, or
`tofu force-unlock` — those are denied in `settings.json` and reserved for
the human. Your output is always one of:

1. A clean "no drift" report.
2. A refreshed plan showing drift, with each item classified.
3. A branch with HCL changes staged (not committed, not pushed) ready for
   human review and apply.

## When to invoke

Trigger on user mentions of: drift, divergence, "out of sync", "the cloud
doesn't match", reconcile, refresh, "what's actually deployed", "did
someone change it", state mismatch, ClickOps cleanup.

## Detection flow

For the target workspace (typically `live/dev/`):

1. **Confirm the target.** If unclear, list candidate dirs under `live/`
   and ask.
2. **Source env if running against the local emulator.** Moto:
   `source <repo-root>/dev.local.env`. Real AWS: confirm
   `aws sts get-caller-identity` succeeds.
3. **Refresh-only plan with detailed exit code:**
   ```bash
   cd <workspace>
   tofu plan -refresh-only -detailed-exitcode -no-color > /tmp/drift.txt 2>&1
   echo "exit=$?"
   ```
   Or simply `make drift-check` from repo root (Makefile target wraps this).

   Exit code mapping:
   - `0` → no drift. Report and stop.
   - `1` → error (auth, missing init, etc.). Diagnose before continuing.
   - `2` → drift detected. Proceed to classification.
4. **Parse the plan output** to extract resource addresses, attribute paths,
   and the directional diff (state → cloud).

## Classifying each drift

| Pattern | Diagnosis | Default direction |
|---|---|---|
| Attribute differs between state and cloud | Manual edit in cloud | Ask — could go either way |
| Resource in state, missing from cloud | Deleted out-of-band | Ask: recreate (apply) or accept (state rm) |
| Resource in cloud, missing from state | Imported / ClickOps | `import { }` block + new HCL |
| Tag/label added in cloud | Org policy auto-tagging | Usually: add to HCL |
| Tag/label removed in cloud | Manual rip-out | Usually: re-apply HCL |

For each drifted resource, state the diagnosis and **ask the user to
confirm the fix direction** before authoring changes. Drift remediation has
ambiguous semantics — the AI cannot decide intent.

## Authoring the fix

Once direction is confirmed:

1. Create a branch:
   ```bash
   git checkout -b drift/<workspace-slug>/<YYYY-MM-DD>
   ```
2. Edit HCL to reflect the agreed-upon target state.
   - **Accept cloud** → update HCL args / module inputs to match what's
     deployed. The post-fix plan usually shows zero diff *for the codified
     attribute itself*, but watch for indirect reconciliations:
     - **AWS tag drift via `PutBucketTagging` / `TagResource`**: these APIs
       *replace* the entire tag set, so they wipe the provider's
       `default_tags` as a side effect. Codifying the new cloud tag in HCL
       yields a "1 to change" plan that re-adds the `default_tags` the
       manual call erased. This is *intended* reconciliation, not residual
       drift. If you genuinely need a zero-change post-fix plan, the only
       paths are (a) revert the cloud tag instead — option below — or
       (b) split this resource onto a provider alias without `default_tags`,
       which trades observability (Project/Environment/ManagedBy lost on
       this resource) for plan cleanliness; almost never worth it.
     - Similar replace-not-merge semantics exist for IAM inline policies,
       Lambda environment variables, and a handful of other AWS APIs.
       Always re-check the post-fix plan, don't assume zero-diff.
   - **Revert cloud** → leave HCL unchanged. The next plan will show the
     revert as the only change.
   - **Import unmanaged resource** → emit an `import { }` block alongside
     the new resource definition:
     ```hcl
     import {
       to = aws_s3_bucket.imported_logs
       id = "the-bucket-name"
     }

     resource "aws_s3_bucket" "imported_logs" {
       bucket = "the-bucket-name"
     }
     ```
     The human can later run `tofu plan -generate-config-out=imported.tf`
     to auto-author the full config.
3. Re-run `tofu plan -no-color` and confirm the expected end state for
   each fix type.
4. **Stop.** Stage the changes with `git add <files>` and leave the branch
   in place. Do not commit. Do not apply. Hand back to the human — they
   review `git diff --staged`, then (typically) `gh pr create --fill` to
   open the handoff as a PR for CI to gate.

## What you must not do

- `tofu apply` — denied. Human only.
- `tofu state rm|mv|push`, `tofu force-unlock` — denied. If state surgery
  is required, write the exact commands into the final report; the human
  runs them.
- `tofu refresh` — not pre-allowed; will prompt. Prefer `tofu plan
  -refresh-only`, which is read-only.
- `git push` — not pre-allowed; branches stay local until the human pushes.
- `git commit` — not pre-allowed; the human commits after reviewing
  `git diff --staged`.

## Demonstrating drift on Moto

To prove the loop end-to-end without waiting for real-world drift:

```bash
source dev.local.env

# Induce cloud-ahead drift on the logs bucket:
aws s3api put-bucket-tagging \
  --bucket devex-platform-logs-dev \
  --tagging 'TagSet=[{Key=ManuallyAdded,Value=true}]'

# Detect:
make drift-check
# Expected: exit code 2, diff shows the new tag under module.logs_bucket.
```

Note: `aws s3api put-bucket-tagging` is the classic `PutBucketTagging`
call and works fine for *inducing* drift on Moto. The reconciliation
plan, however, is authored by the AWS provider (6.x), which prefers the
newer S3 Control `TagResource` API and only falls back to
`PutBucketTagging` when the principal lacks `s3:TagResource`. If the
post-fix `tofu plan` fails against Moto with an unexpected SDK error,
that's the cause — see "S3 tagging path changed in AWS provider 6.x" in
the root `CLAUDE.md` Moto caveats for the workaround.

## Report format

End every run with this structure:

```
Drift summary
  Workspace:    <path>
  Resources:    N drifted out of M total
  Direction:    <cloud-ahead | hcl-ahead | mixed | none>

Per-resource:
  <addr>
    State:        <relevant attrs>
    Cloud:        <relevant attrs>
    Diagnosis:    <classification>
    Proposed fix: <direction + one-line summary>

Branch:           drift/<...>   (NOT pushed; staged changes ready)
Next step:        human runs `git diff --staged`, opens a PR via
                  `gh pr create --fill`, waits for CI green, then
                  `tofu apply` locally if intent matches
Manual state ops: <exact tofu state commands needed, or "none">
```
