# DevEx Platform

[![CI](https://github.com/mr4hands/DevEx/actions/workflows/ci.yml/badge.svg)](https://github.com/mr4hands/DevEx/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![OpenTofu](https://img.shields.io/badge/OpenTofu-1.12.0-blueviolet)](.opentofu-version)

AI-first OpenTofu lab on AWS — runnable end-to-end against
[Moto](https://github.com/getmoto/moto) (no AWS account required) or a real
AWS account when you have one. Built as a self-contained workspace where
Claude Code is an active collaborator: the repo ships [agent
skills](.claude/skills/) that enforce conventions, detect drift, author
tests, import out-of-band resources, and refactor HCL into modules.

## Why this exists

Most OpenTofu repos optimize for human authors; the AI is bolted on. This
one inverts that — the human-facing conventions in [CLAUDE.md](CLAUDE.md)
and the agent skills are the same document, and both are versioned with
the code. Practical effect: the agent applies the style guide, tests, and
safety rails consistently across every change, and any new contributor
(human or model) inherits the same context on day one.

## Quickstart (Moto, no AWS account)

```bash
brew install opentofu awscli docker pre-commit
pre-commit install

make local-up             # start Moto on localhost:4566
make bootstrap-local      # create S3 + DynamoDB + KMS backend inside Moto
make init-dev-local       # init live/dev against the Moto backend
make plan-dev             # should plan the modules cleanly
```

Apply is intentionally manual:

```bash
cd live/dev
source ../../dev.local.env
tofu apply                # human-only; the agent never runs apply
```

Teardown: `make local-clean`.

## Layout

```
bootstrap/         remote-state backend (S3 + DynamoDB + KMS), local state
live/dev/          dev environment composition, uses the bootstrapped backend
modules/           reusable OpenTofu modules (s3-bucket, vpc, …)
policies/          checkov skip-list with rationale
.claude/skills/    agent skills (style-guide, drift-detect, tftest-author,
                   aws-import, refactor-to-module)
.github/workflows/ offline CI gate (fmt, validate, tofu test per module)
research/          background docs that shaped the design
```

Full conventions, safety rules, MCP wiring, and PR workflow live in
[CLAUDE.md](CLAUDE.md).

## Switching to real AWS

`var.use_localstack = false` (the default) makes every Moto-specific
override a no-op. From a fresh shell with `aws sso login` (or equivalent),
the same HCL applies against real AWS. See [the Real-AWS workflow
section](CLAUDE.md#real-aws-workflow) in `CLAUDE.md`.

## License

[MIT](LICENSE). The third-party tools this workspace orchestrates carry
their own licenses (OpenTofu MPL-2.0, Moto MIT, AWS provider MPL-2.0,
checkov Apache-2.0, terraform-mcp-server MPL-2.0, github-mcp-server MIT,
aws-api-mcp-server Apache-2.0).
