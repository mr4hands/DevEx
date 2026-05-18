# Multi-account TF/TG/CDKTF → OpenTofu migration playbook

Operational planning document for the future production-readiness phase.
Complements `Open-Source Unified Platform Architecture for Advanced
Infrastructure as Code Management.md` — that doc covers *why* OpenTofu;
this one covers *how* to migrate a multi-account, multi-repo estate to
it.

**Status:** planning only. Not for execution until the platform reaches
the production-readiness phase.

**Trigger conditions for re-reading this document:**

- The DevEx platform is being adopted by a team with an existing
  TF/TG/CDKTF estate of more than ~5 accounts.
- A decision has been made to migrate to OpenTofu (rather than continue
  in-place on Terraform under the BSL).
- The bootstrap, live, and modules patterns in this repo are stable
  enough to be the migration target.

---

## Scope assumed

- ~70 AWS accounts (representative scale; numbers will vary).
- Resources spread across multiple repositories.
- Mixed tooling: bare Terraform, Terragrunt, CDKTF.
- Existing state files in S3 backends (some per-account, some shared).
- The DevEx platform is mature enough to be the consolidation target:
  bootstrap pattern, live/<env>/ layout, modules/, agent skills.

---

## The big-leverage decision: state adoption vs. state import

This is the single highest-leverage decision in the migration. Get it
right and most workspaces migrate in minutes each; get it wrong and the
project becomes a multi-month per-resource re-import slog.

### Strategy 1 — State adoption (in-place migration)

OpenTofu 1.6+ reads Terraform state files up to ~1.5.5 verbatim
(the fork point). For most workspaces the migration is literally:

```bash
# In an existing TF workspace
tofu init     # reuses the same backend, reads the same state
tofu plan     # if 0 changes, the migration is done
```

No imports. No re-authoring. No state surgery. Cost per workspace:
minutes.

**The catch:** if the source TF wrote state with version 1.6+ features,
OpenTofu may refuse to read it (or read it but lose information). The
single most important pre-migration artifact is a **state-version audit**
across all workspaces — see Phase 0.

**Terragrunt:** TG is a config-generator that shells out to a
`terraform` binary. Point it at `tofu` (TG 0.55+ supports this via
`TERRAFORM_BINARY` env var or `terraform_binary` field in
`terragrunt.hcl`) and TG keeps working unchanged. The state underneath
is plain TF state, so state-adoption applies identically.

**CDKTF:** Same trick — `TERRAFORM_BINARY_NAME=tofu` and CDKTF synths
against OpenTofu. The synthesized state is plain TF state.
**Caveat:** CDKTF is deprecated by HashiCorp/IBM (see the architecture
research doc). Adopting CDKTF state into OpenTofu keeps it working but
doesn't solve the underlying tool-deprecation risk. A second migration
step — CDKTF → native HCL — eventually follows, scoped separately.

### Strategy 2 — State import (re-bind to new structure)

This is the pattern demonstrated by `demo/three-tool-import/`: read
cloud reality via `import { }` blocks, author HCL to match, plan, apply
per resource.

**When this is right:**

- The source state file is lost, corrupted, or inaccessible.
- The migration *also* restructures (consolidating scattered states,
  renaming addresses, changing backends from local → S3 etc.).
- The source tooling is so old or non-standard that adoption isn't
  feasible (e.g., pre-0.12 Terraform).

**When this is wrong:**

- For most of the 70 accounts. Re-import scales linearly with
  resource count, not workspace count. A typical AWS account has
  hundreds to thousands of taggable resources. Re-importing everything
  is a multi-month engineering project.

### Strategy 3 — Greenfield rebuild

Pretend the existing state doesn't exist. Author new HCL, apply with
`-replace` or destroy/recreate.

**Almost never right at this scale** unless the source code is
unmaintainable (e.g., abandoned CDKTF stacks where the TS code no
longer compiles). The destroy/recreate is also actively destructive to
running infrastructure — avoid except for stateless ephemera.

---

## What this repo's skills cover, what they don't

### Covered

| Skill | Role in migration |
|---|---|
| `opentofu-aws-import` | The per-resource import primitive. Used by Strategy 2 and for any post-adoption ClickOps cleanup. |
| `opentofu-drift-detect` | The pre-migration baseline check. You want a clean `terraform plan` in TF *before* migrating, otherwise the OpenTofu plan mixes migration with reconciliation. |
| `opentofu-refactor-to-module` | Post-migration consolidation when 70 accounts have copy-pasted patterns. |
| `opentofu-style-guide` | Normalizes formatting/structure across whatever the source projects looked like. |
| `opentofu-tftest-author` | Ships day-one tests for any new modules created during refactor. |

### Not covered — gaps to fill before execution

- **State-version auditor.** No skill audits the `terraform_version`
  field across N state files. Easy to build: a small script that walks
  workspaces, runs `tofu state pull | jq .terraform_version`, and
  outputs a CSV. Build this first.
- **Backend re-pointing.** If consolidating state backends, that's
  `tofu init -migrate-state` per workspace. Scriptable but inherently
  serial because of state locks.
- **Cross-repo coordination.** PR-per-repo, CI gates per repo, the
  order in which accounts roll forward. Today this is whatever the
  team's engineering practice is — no skill encodes it.
- **Provider lock regeneration.** `.terraform.lock.hcl` files
  reference Terraform Registry; you may want to switch to the OpenTofu
  Registry. Provider entries are the same content but checksums differ
  — `tofu init -upgrade` regenerates them.
- **CI/CD migration.** Anything that shelled out to `terraform` by
  name (Atlantis, Spacelift, Scalr workflows, internal pipelines)
  needs find-and-replace across the tooling repo. Not a per-workspace
  problem — a per-org-tooling problem.
- **Multi-workspace orchestration.** The skills are workspace-scoped.
  A real migration tool would need: inventory database, "next
  workspace to migrate" queue, state-machine per workspace
  (audited → migrated → verified → closed), Slack notifier for human
  apply.

---

## Phased plan

### Phase 0 — audit (1-2 weeks, single engineer)

The week of work that determines the cost of the whole project.

- **Inventory build.** For each `(repo, workspace, account)`, capture:
  - Terraform version used
  - State format version (from `terraform state pull` → `.terraform_version`)
  - State backend (local / S3 / TFC etc.)
  - Tool family (bare TF / Terragrunt / CDKTF)
  - Resource count (`tofu state list | wc -l`)
  - Last-applied timestamp (state's `serial` increment rate)
- **Drift baseline.** Run the `opentofu-drift-detect` flow against
  each workspace. Catalog drifted workspaces — they migrate **last**,
  after reconciliation, so migration plans aren't muddied.
- **Tool-family quarantine.** Sort workspaces:
  - Bare TF ≤ 1.5.5 → easy lane (Strategy 1, near-trivial)
  - Bare TF 1.6+ → manual review lane (may need state-feature audit)
  - Terragrunt → easy lane after `TERRAFORM_BINARY` switch
  - CDKTF → easy lane for state, deferred lane for code rewrite
- **Output:** a CSV/database of all workspaces with their lane
  assignment. This becomes the queue for Phases 1-2.

### Phase 1 — pilot (1 week)

Prove the playbook before scaling.

- Pick 3 representative workspaces: one bare-TF, one Terragrunt, one
  CDKTF.
- Run Strategy 1 (state adoption) end-to-end on each:
  1. Snapshot the state file (backup).
  2. Switch the tooling binary.
  3. `tofu init && tofu plan` → expect 0 changes (or only `default_tags`
     reconciliation if you're also normalizing tags).
  4. Apply per the repo's manual-apply posture.
  5. Document every gotcha that came up.
- **Output:** a per-tool-family runbook with the exact commands,
  expected output, and known gotchas. This is the script that
  scales to the other 67 accounts.

### Phase 2 — rolling migration (weeks-to-months)

The bulk of the work. Pace is dictated by approvals and apply
sequencing, not tooling.

- **Batch by repo, not by account.** One PR per repo swaps the
  `terraform` binary references to `tofu`, updates CI configs, etc.
  The state-side migration is per-workspace and runs after the PR
  merges.
- **CI gate.** Each repo's CI runs the migrated tooling against a
  pilot workspace as the gate. Greens → merge → proceed.
- **Apply remains manual.** Per the platform's posture (CLAUDE.md
  safety rules), `tofu apply` is never automated. Each per-workspace
  migration is a deliberate human action, ideally during a maintenance
  window. At 70 accounts and ~5 min per apply, this is ~6 hours of
  cumulative apply time — schedulable across a small window.
- **Drifted workspaces migrate last.** Reconcile drift in TF first,
  then migrate. Drift remediation during migration mixes two diffs
  and makes plan output unreadable.
- **Rollback plan.** Snapshot every state file before its migration.
  If OpenTofu rejects the state, revert to the snapshot and the source
  tooling unchanged. State format is forward-compatible (TF 1.5 →
  OpenTofu 1.6) but **not always backward** (OpenTofu 1.6 → TF 1.6+),
  so the rollback path is "go back to where you were," not "go to
  newer TF."

### Phase 3 — restructure (open-ended)

Once everything is on OpenTofu, the import-block flow you saw in the
demo becomes useful for *consolidating* what migrated.

- Identify copy-pasted patterns across the 70 accounts via the new
  unified codebase.
- Use `opentofu-refactor-to-module` to extract shared modules into
  `modules/`.
- Use `moved { }` blocks to migrate state addresses without
  destroy-and-recreate.
- CDKTF → native HCL rewrites land here too, scoped one stack at a
  time.

---

## Honest verdict

**Per-workspace mechanics:** the agent + this repo handle this well.
The `opentofu-aws-import`, `opentofu-drift-detect`, and
`opentofu-refactor-to-module` skills cover the per-workspace work; the
style-guide skill normalizes output.

**Fleet-wide orchestration:** the agent should *not* be the conductor.
That's an inventory + scheduling problem that wants a small
purpose-built tool — a CSV of workspaces, a state machine, a Slack
notifier when an account is ready for human apply. The agent slots
into that tool as the per-workspace worker.

**Highest-leverage week of work to do first:** Phase 0's inventory +
drift baseline. The rest of the project's risk drops by half once the
exact estate is known.

**Realistic time estimate:** ~1 engineer-quarter for 70 accounts,
assuming the bulk are Strategy 1 candidates. Most of the work is
*reading* existing config, not *authoring* new config.

---

## Reference: the demo

`demo/three-tool-import/` demonstrates Strategy 2 (re-import) end-to-end
against Moto, with sources from all three tool families. It's the
working reference for the per-resource import primitive, *not* the
template for the 70-account migration — that uses Strategy 1 for most
workspaces.

Resources covered by the demo:

- TF → VPC (`module.vpc.aws_vpc.this`)
- Terragrunt → subnet (`module.vpc.aws_subnet.this`)
- CDKTF → SG + EC2 instance (`module.ec2.*`)

Two modules wired together via the standard `module.X.output → module.Y.input`
pattern; four `import { }` blocks with module-qualified `to` addresses.
