# Adopt existing AWS resources via a discovery skill — design

Drag existing, **unmanaged** AWS resources from a tree onto the Blueprint
canvas to see, inspect, and edit them. Dropping a resource *adopts* it: the
backend authors an `import { }` block plus a `resource { }` body so OpenTofu
can take over management. The adopted node is then a normal Blueprint node —
editable in the existing drawer form, plannable via the plan-diff tab, and
promotable through the existing **commit-to-PR → manual apply** path.

**Status: design only. No implementation yet.**

---

## Motivation

The Blueprint canvas today renders only resources *it* authored
(`live/blueprint/bp.<type>.<name>.tf`). It cannot surface or adopt resources
that already exist in AWS. The ask: see existing resources in a tree, drag
them onto the canvas, and edit them — i.e. a visual front-end for the
`opentofu-aws-import` flow.

The target is **genuinely unmanaged / ClickOps resources** (`source=aws`),
not resources already tracked in a tofu workspace. Adopting an
already-managed resource would create double-management (two configs, one
real resource); unmanaged resources have no prior HCL, so adoption is
conflict-free and authoring the first config for them is exactly the point.

---

## Why adoption = `import { }` + `resource { }`

OpenTofu reconciles three things: **config** (HCL), **state** (its record of
what it manages), and **reality** (the real AWS resource). To bring an
existing resource under management you must connect config ↔ reality, which
needs both blocks:

- **`resource { }`** declares the desired shape and is what you edit going
  forward (config is this repo's source of truth).
- **`import { }`** says "a real resource with *this id* already exists;
  record it into state instead of creating a new one."

Failure modes if only one is present:

- **Only `resource`** → state has no record → `plan` says *1 to add* →
  `apply` tries to **create a duplicate** (e.g. S3 `BucketAlreadyExists`).
- **Only `import`** → tofu errors *"configuration for import target does not
  exist"* — which is exactly what `tofu plan -generate-config-out` fills.
- **Both** → tofu reads the existing resource into state and reconciles.
  Adoption, not creation.

### Worked example

Drag an existing bucket `acme-prod-logs`. The backend writes
`live/blueprint/bp.aws_s3_bucket.acme_logs.tf`:

```hcl
import {
  to = aws_s3_bucket.acme_logs   # address inside this workspace
  id = "acme-prod-logs"          # real AWS id, from discovery
}

resource "aws_s3_bucket" "acme_logs" {
  bucket = "acme-prod-logs"      # thin pre-fill
}
```

`tofu plan` → `Plan: 1 to import, 0 to add, …` (`action_kind = "import"`,
already rendered by the plan-diff tab). Editing the resource (e.g. enabling
versioning) shifts the plan to `action_kind = "import_update"` — adopt and
change in one apply — also already a known action kind in the UI.

The canvas's job is to **author these two blocks**, never to mutate the cloud
directly.

---

## Architecture

Three deterministic pieces plus one agent piece. The agent only *fills* the
tree; everything downstream is deterministic and type-agnostic.

1. **Discovery skill (agent)** — the only LLM part. Enumerates a scope via
   the read-only AWS MCP, applies per-type import-id rules, and writes/merges
   a manifest.
2. **Manifest** (`live/blueprint/_discovered.json`) — the structured handoff
   between agent and UI.
3. **Tree endpoint + UI** (deterministic) — serves and renders the manifest;
   dragging a row adopts the resource.
4. **Adopt / edit / generate-clean** (deterministic) — authors `import` +
   `resource`, edits via the existing form, generates apply-clean config on
   demand.

This mirrors a pattern the app already uses: the chat agent's `Edit`/`Write`
tools drop HCL into `live/blueprint/`, and `onToolResult` bumps a reload so
the canvas re-fetches `/api/blueprint/resources` (`app/frontend/app/page.tsx`).
"Agent produces an artifact → deterministic endpoint serves it → UI refetches
on a signal" is the established shape; the discovery skill + manifest reuse it.

### Why agent-driven discovery (not backend-hardcoded)

- The `awslabs.aws-api-mcp-server` is already designed for read-only AWS calls
  (`READ_OPERATIONS_ONLY=true`, honors `AWS_ENDPOINT_URL_*` → Moto or real
  AWS). The FastAPI backend can't call an MCP mid-request; the agent can.
- The painful per-type knowledge — which `list`/`describe` call to use,
  pagination, and mapping each resource to its correct **import id** (S3 =
  bucket name, IAM = role name, EC2 = instance id) — is reasoning the LLM +
  skill can apply to arbitrary types. This is what makes "all types"
  tractable without pre-wiring every service.
- Rendering stays deterministic (manifest + endpoint), so the tree is snappy,
  cacheable, and survives reloads; re-discovery is an explicit refresh.

---

## Components

### Discovery skill — `.claude/skills/aws-resource-discovery/` (new)

- **Input:** a scope — `all`, a single type (`aws_s3_bucket`), or a
  service/tag grouping.
- **Capability:** the read-only AWS MCP. Read-only is enforced by the MCP
  (`READ_OPERATIONS_ONLY`); the skill never mutates AWS.
- **Output:** for each discovered resource, `{address, type, name, import_id,
  summary_attributes}`, applying per-type import-id rules. Merges into the
  manifest **per branch** — never clobbers branches it didn't load.
- Idempotent: re-running a scope refreshes that branch and updates
  `generated_at` / `scopes_loaded`.

### Manifest — `live/blueprint/_discovered.json` (new)

```json
{
  "source": "aws",
  "generated_at": "2026-05-21T18:30:00Z",
  "scopes_loaded": ["aws_s3_bucket", "aws_iam_role"],
  "groups": [
    {
      "type": "aws_s3_bucket",
      "resources": [
        {
          "address": "aws_s3_bucket.acme_logs",
          "type": "aws_s3_bucket",
          "name": "acme_logs",
          "import_id": "acme-prod-logs",
          "summary_attributes": { "bucket": "acme-prod-logs", "region": "us-east-1" }
        }
      ]
    }
  ]
}
```

`summary_attributes` are display/thin-pre-fill hints only — AWS API shapes are
not tofu attribute shapes, so the authoritative resource body comes from
`generate-config-out`, not from this map.

### Backend — `app/backend/src/devex_app/`

- **`routes/existing.py` (new)** — `GET /api/existing-resources` serves the
  manifest deterministically (no LLM). Optional `?scope=` slices to one
  branch. Returns `{source, generated_at, scopes_loaded, groups}`. Missing
  manifest → empty result with a "discovery unavailable" hint, never a 500.
- **`routes/blueprint.py` (changed)**
  - `ResourceWriteRequest` gains optional `import_id`. When set,
    `write_resource` prepends an `import { to, id }` block.
  - The `type` validator relaxes from `SUPPORTED_TYPES` membership to the
    format-only `_DELETE_TYPE_RE` already used by delete — any valid type
    identifier is writable.
  - `_parse_resource_file` reads + preserves the `import { }` block
    (`hcl2.loads` exposes it under the `import` key), matches it to the
    resource by `to` address, and surfaces `import_id` in
    `GET /api/blueprint/resources`. Form edits re-write and keep the import
    block.
- **`POST /api/blueprint/generate-config` (new)** — `{type, name}` → runs
  `tofu plan -generate-config-out` in an **isolated scratch dir** (provider /
  `versions.tf` config + the import block *only*, reusing
  `live/blueprint/`'s initialized plugins via `TF_DATA_DIR` / plugin cache),
  parses the generated HCL for the address, writes it back as the resource
  body (keeping the import block), and returns `{type, name, hcl}`. The
  scratch dir is required because `generate-config-out` skips any address that
  already has a resource body. Fallback if isolation proves brittle: in-place
  temporary body-strip with a `try/finally` restore + atomic writes.
- **`routes/blueprint.py` `/api/schemas` + `tofu.py` (changed)** — drop the
  5-type allowlist; serve any type's slice of the provider schema (the
  normalizers are already generic). Add an in-process schema cache in
  `tofu.py`: parse `tofu providers schema -json` once, key by workspace +
  provider version, invalidate on `.terraform.lock.hcl` mtime, slice per
  requested type. Avoids re-parsing ~30 MB per drag.

### Frontend — `app/frontend/`

- **`components/ExistingResourceTree.tsx` (new)** — renders the manifest
  grouped by type (mirrors `ResourceList`'s visual language). A cold/empty
  branch shows a **"discover"** affordance that seeds a scoped agent run.
  Rows are draggable; the drag payload carries `{type, name, import_id,
  summary_attributes}`. Shows `generated_at` + a re-discover control.
- **`components/BlueprintCanvas.tsx` (changed)** — left rail hosts the
  palette **and** the tree. `onDrop` distinguishes a palette drag (fresh
  node, existing path) from a tree drag (adopt-with-import). Adopted nodes
  render an "imported" badge.
- **`components/BlueprintNodeDrawer.tsx` (changed)** — for adopted nodes,
  shows the import id and a **"generate clean config"** button; otherwise the
  existing schema-driven edit form is reused unchanged.
- **`app/page.tsx` (changed)** — generalize `pendingPrompt` to carry
  discovery prompts (scoped to a branch). `onToolResult` already bumps a
  reload signal; the tree subscribes to it and refetches the manifest — the
  same loop the canvas uses.
- **`lib/api.ts` / `lib/types.ts` (changed)** — client fns + types for
  `/api/existing-resources`, `generate-config`, and the `import_id` field.
- **`lib/resourceFamilies.ts` / `blueprintPalette.ts` (changed)** — fallback
  family/monogram for types outside the curated cosmetic map.

### MCP

Wire `awslabs.aws-api-mcp-server` into `.mcp.json` (currently opt-in via
`.mcp.aws.example.json`). Document the read-only posture
(`READ_OPERATIONS_ONLY=true`) and that the boto3 credential chain honors
`AWS_ENDPOINT_URL_*`, so a `dev.local.env`-sourced shell discovers against
Moto and a vanilla shell discovers against real AWS.

---

## Data flow

1. **Discover.** User expands a branch or clicks "discover" → UI seeds a
   scoped prompt (via `pendingPrompt`) → agent runs the discovery skill via
   the AWS MCP → merges the branch into `_discovered.json` → `onToolResult`
   bumps the reload signal.
2. **Render.** Tree refetches `GET /api/existing-resources` and renders the
   branch.
3. **Adopt.** User drags a row onto the canvas → `POST /api/blueprint/
   resource` with `import_id` → backend writes `import { }` + thin `resource
   { }` → node appears with an import badge.
4. **Inspect / edit.** Selecting the node opens the existing drawer form
   (rich schema-driven, all types). Edits re-write the file, preserving the
   import block.
5. **Generate clean config.** "Generate clean config" → `POST /api/blueprint/
   generate-config` swaps the thin body for apply-clean HCL.
6. **Preview.** The blueprint plan-diff tab shows `import` / `import_update`.
7. **Promote.** "Commit to PR" drives the agent to promote into a module +
   open a PR. Apply stays manual.

---

## Error handling & caveats

- **Thin pre-fill for `source=aws`.** AWS API shapes ≠ tofu attribute shapes,
  so drop pre-fills only the obvious identifier (e.g. `bucket`); the
  authoritative body comes from `generate-config-out`. The hybrid still
  holds: instant thin node now, clean body on demand.
- **Manifest staleness.** The manifest is a point-in-time snapshot. The tree
  shows `generated_at` and a re-discover affordance. An import target that no
  longer exists surfaces as a `generate-config` / plan error, not a crash.
- **Skill failure / MCP not wired.** `GET /api/existing-resources` returns an
  empty manifest with a clear "discovery unavailable — enable the AWS MCP"
  hint rather than failing.
- **Moto coverage.** Discovery and `generate-config-out` against Moto depend
  on Moto implementing the relevant read APIs for a given type; gaps degrade
  gracefully (empty branch / generate error), they don't break the canvas.
- **Safety posture.** Discovery is read-only (MCP-enforced). Adoption only
  authors HCL. `tofu apply`, `tofu import` (the CLI), and state mutation stay
  manual/denied. The flow never mutates a source resource and never performs
  cross-workspace state moves (`state rm`/`import` are denied; `moved { }`
  only relocates within one state).

---

## Testing

- **Backend (pytest, no AWS):** manifest serving (well-formed / empty /
  malformed); adopt-write emits a correct `import { }`; parser round-trips the
  import block and surfaces `import_id`; `/api/schemas` all-types + cache
  behavior.
- **`generate-config-out`:** against Moto with a seeded resource (opt-in,
  mirroring the `opentofu-tftest-author` apply-test posture). Asserts the
  thin body is replaced and the import block survives.
- **Skill:** a dry-run / schema check that the manifest it produces matches
  the documented shape.
- **Frontend:** drag-from-tree → adopt node creates an import-badged node;
  "generate clean config" round-trip against a mocked endpoint; uncurated
  type renders with a fallback monogram.

---

## Non-goals

- **Direct mutation of live state** through the canvas (edits flow config →
  PR → manual apply).
- **Cross-workspace moves** (adopt-here-and-decommission-the-original) —
  requires denied state surgery.
- **`source=state`** (adopting already-managed resources) — superseded by
  `source=aws`; it only demonstrates the import primitive and risks
  double-management.
- **Auto-apply of adoptions** — apply stays a manual, deliberate act.
