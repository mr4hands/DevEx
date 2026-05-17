SHELL := /bin/bash

# macOS ships GNU Make 3.81 which lacks .ONESHELL — each recipe line spawns
# its own subshell. Recipes that need env/state across steps chain with `&& \`.

.PHONY: help local-up local-down local-clean local-logs local-status \
        bootstrap-local destroy-bootstrap-local init-dev-local plan-dev \
        apply-dev-local fmt validate test

help:  ## List targets
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-26s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ----- Moto lifecycle -----

local-up:  ## Start Moto AWS-mock container
	docker compose up -d
	@echo "Moto starting on http://localhost:4566 (→ container :5000) — wait ~5s for readiness."

local-down:  ## Stop Moto container
	docker compose down

local-clean: local-down  ## Stop Moto and remove any persisted volumes
	-rm -rf .moto-data .localstack-data

local-logs:  ## Tail Moto logs
	docker compose logs -f moto

local-status:  ## Show Moto readiness (HTTP code on /moto-api/)
	@curl -sf -o /dev/null -w "moto /moto-api/ → HTTP %{http_code}\n" http://localhost:4566/moto-api/

# ----- OpenTofu against Moto -----

bootstrap-local:  ## Create remote state backend inside Moto
	. ./dev.local.env && \
	  cd bootstrap && \
	  tofu init -upgrade && \
	  tofu apply -auto-approve

destroy-bootstrap-local:  ## Destroy Moto backend resources
	. ./dev.local.env && \
	  cd bootstrap && \
	  tofu destroy -auto-approve

init-dev-local:  ## Init live/dev against Moto remote backend
	. ./dev.local.env && \
	  cp live/dev/backend.local.hcl.example live/dev/backend.hcl && \
	  cd live/dev && \
	  tofu init -reconfigure -backend-config=backend.hcl

plan-dev:  ## tofu plan in live/dev
	. ./dev.local.env && \
	  cd live/dev && \
	  tofu plan

apply-dev-local:  ## tofu apply in live/dev against Moto (auto-sources dev.local.env)
	. ./dev.local.env && \
	  cd live/dev && \
	  tofu apply -auto-approve

drift-check:  ## Refresh-only plan to detect drift in live/dev (exit 2 = drift)
	. ./dev.local.env && \
	  cd live/dev && \
	  tofu plan -refresh-only -detailed-exitcode -no-color

# ----- Local hygiene -----

fmt:  ## Format all HCL recursively
	tofu fmt -recursive

validate:  ## Validate live/dev config
	. ./dev.local.env && \
	  cd live/dev && \
	  tofu validate

test:  ## Run tofu test in live/dev
	. ./dev.local.env && \
	  cd live/dev && \
	  tofu test
