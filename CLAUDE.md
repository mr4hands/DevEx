# DevEx Platform — Claude Code Workspace

AI-first OpenTofu lab on AWS, runnable against **Moto** (default for
this POC) or **real AWS**. The repo is both a working IaC codebase and the
context Claude Code reads when assisting on it.

## Layout

- `bootstrap/` — creates the remote state backend (S3 + DynamoDB + KMS).
  Uses **local state**. Run once per target (Moto or AWS account).
- `live/dev/` — root config for the `dev` environment. Uses the bootstrapped
  remote backend with OpenTofu native client-side state encryption.
- `modules/` — reusable OpenTofu modules. One module per directory.
- `policies/` — Checkov skip-lists and (later) OPA Rego policies.
- `tests/` — repo-level integration tests. Per-module tests live alongside
  the module in `modules/<name>/tests/`.
- `.claude/skills/` — packaged agent skills auto-loaded by Claude.
- `docker-compose.yml`, `dev.local.env`, `Makefile` — Moto glue.
- `research/` — background docs informing the platform design.

## Toolchain

| Tool | Why | Install |
|------|-----|---------|
| `tofu` ≥ 1.12.0 | IaC engine. Pin in `.opentofu-version`. | `brew install opentofu` |
| `aws` | Cloud auth + read-only inspection. | `brew install awscli` |
| `docker` | Runs Moto. | Docker Desktop or `brew install colima docker docker-compose` |
| `pre-commit` | Local fmt/lint/scan gate. | `brew install pre-commit && pre-commit install` |
| `checkov` | Static security scan of HCL. | Installed via pre-commit |
| `gitleaks` | Secret scan. | Installed via pre-commit |

## Cloud mode

The platform supports two targets, both driven by `var.use_localstack`:

- **Moto (default)** — `source dev.local.env` exports
  `TF_VAR_use_localstack=true` and `AWS_ENDPOINT_URL_*` redirects. Provider
  blocks emit a `dynamic "endpoints"` block pointing at `http://localhost:4566`.
- **Real AWS** — open a fresh shell (don't source the env file), authenticate
  with `aws sso login` or your usual flow. `var.use_localstack` defaults to
  `false`; all overrides become no-ops.

The HCL is identical for both. Switching is purely an environment + backend
config swap.

## Moto workflow

```bash
# One-time
brew install opentofu awscli docker pre-commit
pre-commit install

# Per session
make local-up                    # start Moto
source dev.local.env             # point shell at Moto
make bootstrap-local             # create backend (S3, DynamoDB, KMS) inside Moto
make init-dev-local              # init live/dev against the Moto backend
make plan-dev                    # tofu plan — should be "No changes" until we add resources

# Tear down
make destroy-bootstrap-local     # remove backend resources
make local-clean                 # stop Moto and wipe persisted data
```

The Makefile sources `dev.local.env` inside each recipe so individual targets
are self-contained — you don't strictly need to `source` it in your shell
unless you're running `tofu` commands directly.

## Real-AWS workflow

```bash
# Fresh shell (or `unset` any sourced Moto vars)
aws sts get-caller-identity      # confirm auth

cd bootstrap
tofu init && tofu plan
tofu apply                       # creates ~3 real AWS resources, ~$1/month

cd ../live/dev
cp backend.aws.hcl.example backend.hcl
# Edit backend.hcl — replace <ACCOUNT_ID> with output from `tofu -chdir=../../bootstrap output`
tofu init -backend-config=backend.hcl
tofu validate && tofu plan
```

There's deliberately no `make apply-aws-prod` target. Real-AWS applies stay
manual.

## HCL conventions

- **Files per dir**: `versions.tf`, `variables.tf`, `main.tf`, `outputs.tf`,
  `locals.tf` (only if non-trivial). Backend config in `backend.tf`.
- **Naming**: `snake_case` for resources, variables, outputs, locals.
  Module directories use `kebab-case`.
- **Variables**: always typed, always described, mark sensitive when sensitive.
- **Outputs**: always described.
- **Tags**: every account uses provider `default_tags` for `Project`,
  `Environment`, `ManagedBy`. Resource-specific tags merge on top.
- **Iteration**: prefer `for_each` over `count` — stable keys survive
  reordering.
- **Modules**: no `provider` blocks inside modules. Pass providers from the
  caller when needed.
- **State**: never edit state by hand. Use `moved { }` blocks for refactors.
  `.terraform.lock.hcl` is committed.
- **Testing**: every module ships at least one `.tftest.hcl` with a `plan`
  assertion on required outputs.

Full conventions live in `.claude/skills/opentofu-style-guide/SKILL.md`.

## Safety rules (non-negotiable)

- `tofu apply`, `tofu destroy`, `tofu state rm|mv|push`, `tofu force-unlock`,
  and `tofu import` are **denied** in `.claude/settings.json`. Each requires
  a manual run by you.
- Moto-scoped make targets (`make bootstrap-local`, `make destroy-bootstrap-local`)
  *are* pre-allowed because they only mutate the local emulator — no real
  cloud resources, no money, fully reversible via `make local-clean`.
- Mutating AWS CLI calls against real AWS (`create-*`, `delete-*`, `put-*`,
  `attach-*`, `detach-*`) are not pre-allowed and will prompt every time.
- Secrets never enter the repo. Use AWS profile credentials and (later) Infisical.

## Agent skills loaded from `.claude/skills/`

- `opentofu-style-guide` — enforces conventions above on every HCL change.
- `opentofu-drift-detect` — detects state↔cloud divergence via refresh-only
  plans, classifies each finding, and proposes branched HCL fixes. Never
  applies. `make drift-check` is the shortcut entry point.

(Refactor-to-module, tftest-author, and AWS-import skills land in
subsequent iterations.)

## MCP servers

Deferred until verified. The plan calls for an OpenTofu Registry MCP and an
AWS read-only MCP; current community implementations need to be vetted before
wiring into `.mcp.json`. Until then, Claude relies on its own knowledge and
the registry docs reachable via WebFetch when needed.

## Known Moto caveats

- KMS GenerateDataKey is mocked but returns well-formed keys, so OpenTofu
  native state encryption *should* round-trip cleanly. If `init` fails on
  the encryption block, set `TF_ENCRYPTION='{}'` to disable encryption for
  the local session, or comment out `live/dev/encryption.tf`.
- IAM policy enforcement is essentially absent — broken IAM in HCL will
  apply successfully against Moto. Rely on `checkov` to catch what Moto
  won't.
- The default Moto account ID is `123456789012`; that's embedded in the
  bucket name in `backend.local.hcl.example`.
- No persistence by default. Restarting the container resets all state;
  `make local-down && make local-up && make bootstrap-local` rebuilds in
  under a minute. Add a `--state-file` mount if you need cross-restart
  persistence.
