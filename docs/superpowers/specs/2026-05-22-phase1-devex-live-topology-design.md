# Phase 1 — `devex-live` topology & Spacelift folder→stack mapping — design

First phase of the prod-fit roadmap
(`2026-05-22-devex-prod-fit-architecture-design.md`). Establishes the
`devex-live` monorepo layout convention, the `devex-modules` catalog repo, the
folder→stack contract with Spacelift, and the platform writer's path
conventions — so every later phase (canvas unification, catalog, OKTA, RBAC)
has a stable target shape to build against.

Prototyped **in this repo against Moto** first; standing up the real
`devex-live` / `devex-modules` GitHub repos and wiring real Spacelift is
deferred to the real-infra cutover.

**Status: design only, no implementation yet.**

---

## Motivation

The architecture decided a single `devex-live` monorepo, folder-per-stack,
replacing both the TF/TG folder-stacks and the CDKTF repo-stacks. Phase 1 makes
that concrete: what a folder looks like, how it becomes a Spacelift stack,
where modules live, and exactly what the platform writer must emit. Nothing
downstream can be built until this contract is fixed.

The org's Spacelift already runs an **administrative stack that discovers leaf
folders and provisions a child stack for each**, with **Spacelift-managed
state**. Phase 1 conforms `devex-live` to that existing pattern rather than
inventing a new one.

---

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| **Leaf folder** | The **deepest folder containing `*.tf`** (no marker file). One leaf = one Spacelift stack = one state. |
| **Path shape** | `account/region/layer/component/` (e.g. `billing-prod-account/us-east-1/infra/vpc`). `layer` is an open set (`infra`, `app`, `data`, …). **Environment == account** (dev/staging/prod are separate accounts); **region is explicit** — matches the Account→Region→Component navigator and gives one stack/state per region. |
| **DRY & parametrization** | Logic lives once in `devex-modules`; leaves are thin module calls. Per-stack differences (region, sizing, CIDRs, env name) are **inputs** — non-secret *shape* in a committed per-leaf `terraform.tfvars`, secrets/shared via Spacelift contexts. **No OpenTofu workspaces** for env separation. |
| **State** | **Spacelift-managed.** Leaf folders contain **no `backend` block** — Spacelift owns state per stack. |
| **Provider creds** | **Spacelift per-stack AWS integration** assumes the account role at runtime (as TF/TG stacks already auth). Leaves carry a **minimal provider** (region + `default_tags`); **no `assume_role` in HCL**. |
| **Stack creation** | The existing **admin stack** discovers leaves and creates a child stack each. No manual registration; flow stays "author folder → PR → merge → child stack appears." |
| **Modules** | Separate versioned **`devex-modules`** repo; leaves call `source = "git::…/devex-modules.git//<module>?ref=vX.Y.Z"`. Modules carry the mandatory guardrails (the hybrid happy path). |
| **Phase 1 build** | **Prototype in-repo** (`live/devex-live/`) + a modules catalog, validated end-to-end vs Moto via `tofu plan`. Real repos + real Spacelift deferred. |

---

## Target shape

```
devex-live/                              (real repo, later; live/devex-live/ in the POC)
  billing-prod-account/
    us-east-1/
      infra/
        vpc/       ← leaf: *.tf, no child *.tf → stack "billing-prod-account/us-east-1/infra/vpc"
        eks/
      app/
        payments-api/
    eu-west-1/
      infra/
        vpc/       ← same module, different region = a separate stack/state
  billing-dev-account/                   (env == account: dev is its own account)
    us-east-1/
      infra/
        vpc/
  payments-prod-account/
    us-east-1/
      data/
        rds/
```

### A leaf folder

Every leaf is a self-contained OpenTofu root module. Because plain OpenTofu has
no Terragrunt-style `generate {}`, the platform writer emits the per-leaf
boilerplate (versions, variables, provider) alongside the resources:

```
billing-prod-account/us-east-1/infra/vpc/
  versions.tf        # required_providers (aws ~> 5)
  variables.tf       # aws_region, common_tags, environment, use_localstack
  provider.tf        # minimal: region (= var.aws_region) + default_tags + localstack endpoints
  main.tf            # module call(s) and/or raw resources
  terraform.tfvars   # per-stack inputs: aws_region, environment, sizing, CIDRs (non-secret)
  # NO backend.tf    — Spacelift-managed state
```

- **No `backend` block.** Spacelift owns state per stack. (The
  generate-config-out backend issue fixed in PR #33 only ever bit the
  local-backend `live/blueprint` sandbox; it's a non-issue here.)
- **Provider stays minimal.** Region + `default_tags` (`Project` /
  `Environment` / `ManagedBy`). The Moto `dynamic "endpoints"` block (guarded by
  `var.use_localstack`, a no-op in real AWS) is retained so the *same* leaf
  validates against both Moto (POC) and real AWS (where Spacelift injects the
  account role). No `assume_role` in HCL.

### `main.tf` — hybrid authoring

```hcl
module "vpc" {
  source = "git::https://…/devex-modules.git//vpc?ref=v1.4.0"               # real repo
  # source = "git::https://github.com/mr4hands/DevEx.git//modules/vpc?ref=main"  # POC catalog

  cidr_block = "10.20.0.0/16"
  az_count   = 3
}
```

The provider's `region` comes from `var.aws_region` (set per stack in
`terraform.tfvars`), so the same `main.tf` deploys to whatever region the leaf
targets. Blessed modules carry the mandatory scope/tags (happy path). Raw
resources are allowed in the same `main.tf` as the escape hatch, guarded by the
writer + checkov (per the architecture's hybrid decision).

---

## Environments & regions

The two scaling dimensions are handled without duplicating logic:

- **DRY = modules.** Resource logic lives once in `devex-modules`. Every leaf is
  a thin module call, so adding an env or region copies a ~10-line wrapper, not
  code.
- **Separation = separate stacks.** Each `(account/env, region, component)` is
  its own leaf → its own Spacelift stack → its own state. Isolated blast radius
  per env and per region.
- **Differences = inputs, per stack:**
  - non-secret *shape* (region, sizing, CIDR) in a committed per-leaf
    `terraform.tfvars` — visible/reviewable in the PR (not a `.tf`, so it doesn't
    affect leaf detection);
  - secrets + cross-cutting account context via **Spacelift contexts / stack env
    vars** (`TF_VAR_*`).
- **dev/staging/prod** are *separate accounts* (env == account) → separate
  top-level folders. Separate AWS account + separate state is the real
  blast-radius boundary.
- **Regions** are an explicit path level → one stack/state per region; the same
  module is instantiated per region with `aws_region` as an input.

**Anti-pattern (rejected): OpenTofu workspaces for env separation.** They hide
envs inside one state, blur blast radius, and fight Spacelift's stack-per-folder
model. Explicit folders are GitOps-legible and isolate state cleanly.

---

## Spacelift mapping

- The existing **admin stack** enumerates deepest-`*.tf` folders under
  `devex-live` and provisions a child `spacelift_stack` per leaf, with
  Spacelift-managed state. `project_root` = the leaf path; the stack name
  derives from the path (`billing-prod-account/us-east-1/infra/vpc`).
- Platform flow is unchanged from the architecture: author leaf → PR →
  Spacelift plans the affected child stack → approve → merge → apply.
- **Known nuance (Spacelift-config detail):** a *brand-new* leaf's child stack
  is created by the admin stack's run, so the first plan-on-PR for a never-seen
  folder depends on how the admin stack handles not-yet-created stacks (does it
  run on the PR and surface the new stack, or only create it on merge?). This is
  a wiring detail to confirm against the real admin stack at cutover — it does
  not change the `devex-live` shape.

---

## `devex-modules`

- Separate versioned repo (real-infra). POC uses this repo's `modules/` as the
  catalog, referenced by **local path** from the prototype leaves.
- Sourcing convention (real): `source = "git::…/devex-modules.git//<module>?ref=vX.Y.Z"`.
- Modules encapsulate the mandatory guardrails (subnets, encryption, tags) so a
  leaf that stamps a module is compliant by construction. The catalog *UI*
  (advertising inputs/versions to the platform) is **Phase 3**, not here.

---

## Platform writer contract (for Phase 2 to implement)

Phase 1 fixes the contract; Phase 2 wires the app's writer to it (the writer
today emits flat `bp.*.tf` into `live/blueprint/`).

Given `(account, region, layer, component)` the writer emits into
`devex-live/<account>/<region>/<layer>/<component>/`:

- `versions.tf`, `variables.tf`, `provider.tf` boilerplate (templated, identical
  shape across leaves);
- `main.tf` with module call(s) and/or raw resources;
- `terraform.tfvars` with the per-stack inputs (`aws_region`, `environment`,
  sizing, CIDRs);
- **never** a `backend` block.

The deepest-`*.tf` leaf rule means the writer needs no marker file — creating
the folder with `.tf` content is sufficient for the admin stack to pick it up.

---

## Phase 1 prototype (what gets built, vs Moto)

1. `live/devex-live/billing-prod-account/us-east-1/infra/vpc/` — one reference
   leaf: boilerplate + `terraform.tfvars` + a `module "vpc"` call sourced by git
   ref to this repo's `modules/vpc` catalog module.
2. A reference catalog module under `modules/` (reuse/extend the existing one)
   that creates a VPC + subnets + mandatory tags.
3. `tofu init && tofu plan` for the leaf **against Moto** → resources plan
   cleanly; confirms the backend-less, minimal-provider, module-sourced leaf
   works end-to-end.
4. A short `devex-live/README` documenting the leaf convention + the writer
   contract above.

No app/writer code changes in Phase 1 (that's Phase 2). No real repos, no real
Spacelift (real-infra cutover).

---

## Out of scope (Phase 1)

- Wiring the app writer to emit `account/region/layer/component` paths — **Phase 2**
  (canvas/draft unification onto `devex-live`).
- The module catalog UI / metadata — **Phase 3**.
- OKTA identity / `.devex/rbac.yaml` — **Phases 4–5**.
- Real `devex-live` / `devex-modules` repos + real Spacelift admin-stack
  wiring — real-infra cutover.

---

## Open questions to resolve at real-infra cutover

- Admin-stack behavior for not-yet-created stacks (first plan-on-PR timing).
- Per-leaf `variables.tf` values: how `aws_region` / `common_tags` are supplied
  per account (Spacelift stack env/context vs. a per-account tfvars).
- The git-ref pinning workflow for `devex-modules` (who bumps `?ref=` and how
  the platform surfaces available versions — ties to the Phase 3 catalog).
- Exact admin-stack discovery config (the `spacelift_stack` template it applies
  per leaf: labels, dependencies, hooks).
