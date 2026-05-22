# Phase 2 — canvas/draft unification → devex-live leaves — design

Second phase of the prod-fit roadmap
(`2026-05-22-devex-prod-fit-architecture-design.md`,
`2026-05-22-phase1-devex-live-topology-design.md`). Collapses the app's two
pending-change paths into a single owner-scoped draft model whose staging
overlay mirrors `devex-live`, and replaces the agent-driven "commit to PR" with
a deterministic promote that renders the overlay into `devex-live` leaves.

**Status: design only, no implementation yet.**

---

## Motivation

Today the app has **two** parallel pending models (confirmed in the Phase 0
smoke):

- **Flat canvas path** — `POST /api/blueprint/resource` writes
  `live/blueprint/bp.<type>.<name>.tf` at the workspace root; `GET
  /api/blueprint/resources` reads them back.
- **Owner-draft path** — `POST /api/blueprint/draft` writes
  `live/blueprint/drafts/<owner>/…` + `_drafts.json`.

Two write paths, two promote paths, no `devex-live` awareness. Phase 1 fixed the
target shape (leaf = `account/region/layer/component`, Spacelift-managed state,
minimal provider). Phase 2 makes the app author **into that shape** through one
path, so a draft is literally a staged `devex-live` leaf.

---

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| **Single path** | Remove the flat `POST /api/blueprint/resource` write path. All create/edit/adopt/delete flow through **owner-scoped drafts**. The canvas reads/writes the overlay. |
| **Staging layout** | **Mirror the `devex-live` tree.** `drafts/<owner>/<account>/<region>/<layer>/<component>/` holds full leaf folders (boilerplate + resource files + `terraform.tfvars`), shaped exactly like `devex-live`. |
| **Navigator** | Extend to **Account→Region→Layer→Component** so the tree mirrors the 4-level leaf path 1:1. Authoring targets the selected leaf. |
| **Authoring scope** | **Raw resources + adopt/import** into leaves now. Module-catalog authoring (stamping blessed modules) stays **Phase 3**. |
| **Preview** | `tofu plan` of the staged leaf (per-leaf, against Moto) — the overlay leaf is a valid root module. |
| **Promote** | **Deterministic backend** `POST /api/blueprint/promote`: render the owner's overlay leaves into `devex-live/`, branch off the latest `main`, commit (excluding `drafts/`), push, open the PR via `gh`. **No agent** — there's no module extraction to reason about. (Bot identity replaces the local user in Phases 4/6.) |

---

## Architecture

### The unified draft overlay

`drafts/<owner>/` becomes a per-owner overlay of `devex-live`. Each authored
leaf is a real, plannable root module:

```
live/blueprint/drafts/alice/
  billing-prod-account/us-east-1/infra/vpc/
    versions.tf        # templated boilerplate (identical across leaves)
    variables.tf       #   aws_region, environment, common_tags, use_localstack
    provider.tf        #   minimal provider (localstack endpoints for Moto)
    terraform.tfvars   #   aws_region, environment (per-stack, from coords)
    aws_vpc.main.tf    # one authored raw resource (or import{}+resource for adopt)
    aws_subnet.a.tf
  _drafts.json         # per-resource intent: { "<leaf>/<addr>": {kind, owner, …} }
```

- The **boilerplate** files are the same templated set Phase 1 fixed for a
  `devex-live` leaf (no `backend`; minimal provider). The writer drops them when
  a leaf is first authored into.
- **Resource files** are one-per-resource (`<type>.<name>.tf`), reusing the
  existing HCL writer — just emitted into the leaf folder instead of the flat
  root. Adopt adds an `import { }` block above the resource (the existing
  primitive).
- `_drafts.json` records intent (kind = new/adopt/edit/delete, owner,
  source_address, import_id) keyed within the leaf, for inventory annotation and
  delete markers.

### Authoring flow

1. User selects a leaf in the Account→Region→Layer→Component tree (creating any
   missing level), establishing the `(account, region, layer, component)` coords.
2. Create / edit / adopt a raw resource → the writer ensures the overlay leaf
   exists (boilerplate + `terraform.tfvars` seeded from coords) and writes the
   resource file. Delete removes the resource file / records a delete marker.
3. The inventory + canvas read the overlay so the change shows immediately
   (`planned` rows, as today).

### Preview

`GET /api/plan-diff?root=<staged-leaf>` runs `tofu plan` on
`drafts/<owner>/<leaf>` against Moto — the same import/create/update
classification as today, now per leaf.

### Promote (deterministic)

`POST /api/blueprint/promote` (owner-scoped):

1. Render the owner's overlay leaves into `devex-live/<leaf>/` (copy the leaf
   folders; apply delete markers).
2. `git` branch off the latest `origin/main` (never off a feature branch — the
   repo's hard rule), commit the `devex-live/` changes **excluding** `drafts/`,
   push.
3. Open the PR against `main` via `gh pr create --base main`.
4. On success, clear the promoted drafts from the owner's overlay.

No LLM in the path. The branch-off-`main` rule is enforced in code, closing the
gap the Phase 0 inspection found in the old agent prompt.

---

## API & module changes

**Removed**
- `POST /api/blueprint/resource` (flat write) and its `_layout.json`-only flat
  semantics. The canvas no longer writes the flat root.

**Changed**
- `POST /api/blueprint/draft` — gains the leaf coords (`account`, `region`,
  `layer`, `component`); writes into the overlay leaf folder; seeds boilerplate +
  `terraform.tfvars`.
- `GET /api/blueprint/resources` (canvas read) — reads the owner's overlay
  (optionally scoped to the selected leaf) instead of the flat root.
- `GET /api/inventory` — the `planned`/draft overlay logic reads the
  leaf-structured overlay; classification by `(account, region, layer,
  component)` from the path rather than only the `Component` tag.
- `generate_resource_config` (Phase 1 fix) — the scratch-isolation rule must
  exclude **sibling resource files** in the leaf (keep boilerplate + the single
  `import`), since leaf resource files no longer carry the `bp.` prefix the
  current exclusion keys on. **Implementation consideration**, flagged below.

**Added**
- `POST /api/blueprint/promote` — the deterministic render + branch + PR above.

**Frontend**
- Navigator gains the **Layer** level.
- Canvas + inspector author into the selected leaf via the draft endpoints; the
  flat write path is gone.
- Pending-changes bar's "commit to PR" calls `POST /api/blueprint/promote` and
  surfaces the returned PR URL.

**Deprecated prompts**
- `commitDraftsPrompt` / `BLUEPRINT_COMMIT_PROMPT` (agent commit-to-PR) are
  removed — promote is deterministic now.

---

## Out of scope (Phase 2)

- **Module-catalog authoring** (stamping blessed modules + inputs UI) — **Phase 3**.
- **OKTA identity / `.devex/rbac.yaml`** — **Phases 4–5** (owner stays the
  `X-DevEx-Owner` header default).
- **Real `devex-live`/`devex-modules` repos + Spacelift** — real-infra cutover.
  In the POC, promote targets the in-repo `live/devex-live/` and opens a PR on
  this repo.
- **Bot identity for promote** — Phase 2 promote runs as the local user (their
  `gh`/git); the bot identity is Phase 4/6.

---

## Key implementation considerations

- **generate-config-out isolation in a leaf.** Generalize the Phase 1 fix:
  exclude all sibling resource files (not just `bp.*`) from the scratch dir,
  keeping only boilerplate + the lone `import`. Otherwise sibling resources get
  refreshed and may fail.
- **terraform.tfvars seeding.** When a leaf is first authored, seed
  `terraform.tfvars` with `aws_region` (= the region coord) and `environment`
  (derived from the account). Honors the Phase 1 gitignore carve-out.
- **Promote safety.** Branch off `origin/main` only; never force-push; exclude
  `drafts/` and any `live/blueprint/` sandbox from the commit; surface the PR
  URL. Runs as the local user in the POC.
- **Empty-leaf cleanup.** Deleting the last resource in a leaf should remove the
  staged leaf folder so promote doesn't create an empty stack.

---

## Implementation plan sketch (TDD; spec → plan)

1. Backend: leaf-aware draft writer (overlay leaf folders + boilerplate +
   tfvars seeding) — unit-tested with the existing `client`/`blueprint_env`
   fixtures.
2. Backend: generalize `generate_resource_config` sibling-exclusion — unit test.
3. Backend: `POST /api/blueprint/promote` render step (overlay → devex-live)
   unit-tested; git/PR step tested behind a thin seam (mock `gh`/git).
4. Backend: update `/api/blueprint/resources` + `/api/inventory` to the overlay;
   remove the flat `POST /api/blueprint/resource`.
5. Frontend: Layer nav level; author-into-leaf; promote button → PR URL; delete
   the agent commit prompts.
6. Validate end-to-end against Moto: author raw + adopt into a leaf → per-leaf
   plan → promote → PR.

---

## Open questions to resolve in the plan

- Resource-file naming inside a leaf (`<type>.<name>.tf` vs a single assembled
  `main.tf`); affects the writer + the generate-config exclusion rule.
- Whether `_drafts.json` stays per-resource or moves to per-leaf with a resource
  list.
- Promote conflict handling when `devex-live` already has the target leaf (merge
  vs reject vs update) — likely "update the leaf's resource files," but confirm.
