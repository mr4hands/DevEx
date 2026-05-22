# devex-live (Phase 1 prototype)

In-repo prototype of the `devex-live` monorepo from the prod-fit architecture.
The real `devex-live` becomes its own GitHub repo at the real-infra cutover; for
now it lives here so we can validate the convention against Moto.

Design: `docs/superpowers/specs/2026-05-22-phase1-devex-live-topology-design.md`.

## Leaf convention

```
<account>/<region>/<layer>/<component>/
```

- **Leaf = the deepest folder containing `*.tf`.** One leaf = one Spacelift
  stack = one state. The admin stack discovers leaves and provisions a child
  stack per leaf — no marker file, no manual registration.
- **env == account** (dev/staging/prod are separate accounts). **Region is an
  explicit path level** (one stack/state per region).
- **No `backend` block** — Spacelift manages state per stack.
- **Minimal provider** (region + `default_tags`); no `assume_role` — Spacelift's
  per-stack AWS integration injects the account role at runtime.

## DRY & parametrization

- Resource logic lives once in the catalog modules; each leaf is a thin module
  call. Adding an env or region copies a small wrapper, not code.
- Per-stack differences are **inputs**: non-secret shape (region, sizing, CIDRs)
  in a committed `terraform.tfvars`; secrets / cross-cutting context via
  Spacelift contexts (`TF_VAR_*`).
- No OpenTofu workspaces for env separation.

## POC notes

- The reference leaf `billing-prod-account/us-east-1/infra/vpc/` sources the
  catalog module by **relative path** to this repo's `modules/vpc` (offline,
  no auth). Real `devex-live` uses `source = "git::…/devex-modules.git//vpc?ref=vX.Y.Z"`.
- Validated with `tofu plan` against Moto (source `dev.local.env` first).
