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

## PR workflow

`main` is protected on GitHub: direct pushes are blocked, `lint-and-test`
(the CI job) must pass before merge, force-pushes and deletions disabled,
linear history required. Every change flows through a PR.

Solo-developer recipe:

```bash
git checkout -b feat/<short-slug>          # branch from main
# ... edits + commits ...
git push -u origin feat/<short-slug>       # push the branch
gh pr create --fill                        # opens PR titled from last commit
# CI runs automatically — green light required before merge.
gh pr merge --squash                       # or --merge if you want the history
git checkout main && git pull && git branch -D feat/<short-slug>
```

The agent skills' "stage on a branch, hand off" outputs land naturally
here: the staged branch becomes the PR body, the human reviews
`git diff --staged` and runs `gh pr create`.

## CI

`.github/workflows/ci.yml` runs on every PR and push to `main`. It's an
offline gate by design — there are no AWS credentials in the runner, no
Moto service spun up, and no real cloud touched:

- `tofu fmt -recursive -check -diff` — formatting must already be clean.
- `tofu init -backend=false && tofu validate` on `bootstrap/` and
  `live/dev/`. `-backend=false` skips the S3 backend in `live/dev` so
  init doesn't need cloud reachability.
- `tofu init -backend=false && tofu validate && tofu test` on every
  directory under `modules/`. Module tests use `mock_provider "aws" {}`
  so they need no AWS at all.

Deliberately out of scope today: `tofu plan` (would need a backend or
Moto-as-service), `tofu apply` (forever — never in CI), `checkov` (until
the Python 3.14 cert-verify issue is fixed locally and wired in
intentionally), `gitleaks` (covered by pre-commit; can promote to CI
later). Apply against real AWS remains a manual, deliberate act from
your shell — see the Real-AWS workflow section.

## Agent skills loaded from `.claude/skills/`

- `opentofu-style-guide` — enforces conventions above on every HCL change.
- `opentofu-drift-detect` — detects state↔cloud divergence via refresh-only
  plans, classifies each finding, and proposes branched HCL fixes. Never
  applies. `make drift-check` is the shortcut entry point.
- `opentofu-tftest-author` — authors `.tftest.hcl` tests for modules and
  root configs. Plan-first with `mock_provider "aws" {}`; apply tests only
  against Moto with explicit opt-in. `tofu test` is the runner.
- `opentofu-aws-import` — brings out-of-band-created AWS resources under
  management via the `import { }` block + `tofu plan
  -generate-config-out`. Authors changes on a branch; never runs the
  denied `tofu import` CLI or `apply`.
- `opentofu-refactor-to-module` — extracts resources from a root config
  into a reusable module under `modules/`, with `moved { }` blocks so
  the state migrates without destroy-and-recreate. Gold standard is a
  post-refactor plan that shows zero changes.

## MCP servers

Wired in `.mcp.json` at the repo root. Claude Code prompts to trust each
server the first time it loads.

- **`terraform`** (enabled by default) — `hashicorp/terraform-mcp-server`
  pinned to `0.5.2`, run via Docker. Queries the Terraform Registry for
  provider/module docs. Works for `hashicorp/aws` since registry content is
  identical between Terraform and OpenTofu registries. Needs outbound
  network access to `registry.terraform.io`; no AWS credentials required.
  MPL-2.0.

- **`github`** (enabled by default) — `ghcr.io/github/github-mcp-server`
  pinned to `v1.0.4`, run via Docker. Reads/writes PRs, issues, branches,
  and workflow runs against your GitHub account. The agent uses it to
  inspect CI status, open PRs from staged branches the skills produce,
  and comment on its own work. Auth via the `GITHUB_PERSONAL_ACCESS_TOKEN`
  env var — Claude Code passes it through to the container. To set up:

  1. Create a fine-grained PAT at https://github.com/settings/personal-access-tokens/new
     scoped to just `mr4hands/DevEx` (or your fork), with repo `Contents`,
     `Pull requests`, `Issues`, and `Actions` permissions (read+write).
  2. `export GITHUB_PERSONAL_ACCESS_TOKEN=<token>` in the shell where you
     start Claude Code (or add it to your shell rc with appropriate
     protection).
  3. Restart Claude Code; it'll prompt to trust the server.

  MIT.

- **`awslabs.aws-api-mcp-server`** (opt-in, real-AWS mostly) — config lives
  in `.mcp.aws.example.json`. Merge that entry into `.mcp.json` when you
  want it. Launches via `uvx`, restricted with `READ_OPERATIONS_ONLY=true`
  out of the box. Uses the boto3 credential chain, which honors
  `AWS_ENDPOINT_URL_*`, so launching Claude Code from a `dev.local.env`-
  sourced shell makes it talk to Moto; a vanilla shell makes it talk to
  real AWS. Apache-2.0.

- **`aws-core` (`aws/agent-toolkit-for-aws`)** — not wired. The bundled MCP
  is the AWS-hosted `aws-mcp.us-east-1.api.aws` endpoint, which can't be
  pointed at Moto. The 14 bundled skills are CDK/CloudFormation/Amplify-
  focused and don't apply to this OpenTofu repo. Worth a second look once
  we're regularly running against real AWS; even then, prefer cherry-
  picking the MCP entry rather than installing the whole plugin.

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
- **S3 tagging path changed in AWS provider 6.x.** The provider now calls
  S3 Control's `TagResource` / `UntagResource` / `ListTagsForResource`
  first, falling back to the classic `PutBucketTagging` only if the
  principal lacks `s3:TagResource` / `s3:UntagResource` /
  `s3:ListTagsForResource`. Because Moto's IAM stub permits everything,
  the provider takes the *new* path against Moto — which may not be
  mocked. If a bucket-tag plan fails with an unexpected SDK error, deny
  those three actions on the test principal (or use Moto's policy mode)
  to force the legacy path.
