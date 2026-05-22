# DevEx platform ↔ prod flow — target architecture & methodology

How the DevEx platform fits the organization's existing production IaC
workflow, and the phased roadmap for getting there. The platform replaces
the **authoring** surface (today: TF / Terragrunt / CDKTF + the in-house
`toolkit` wrapper) with an identity-aware, scope-filtered OpenTofu
canvas+agent. Everything downstream of the pull request — Spacelift plan,
human approval, merge, apply — stays exactly as it is today.

**Status: design/methodology only, no implementation yet.** This is the
reference doc that the per-phase implementation specs hang off of.

---

## Motivation

Today infra change happens two ways:

- **Baseline (platform/DevOps):** TF/Terragrunt. A *stack* is the folder
  holding the `terragrunt.hcl` (e.g. `billing-account/infra/vpc`). The
  module lives in a separate repo; the TG `source` points at it. The module
  encapsulates the mandatory scope (subnets, flow logs, tags, …).
- **Self-service (developers):** CDKTF. The dev spins up a dedicated repo
  (e.g. `selfservice.iac-billing-payments`), writes TypeScript against the
  in-house `toolkit` wrapper (CDKTF + guardrails: mandatory tags, internal
  rules), opens a PR. Spacelift plans on the PR branch; DevOps or an allowed
  user reviews plan+code and approves; on merge Spacelift runs
  plan→approve→apply. The whole repo is **one** coarse Spacelift stack.

The platform's job is to **deprecate both** authoring paths and unify them
behind one OpenTofu-native, scoped, multi-user front-end — without changing
the trusted Spacelift pipeline. Eventually the platform is deployed to a
server, developers log in via OKTA, see only the slice their OKTA groups
permit, and create/edit/delete within those permissions. They finish → a PR
is opened → the existing Spacelift flow takes over unchanged.

The key enabling insight: **a Spacelift stack is just a `(repo, path)` →
state mapping.** TF/TG makes the path granular (folder = stack); CDKTF makes
it coarse (repo = stack). Because Spacelift supports monorepo
folder-per-stack natively (via `project_root` + push policies / stack
autodiscovery), the **number of repos is decoupled from the number of
stacks** — which is what makes a single unified model possible.

---

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| **Repo topology** | **One `devex-live` monorepo**, folder-per-stack. Each leaf folder = one Spacelift stack = one state. Replaces *both* TF/TG folder-stacks and CDKTF repo-stacks. |
| **Shared modules** | **Separate versioned `devex-modules` repo**, consumed by `source = "git::…?ref=vX.Y.Z"`, exposed in-platform as a **catalog**. Continues today's "module in a different repo, TG points at it" pattern. |
| **Authoring primitive** | **Hybrid.** Stamping a blessed module from the catalog is the happy path (guardrails live *inside* the module). Raw-resource placement (the PR #32 model) remains as an escape hatch, guarded by the writer + checkov. |
| **Identity** | **OKTA SSO.** The authenticated subject becomes the draft `<owner>`, replacing today's `X-DevEx-Owner: local` header default. PRs are bot-opened but **attributed to the dev** (PR body + commit trailer). |
| **RBAC** | **Declarative `.devex/rbac.yaml`** in `devex-live`: OKTA group → path globs → verbs (`view`/`create`/`edit`/`delete`). Platform-enforced for **authoring only**. Changing access is itself a reviewable PR. |
| **Approval / apply** | **Unchanged.** Stays in Spacelift + GitHub CODEOWNERS. The platform governs *who can author what*; the existing PR gate governs *what actually ships*. Two non-overlapping layers. |
| **Concurrency** | **Lightweight.** Per-folder stacks + Git + Spacelift already isolate work and resolve conflicts (two devs → two PRs → rebase). The platform only *surfaces* "other open drafts/PRs touching this path" as advisory. No bespoke locking system. |

---

## Target architecture

```
REPO: devex-live                      (one repo, many stacks)
  .devex/rbac.yaml                    <- OKTA group -> path globs -> verbs
  billing-account/
    infra/
      vpc/        -> Spacelift stack "billing-account/infra/vpc"
      eks/        -> Spacelift stack "billing-account/infra/eks"
    payments/
      s3-buckets/ -> Spacelift stack "billing-account/payments/s3-buckets"
  payments-account/
    infra/vpc/    -> Spacelift stack "payments-account/infra/vpc"

REPO: devex-modules                   (shared, versioned catalog)
  vpc/  eks/  s3-secure/  rds-postgres/   <- source = git ref + version

PLATFORM (server, OKTA-gated)
  - resolves OKTA groups -> scope (.devex/rbac.yaml)
  - filters the tree; gates create/edit/delete by verb
  - owner-scoped drafts -> rendered HCL into devex-live folders
  - opens PR (bot identity, dev-attributed)

SPACELIFT (unchanged engine of record)
  - push policy detects changed folder(s) -> plans only affected stack(s)
  - posts plan on PR -> human approve -> merge -> plan->approve->apply
```

The platform's existing hierarchy navigator (Account→Region→Component,
`/api/inventory` + `_hierarchy.json`) maps **1:1** onto this folder/stack
tree — the UI already wants this shape.

### Where the `toolkit`'s job goes

The CDKTF `toolkit` wrapper enforced mandatory tags and internal rules at
authoring time. That responsibility splits cleanly:

- **Module happy path:** guardrails live *inside* blessed `devex-modules`
  (mandatory tags, scoped subnets, encryption, etc.) — the dev only supplies
  inputs.
- **Raw-resource escape hatch:** the platform's HCL **writer** injects
  mandatory tags/naming, the `opentofu-style-guide` skill enforces
  conventions, and **checkov** is the policy gate. This is the safety net for
  anything the catalog doesn't cover.

---

## Streamlined flow (end to end)

1. Dev logs into the platform via **OKTA** → groups resolve to a **scope**
   (which slice of the tree is visible/editable, and with which verbs).
2. Dev works the canvas/agent *within scope*: stamp a module (happy path) or
   place raw resources (escape hatch); create / adopt / edit / destroy →
   **owner-scoped drafts** (the PR #32 model, now keyed on the OKTA subject).
3. Dev clicks **"commit to PR."** The platform renders drafts to OpenTofu HCL
   into the correct `devex-live` folder(s), applying guardrails.
4. Platform opens a **PR** (bot identity, dev attributed).
5. **Spacelift** push policy sees the changed folder(s) → plans **only the
   affected stack(s)** → posts the plan on the PR. *(unchanged)*
6. DevOps / allowed approver reviews plan + code → approves → merge.
   *(unchanged)*
7. Spacelift runs plan → approve → apply on merge. *(unchanged)*

Steps 5–7 are the existing pipeline, untouched. The platform replaces only
"write CDKTF TypeScript / write TG HCL" with "author in-platform → emit HCL
→ PR."

---

## Phased roadmap

Each phase becomes its own implementation spec, authored one at a time.

- **Phase 0 — Moto end-to-end smoke** *(immediate next step, already agreed)*:
  prove the PR #32 foundation live against Moto + the agent: discovery via
  the AWS MCP, `tofu plan -generate-config-out`, adopt, and the
  draft→commit-to-PR promote. Validates the foundation before building on it.
- **Phase 1 — Topology + Spacelift mapping**: establish the `devex-live`
  monorepo layout convention + `devex-modules` repo + folder→stack
  autodiscovery/push-policy mapping. Define the writer's path conventions.
- **Phase 2 — Canvas/draft unification**: collapse the dual pending path
  (flat `live/blueprint/` canvas writes vs. owner-scoped `drafts/<owner>/`)
  so **all** authoring flows through owner-scoped drafts rendering into
  `devex-live` paths. *(Was a deferred PR #32 follow-up; now required.)*
- **Phase 3 — Module catalog (hybrid authoring)**: read `devex-modules` as a
  catalog; add a module-instance node kind on the canvas; retain the
  raw-resource escape hatch; wire guardrails (tag injection + checkov).
- **Phase 4 — OKTA identity**: SSO login; `<owner>` = OKTA subject; PR
  attribution; bot GitHub credentials.
- **Phase 5 — RBAC enforcement**: `.devex/rbac.yaml`; scope-filtered tree;
  verb gating on create/edit/delete; surface only in-scope resources.
- **Phase 6 — Deployment**: host the platform (server, secrets, OKTA app
  registration, bot creds). Candidate to **dogfood** as OpenTofu in this repo.

---

## Out of scope (here)

- **The ~70-account TF/TG/CDKTF → OpenTofu migration.** That is a separate,
  planning-only workstream (`research/migration-playbook-multi-account.md`).
  This architecture is its **target** — the migration adopts existing state
  into the `devex-live` shape — but the migration itself is not designed in
  this doc.
- **Heavyweight locking / real-time multi-user collaboration.** Concurrency
  is delegated to Git + Spacelift + advisory surfacing, per the decision
  above.
- **Replacing Spacelift, GitHub, or the approval model.** Explicitly
  preserved.

---

## Open questions to resolve in phase specs

- Exact `.devex/rbac.yaml` schema (glob semantics, verb inheritance,
  default-deny vs. default-view, how `platform-team` gets `*`).
- Module catalog metadata (how a module advertises its inputs/version/scope
  to the platform; whether catalog lives in `devex-modules` or a registry).
- Bot identity & PR attribution mechanics (GitHub App vs. PAT; commit
  trailer format; how Spacelift policies treat bot-authored PRs).
- Folder→stack autodiscovery specifics in Spacelift (push policy vs. stack
  autodiscovery; naming convention; how new stacks get provisioned when the
  platform creates a new folder).
- State backend per stack in the monorepo world (one backend key per folder;
  encryption; bootstrap).
