# Phase 2b — Canvas/Draft Unification (Frontend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web UI author all changes into the `devex-live` overlay through one leaf-scoped draft path: add a **Layer** level to the navigator, let the user select/create a leaf (`account/region/layer/component`) and author raw + adopt resources into it, preview a single staged leaf with `tofu plan`, and replace the agent-driven "commit to PR" with a deterministic `POST /api/blueprint/promote` that surfaces the PR URL. Delete the dead flat write path and the agent commit prompts.

**Architecture:** Phase 2a already moved the backend to a per-owner overlay shaped like `devex-live` (`drafts/<owner>/<account>/<region>/<layer>/<component>/`), made `POST /api/blueprint/draft` require leaf coords, added `POST /api/blueprint/promote`, and removed the flat `POST /api/blueprint/resource`. **The frontend was not updated, so authoring is currently broken against 2a** (it still posts `{kind,type,name,component}` with no coords, and the canvas still calls the removed flat endpoints). This plan introduces an **active-leaf** concept in `app/frontend/app/page.tsx`: the navigator picks/creates a leaf, and every author surface (QuickCreate, inspector adopt, canvas drop) writes drafts into that leaf. A few thin backend enablers ride along: inventory emits the `layer` coord, `write_draft` accepts nested `blocks` (so canvas block authoring doesn't regress), `plan-diff` gains a `leaf=` selector, and the dead flat endpoints (`PATCH /blueprint/layout`, `DELETE /blueprint/resource`) are removed.

**Tech Stack:** Next.js 16 (App Router, all touched files are `"use client"`), React 19, TypeScript, Tailwind v4, `@xyflow/react` (React Flow). Backend: FastAPI, pytest + `TestClient`, OpenTofu CLI (Moto for manual e2e).

**Spec:** `docs/superpowers/specs/2026-05-22-phase2-canvas-draft-unification-design.md`
**Predecessor plan (shipped, PR #37):** `docs/superpowers/plans/2026-05-22-phase2a-canvas-draft-unification-backend.md`

---

## Decisions baked into this plan (confirmed with the user)

1. **Leaf creation UI** = a single **"+ new leaf"** form (4 coord inputs, validated to the backend's `^[a-z0-9][a-z0-9-]{0,63}$` rule) **plus** a **"+add"** affordance on existing leaf (component) nodes that reuses their known coords. No inline per-level "+add child".
2. **Existing managed/unmanaged resources** have `account`+`region` but no `layer`/`component` leaf path. So: **create-new** and **adopt-discovered** flow into an explicitly chosen leaf; **editing/deleting existing _managed_ resources is parked** (those inspector buttons are hidden). Draft rows the user just authored keep edit/discard (they carry coords).
3. **Per-leaf plan preview** is **in scope**: add a `leaf=<relpath>` selector to `/api/plan-diff` + a frontend selector.

---

## Conventions in this codebase (read before starting)

- **Next.js is non-standard here.** `app/frontend/AGENTS.md` warns: "This is NOT the Next.js you know — read the relevant guide in `node_modules/next/dist/docs/` before writing any code." All files touched here are existing `"use client"` components and a plain TS lib; no routing/server-component changes. Still, if a build error mentions an API shape, consult those docs rather than guessing from training data.
- **There is no frontend test runner** (no vitest/jest/RTL — confirmed in `package.json`). Frontend tasks are verified by, in order: `npx tsc --noEmit` (type-check), `npm run lint`, `npm run build`, then **manual browser testing** per the repo rule ("For UI/frontend changes, start the dev server and use the feature in a browser"). Treat the type-check + build as the automated gate.
- **Backend tasks use real TDD** with pytest. Tests use the `client` + `blueprint_env` fixtures in `app/backend/tests/conftest.py` (`blueprint_env` = a tmp blueprint root; `X-DevEx-Owner` header sets owner, default `local`). Run from `app/backend/` with `uv run pytest`.
- Frontend dev server proxies `/api/*` to the backend, so `npm run dev` on :3000 talks to uvicorn on the backend port.
- Run frontend commands from `app/frontend/`; backend commands from `app/backend/`.

---

## File Structure

**Backend (thin enablers):**
- Modify: `app/backend/src/devex_app/routes/inventory.py` — emit `layer` on every inventory row.
- Modify: `app/backend/src/devex_app/routes/blueprint.py` — `DraftRequest` gains `blocks`; `write_draft` renders them; **remove** `patch_layout` (`PATCH /blueprint/layout`), `LayoutPatchRequest`, `delete_resource` (`DELETE /blueprint/resource/{type}/{name}`), and the now-unused `ResourceWriteRequest`/layout helpers if nothing else references them.
- Modify: `app/backend/src/devex_app/routes/plan.py` — `plan-diff` gains an owner-scoped `leaf=<relpath>` selector.

**Frontend shared layer:**
- Modify: `app/frontend/lib/types.ts` — `LeafCoords`, coords on `DraftRequest`/`Draft`/`InventoryResource`, `leaf` on `BlueprintResource`, `PromoteResponse`.
- Modify: `app/frontend/lib/api.ts` — `discardDraft` takes coords; add `promoteDrafts`; `fetchPlanDiff` gains `leaf`; **remove** `writeBlueprintResource`, `deleteBlueprintResource`, `patchBlueprintLayout`.

**Frontend components:**
- Create: `app/frontend/components/LeafForm.tsx` — the "+ new leaf" coord form.
- Modify: `app/frontend/app/page.tsx` — `activeLeaf` state, promote handler, wire LeafForm/QuickCreate by coords, delete dead prompts.
- Modify: `app/frontend/components/ResourceTree.tsx` — add Layer level; leaf select + "+add"; "+ new leaf" header button.
- Modify: `app/frontend/components/QuickCreate.tsx` — author into leaf coords.
- Modify: `app/frontend/components/ResourceInspector.tsx` — coords on draft edit/discard; park managed edit/delete; adopt needs active leaf.
- Modify: `app/frontend/components/BlueprintNodeDrawer.tsx` — save/delete via the draft path with leaf coords.
- Modify: `app/frontend/components/BlueprintCanvas.tsx` — drop into the active leaf via drafts; drop layout persistence; promote button.
- Modify: `app/frontend/components/PendingChanges.tsx` — "commit to PR" → `promoteDrafts`, show PR URL.
- Modify: `app/frontend/components/PlanDiff.tsx` — per-leaf selector.

---

## Task 1: Inventory emits the `layer` coord (backend)

The navigator's new Layer level groups by `row.layer`. The overlay draft entry already records `layer`; surface it. Managed/unmanaged rows (from state / discovery) have no leaf path, so they bucket under `"unassigned"`.

**Files:**
- Modify: `app/backend/src/devex_app/routes/inventory.py`
- Test: `app/backend/tests/test_inventory_overlay.py` (extend)

- [ ] **Step 1: Write the failing test**

```python
# append to app/backend/tests/test_inventory_overlay.py
def test_inventory_draft_row_carries_layer(client, blueprint_env):
    client.post("/api/blueprint/draft", json={
        "kind": "new", "type": "aws_vpc", "name": "main",
        "attributes": {"cidr_block": "10.0.0.0/16"},
        "account": "billing-prod-account", "region": "us-east-1",
        "layer": "infra", "component": "net",
    })
    out = client.get("/api/inventory").json()
    row = next(r for r in out["resources"]
               if r["address"] == "aws_vpc.main" and r.get("draft_kind"))
    assert row["layer"] == "infra"


def test_inventory_managed_rows_have_a_layer_key(client, blueprint_env):
    # Even with no managed state, the contract is: every row has `layer`.
    out = client.get("/api/inventory").json()
    assert all("layer" in r for r in out["resources"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/backend && uv run pytest tests/test_inventory_overlay.py -k layer -v`
Expected: FAIL — `KeyError: 'layer'` (rows don't carry the field yet).

- [ ] **Step 3: Write minimal implementation**

In `app/backend/src/devex_app/routes/inventory.py`, add `"layer": "unassigned",` to **both** the managed row dict (the `items[key] = { ... }` near line 60) and the unmanaged row dict (near line 89). Then in the draft-overlay block (the `items[f"draft:{key}"] = { ... }` near line 132) add `"layer": entry.get("layer", "unassigned"),`.

For example, the draft row becomes:

```python
        items[f"draft:{key}"] = {
            "address": address,
            "type": type_,
            "name": name,
            "id": None,
            "arn": attrs.get("arn"),
            "account": entry.get("account", "unknown"),
            "region": entry.get("region", "unknown"),
            "layer": entry.get("layer", "unassigned"),
            "managed": False,
            "state": "planned",
            "draft_kind": entry.get("kind"),
            "component": entry.get("component", "Unassigned"),
            "component_source": "leaf",
            "tags": attrs.get("tags") or {},
            "values": attrs,
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/backend && uv run pytest tests/test_inventory_overlay.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/routes/inventory.py app/backend/tests/test_inventory_overlay.py
git commit -m "feat(app): inventory rows carry the leaf layer coord"
```

---

## Task 2: `write_draft` renders nested blocks (backend)

The canvas/drawer supports nested-block editing (`versioning {}`, `ingress {}`, …). The shipped `write_draft` calls `_render_resource_block(req.type, req.name, authored, {})` — it drops blocks. Route the canvas through the draft path **without** regressing block authoring by adding `blocks` to `DraftRequest`.

**Files:**
- Modify: `app/backend/src/devex_app/routes/blueprint.py` (`DraftRequest` ~936-950; `write_draft` ~997-1011)
- Test: `app/backend/tests/test_draft_overlay.py` (extend)

- [ ] **Step 1: Write the failing test**

```python
# append to app/backend/tests/test_draft_overlay.py
def test_new_draft_renders_nested_blocks(client, blueprint_env):
    res = client.post("/api/blueprint/draft", json={
        "kind": "new", "type": "aws_s3_bucket", "name": "logs",
        "attributes": {"bucket": "my-logs"},
        "blocks": {"versioning": [{"attributes": {"enabled": True}, "blocks": {}}]},
        **COORDS,
    })
    assert res.status_code == 200, res.text
    body = (_leaf(blueprint_env) / "aws_s3_bucket.logs.tf").read_text()
    assert "versioning {" in body and "enabled = true" in body
```

(Uses the `COORDS`/`_leaf` helpers already at the top of `test_draft_overlay.py`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/backend && uv run pytest tests/test_draft_overlay.py -k nested_blocks -v`
Expected: FAIL — `blocks` is ignored (no `versioning {` in the file); or 422 if validation rejects the unknown field.

- [ ] **Step 3: Write minimal implementation**

In `DraftRequest` (the class near line 936), add a `blocks` field alongside `attributes` (the `BlockInstance` model already exists at ~line 258):

```python
    attributes: dict[str, Any] = Field(default_factory=dict)
    blocks: dict[str, list[BlockInstance]] = Field(default_factory=dict)
```

In `write_draft` (near line 997-1008), pass the blocks into the renderer:

```python
    else:
        read_only = _read_only_attr_names(req.type)
        authored = {k: v for k, v in req.attributes.items() if k not in read_only}
        resource_hcl = _render_resource_block(req.type, req.name, authored, req.blocks)
        if req.kind == "adopt" and req.import_id:
            hcl = (
                _render_import_block(req.type, req.name, req.import_id)
                + "\n"
                + resource_hcl
            )
        else:
            hcl = resource_hcl
        tmp = res_path.with_suffix(".tf.tmp")
        tmp.write_text(hcl, encoding="utf-8")
        tmp.replace(res_path)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/backend && uv run pytest tests/test_draft_overlay.py -v`
Expected: PASS (all overlay tests).

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/routes/blueprint.py app/backend/tests/test_draft_overlay.py
git commit -m "feat(app): draft writer renders nested blocks"
```

---

## Task 3: `plan-diff` gains an owner-scoped `leaf=` selector (backend)

A staged overlay leaf is a valid root module, so `tofu plan` of `drafts/<owner>/<leaf>` previews exactly that one leaf.

**Files:**
- Modify: `app/backend/src/devex_app/routes/plan.py`
- Test: `app/backend/tests/test_plan_diff_leaf.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# app/backend/tests/test_plan_diff_leaf.py
from __future__ import annotations

import devex_app.routes.plan as plan_mod


def test_plan_diff_leaf_targets_the_staged_leaf(client, blueprint_env, monkeypatch):
    # Author a leaf so the overlay dir exists.
    client.post("/api/blueprint/draft", json={
        "kind": "new", "type": "aws_vpc", "name": "main",
        "attributes": {"cidr_block": "10.0.0.0/16"},
        "account": "billing-prod-account", "region": "us-east-1",
        "layer": "infra", "component": "net",
    })

    captured = {}

    def fake_plan_diff(root):
        captured["root"] = str(root)
        return {"format_version": "1.0", "resource_changes": []}

    monkeypatch.setattr(plan_mod, "plan_diff", fake_plan_diff)

    res = client.get(
        "/api/plan-diff",
        params={"root": "blueprint",
                "leaf": "billing-prod-account/us-east-1/infra/net"},
    )
    assert res.status_code == 200, res.text
    assert captured["root"].endswith(
        "drafts/local/billing-prod-account/us-east-1/infra/net"
    )


def test_plan_diff_leaf_rejects_unsafe_relpath(client, blueprint_env):
    res = client.get("/api/plan-diff",
                     params={"root": "blueprint", "leaf": "../../etc"})
    assert res.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/backend && uv run pytest tests/test_plan_diff_leaf.py -v`
Expected: FAIL — `leaf` is an unknown query param (ignored), so `root` is the whole blueprint root, not the leaf; second test gets 200/500 not 400.

- [ ] **Step 3: Write minimal implementation**

In `app/backend/src/devex_app/routes/plan.py`, import the deps and resolve a leaf when supplied:

```python
# add to imports at top
from fastapi import APIRouter, Depends, HTTPException, Query
from .. import leaves
from ._deps import resolve_owner
```

Replace the `plan_diff_route` signature + the root-resolution block:

```python
@router.get("/plan-diff")
def plan_diff_route(
    root: str = Query(default="default", description="..."),
    leaf: str | None = Query(
        default=None,
        description=(
            "Optional <account>/<region>/<layer>/<component> relpath. When set"
            " with root=blueprint, plans that single staged overlay leaf under"
            " drafts/<owner>/."
        ),
    ),
    owner: str = Depends(resolve_owner),
) -> dict[str, Any]:
    settings = get_settings()
    if root == "blueprint":
        if leaf:
            parts = leaf.split("/")
            if len(parts) != 4:
                raise HTTPException(
                    status_code=400,
                    detail="leaf must be account/region/layer/component.",
                )
            try:
                target_root = leaves.leaf_dir(
                    settings.blueprint_root, owner, *parts
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            if not target_root.is_dir():
                raise HTTPException(
                    status_code=404, detail=f"No staged leaf {leaf!r}."
                )
        else:
            target_root = settings.blueprint_root
    elif root == "default":
        target_root = settings.tofu_root
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown plan root {root!r}. Use 'default' or 'blueprint'.",
        )
```

(Keep the existing `description=...` text on the `root` param and the rest of the function — `plan_diff(target_root)`, `changes_from_plan`, the response dict — unchanged. `leaf_dir` validates each coord via the same `validate_coord` regex, which rejects `..`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/backend && uv run pytest tests/test_plan_diff_leaf.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/routes/plan.py app/backend/tests/test_plan_diff_leaf.py
git commit -m "feat(app): plan-diff supports per-leaf preview"
```

---

## Task 4: Remove the dead flat endpoints (backend)

The overlay model killed the flat root. `PATCH /blueprint/layout` (writes `_layout.json` at the dead flat root) and `DELETE /blueprint/resource/{type}/{name}` (deletes `bp.<type>.<name>.tf` at the dead flat root) no longer do anything useful. Remove them so the frontend can't depend on them.

**Files:**
- Modify: `app/backend/src/devex_app/routes/blueprint.py` (delete `patch_layout` + `LayoutPatchRequest` ~667-700; delete `delete_resource` ~1086-end)
- Test: `app/backend/tests/test_flat_endpoints_removed.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# app/backend/tests/test_flat_endpoints_removed.py
def test_flat_layout_patch_is_gone(client, blueprint_env):
    res = client.patch("/api/blueprint/layout", json={"positions": {}})
    assert res.status_code in (404, 405)


def test_flat_resource_delete_is_gone(client, blueprint_env):
    res = client.request(
        "DELETE", "/api/blueprint/resource/aws_vpc/main", json={}
    )
    assert res.status_code in (404, 405)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/backend && uv run pytest tests/test_flat_endpoints_removed.py -v`
Expected: FAIL — both endpoints still respond 200.

- [ ] **Step 3: Write minimal implementation**

In `app/backend/src/devex_app/routes/blueprint.py`:
- Delete the `@router.patch("/blueprint/layout")` handler `patch_layout` and the `LayoutPatchRequest` model (~667-700).
- Delete the `@router.delete("/blueprint/resource/{type_}/{name}")` handler `delete_resource` (~1086 to end of function) and its section comment banner.

Then run grep to remove anything left dangling:

```bash
cd app/backend && grep -rn "patch_layout\|LayoutPatchRequest\|delete_resource\|_update_layout\|_merge_layout\|ResourceWriteRequest\|_layout.json\|_migrate_legacy_resources" src/devex_app
```

For each hit that is now unreferenced (`_update_layout`, `_merge_layout`, `ResourceWriteRequest`, `_migrate_legacy_resources`, the `_layout.json` plumbing): delete it. **Keep** `BlockInstance` (used by `DraftRequest` after Task 2), `_render_resource_block`, `_render_import_block`, `_render_block_body`, `_parse_resource_file`, `_read_only_attr_names`, `_split_attrs_and_blocks` — those are still on live paths. If `_split_filename` is only used by the deleted `delete_resource`/legacy-migration, delete it too.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/backend && uv run pytest tests/test_flat_endpoints_removed.py -v && uv run pytest -q && uv run ruff check src/devex_app`
Expected: new tests PASS; full suite PASS (fix any test that referenced the removed handlers); ruff clean (no unused imports/symbols left behind).

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/routes/blueprint.py app/backend/tests/test_flat_endpoints_removed.py
git commit -m "feat(app): remove dead flat layout/delete endpoints"
```

---

## Task 5: Frontend shared types (`lib/types.ts`)

Add the leaf-coords vocabulary and align the draft/inventory/blueprint shapes with the 2a backend.

**Files:**
- Modify: `app/frontend/lib/types.ts`

- [ ] **Step 1: Add `LeafCoords` and extend the relevant types**

Add near the top of the file (after the `Resource` type):

```typescript
/** The four-level path that identifies a devex-live leaf. Every authoring
 *  action targets one leaf. Each coord must match the backend's rule:
 *  lowercase letters/digits/hyphen, 1-64 chars (see COORD_RE in lib/api.ts). */
export type LeafCoords = {
  account: string;
  region: string;
  layer: string;
  component: string;
};
```

Replace the existing `DraftRequest` type with the coord-bearing shape:

```typescript
export type DraftRequest = {
  kind: "new" | "adopt" | "edit" | "delete";
  type: string;
  name: string;
  account: string;
  region: string;
  layer: string;
  component: string;
  source_address?: string | null;
  import_id?: string | null;
  attributes?: Record<string, unknown>;
  blocks?: Record<string, BlueprintBlockInstance[]>;
};
```

Replace the existing `Draft` type (the pending-bar shape; the backend now returns coords + leaf per entry):

```typescript
export type Draft = {
  address: string;
  kind: "new" | "adopt" | "edit" | "delete";
  owner?: string;
  leaf?: string;
  account?: string;
  region?: string;
  layer?: string;
  component?: string | null;
  source_address?: string | null;
};
```

Add `layer` to `InventoryResource` (after the `region` field):

```typescript
  account: string;
  region: string;
  layer: string;
```

Add `leaf` to `BlueprintResource` and make `position` optional (the overlay `list_resources` no longer returns positions):

```typescript
  /** account/region/layer/component relpath of the overlay leaf this
   *  resource lives in. */
  leaf?: string;
  position?: { x: number; y: number };
  filename: string;
```

Add a promote response type (near `DraftsResponse`):

```typescript
export type PromoteResponse = {
  owner: string;
  leaves: string[];
  pr_url: string;
  branch: string;
};
```

- [ ] **Step 2: Verify type-check (will surface every call site that must change)**

Run: `cd app/frontend && npx tsc --noEmit`
Expected: errors in `api.ts`, `QuickCreate.tsx`, `ResourceInspector.tsx`, `BlueprintNodeDrawer.tsx`, `BlueprintCanvas.tsx`, `ResourceTree.tsx` (missing coords / removed fields). **This is the to-do list for Tasks 6-13.** Don't fix them here.

- [ ] **Step 3: Commit**

```bash
git add app/frontend/lib/types.ts
git commit -m "feat(ui): leaf-coords types for the draft overlay"
```

---

## Task 6: Frontend API client (`lib/api.ts`)

Coords on discard, a `promoteDrafts` call, a `leaf` param on plan-diff, and removal of the three flat wrappers.

**Files:**
- Modify: `app/frontend/lib/api.ts`

- [ ] **Step 1: Add the shared coord regex + update `fetchPlanDiff`**

Add near the top (after the imports):

```typescript
/** Mirrors the backend `_COORD_RE` in leaves.py. Each leaf coord segment
 *  must satisfy this before we send a draft, so the user gets an inline
 *  error instead of a 400. */
export const COORD_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
```

Update `PlanRoot` import usage stays; change `fetchPlanDiff` to accept an optional `leaf`:

```typescript
export async function fetchPlanDiff(
  signal?: AbortSignal,
  root: PlanRoot = "default",
  leaf?: string,
): Promise<PlanDiffResponse> {
  let qs = `?root=${encodeURIComponent(root)}`;
  if (leaf) qs += `&leaf=${encodeURIComponent(leaf)}`;
  const res = await fetch(`/api/plan-diff${qs}`, { cache: "no-store", signal });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/plan-diff failed (${res.status}): ${text}`);
  }
  return res.json();
}
```

- [ ] **Step 2: Update `writeDraft` return type, replace `discardDraft`, add `promoteDrafts`**

`writeDraft`'s body already forwards the whole `DraftRequest` (which now carries coords) — only the import type changed, no code change needed there. Add `LeafCoords` and `PromoteResponse` to the type import at the top of the file.

Replace `discardDraft` (it must now send coords in the DELETE body, matching `DiscardDraftRequest`):

```typescript
/** Discard a draft. The backend needs the leaf coords to find the file. */
export async function discardDraft(
  type: string,
  name: string,
  coords: LeafCoords,
  signal?: AbortSignal,
): Promise<{ discarded: boolean }> {
  const res = await fetch(
    `/api/blueprint/draft/${encodeURIComponent(type)}/${encodeURIComponent(name)}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(coords),
      signal,
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`discard draft failed (${res.status}): ${text}`);
  }
  return res.json();
}

/** Deterministically promote the owner's overlay into devex-live and open a
 *  PR. No agent. Returns the PR URL. */
export async function promoteDrafts(
  signal?: AbortSignal,
): Promise<PromoteResponse> {
  const res = await fetch("/api/blueprint/promote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/blueprint/promote failed (${res.status}): ${text}`);
  }
  return res.json();
}
```

- [ ] **Step 3: Delete the three dead flat wrappers**

Remove `patchBlueprintLayout` (~73-90), `deleteBlueprintResource` (~92-114), and `writeBlueprintResource` (~116-145) entirely. `generateBlueprintConfig`, `fetchBlueprintResources`, `writeDraft`, `fetchDrafts` stay.

- [ ] **Step 4: Verify**

Run: `cd app/frontend && npx tsc --noEmit`
Expected: errors now only in component files that import the removed wrappers (`BlueprintCanvas.tsx`, `BlueprintNodeDrawer.tsx`) and that call `discardDraft` with the old 2-arg shape (`ResourceInspector.tsx`). Those are fixed in later tasks.

- [ ] **Step 5: Commit**

```bash
git add app/frontend/lib/api.ts
git commit -m "feat(ui): api client — coords on discard, promoteDrafts, per-leaf plan, drop flat wrappers"
```

---

## Task 7: `LeafForm` component (the "+ new leaf" form)

A small form in the inspector pane: four coord inputs, each validated against `COORD_RE`. On submit it hands the coords back to the parent (which sets the active leaf + opens QuickCreate).

**Files:**
- Create: `app/frontend/components/LeafForm.tsx`

- [ ] **Step 1: Write the component**

```typescript
// app/frontend/components/LeafForm.tsx
"use client";

import { useState } from "react";

import { COORD_RE } from "@/lib/api";
import type { LeafCoords } from "@/lib/types";

const FIELDS: { key: keyof LeafCoords; label: string; placeholder: string }[] = [
  { key: "account", label: "account", placeholder: "billing-prod-account" },
  { key: "region", label: "region", placeholder: "us-east-1" },
  { key: "layer", label: "layer", placeholder: "infra" },
  { key: "component", label: "component", placeholder: "net" },
];

/**
 * "New leaf" form. Collects the four devex-live coords, validates each to
 * the backend's lowercase/digit/hyphen rule, and hands them up. The parent
 * sets these as the active authoring leaf and opens QuickCreate for them.
 */
export function LeafForm({
  onCreate,
  onCancel,
  initial,
}: {
  onCreate: (coords: LeafCoords) => void;
  onCancel: () => void;
  initial?: Partial<LeafCoords>;
}) {
  const [coords, setCoords] = useState<LeafCoords>({
    account: initial?.account ?? "",
    region: initial?.region ?? "",
    layer: initial?.layer ?? "",
    component: initial?.component ?? "",
  });

  const allValid = FIELDS.every(({ key }) => COORD_RE.test(coords[key]));
  const set = (key: keyof LeafCoords, v: string) =>
    setCoords((prev) => ({ ...prev, [key]: v }));

  return (
    <div className="flex flex-col h-full min-h-0 bg-background">
      <div className="shrink-0 border-b border-border px-3 pt-3 pb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            New leaf
          </div>
          <div className="font-mono text-xs text-muted-foreground break-all">
            account / region / layer / component
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 h-6 px-2 inline-flex items-center justify-center text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted rounded-sm transition-colors"
        >
          cancel
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-3 text-xs">
        {FIELDS.map(({ key, label, placeholder }) => {
          const val = coords[key];
          const bad = val.length > 0 && !COORD_RE.test(val);
          return (
            <div key={key}>
              <label className="text-[10px] uppercase tracking-wide text-foreground font-mono">
                {label}
              </label>
              <input
                className="mt-1 w-full text-xs font-mono rounded-sm border border-border bg-background px-2 py-1 outline-none focus:border-accent"
                value={val}
                placeholder={placeholder}
                onChange={(e) => set(key, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && allValid) onCreate(coords);
                }}
              />
              {bad && (
                <p className="mt-0.5 text-[10px] text-red-600 dark:text-red-400">
                  lowercase letters, digits, hyphen; no spaces or dots.
                </p>
              )}
            </div>
          );
        })}
        <p className="text-[10px] text-muted-foreground">
          Creates a staged leaf shaped like a devex-live stack. The next
          resource you add lands here.
        </p>
      </div>

      <div className="shrink-0 border-t border-border px-3 py-2.5 bg-muted/40">
        <button
          type="button"
          onClick={() => onCreate(coords)}
          disabled={!allValid}
          className="w-full inline-flex items-center justify-center h-8 px-3 bg-accent hover:opacity-90 text-white text-xs font-medium rounded-sm transition-colors disabled:opacity-50"
        >
          Use this leaf
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run: `cd app/frontend && npx tsc --noEmit`
Expected: no new errors from this file (it's not wired in yet).

- [ ] **Step 3: Commit**

```bash
git add app/frontend/components/LeafForm.tsx
git commit -m "feat(ui): LeafForm — pick the four devex-live coords"
```

---

## Task 8: `page.tsx` — active-leaf state, promote handler, delete dead prompts

This is the orchestration hub. Introduce `activeLeaf`, switch `creating` to carry coords, render `LeafForm`, wire the deterministic promote, and delete the four agent-prompt constants.

**Files:**
- Modify: `app/frontend/app/page.tsx`

- [ ] **Step 1: Delete the dead prompt constants**

Remove all of these (they're superseded by deterministic promote + leaf authoring):
- The **two** `const BLUEPRINT_COMMIT_PROMPT = ...` declarations (~36-59 and ~118-139 — note: there are duplicates today).
- `function commitDraftsPrompt()` (~94-111).
- `function addToComponentPrompt()` (~81-89).

**Keep** `discoveryPrompt()` (~64-76) — discovery is a separate, still-valid agent flow.

- [ ] **Step 2: Update imports + state**

Change the api import to drop `deleteBlueprintResource` and add `promoteDrafts`/`discardDraft`:

```typescript
import {
  discardDraft,
  fetchPlanDiff,
  promoteDrafts,
  setComponentOverride,
  type PlanRoot,
} from "@/lib/api";
import type {
  InventoryResource,
  LeafCoords,
  PlanDiffResponse,
  Resource,
  ResourceChange,
} from "@/lib/types";
import { LeafForm } from "@/components/LeafForm";
```

Replace the `creating` state and add `activeLeaf` + `creatingLeaf` + a promote-result slot. Change:

```typescript
  const [creating, setCreating] = useState<{ component: string } | null>(null);
```

to:

```typescript
  // The leaf every author surface (canvas drop, adopt, quick-create) targets.
  const [activeLeaf, setActiveLeaf] = useState<LeafCoords | null>(null);
  // When set, region 4 shows QuickCreate for these coords.
  const [creating, setCreating] = useState<LeafCoords | null>(null);
  // When true, region 4 shows the LeafForm.
  const [creatingLeaf, setCreatingLeaf] = useState(false);
  // Last promote result (PR URL) surfaced by the pending bar.
  const [promoteResult, setPromoteResult] = useState<
    { url: string } | { error: string } | null
  >(null);
```

Delete the `pendingPrompt` state's commit usages but keep `pendingPrompt` itself (discovery still uses it). Delete `handleCommitToPR` (it seeded the agent prompt). Add a deterministic promote handler:

```typescript
  const handlePromote = useCallback(async () => {
    setPromoteResult(null);
    try {
      const res = await promoteDrafts();
      setPromoteResult({ url: res.pr_url });
      setRefreshKey((k) => k + 1);
      setBlueprintReload((k) => k + 1);
    } catch (e) {
      setPromoteResult({ error: (e as Error).message });
    }
  }, []);
```

- [ ] **Step 3: Replace the canvas delete to use the draft path**

The old `handleBlueprintDelete` called `deleteBlueprintResource`. A canvas node now belongs to a leaf, so delete = discard the draft. Replace it:

```typescript
  const handleBlueprintDelete = useCallback(
    async (node: BlueprintNode) => {
      const coords = node.data.leaf ? leafToCoords(node.data.leaf) : null;
      // Only saved nodes (server-id format) have a leaf to discard from.
      if (coords) {
        await discardDraft(node.data.resourceType, node.data.name, coords);
      }
      setBlueprintNode((prev) => (prev && prev.id === node.id ? null : prev));
      setBlueprintReload((k) => k + 1);
      setRefreshKey((k) => k + 1);
    },
    [],
  );
```

Add a small helper near the top of the file (module scope, after the imports):

```typescript
// "a/r/l/c" -> LeafCoords. Returns null if the relpath isn't 4 segments.
function leafToCoords(leaf: string): LeafCoords | null {
  const [account, region, layer, component] = leaf.split("/");
  if (!account || !region || !layer || !component) return null;
  return { account, region, layer, component };
}
```

(`BlueprintNodeData` gains a `leaf` field in Task 13; the type-check will be green once that lands. If executing strictly in order, this line will error until Task 13 — that's expected; the build gate runs at Task 16. To keep each task green, you may do Task 13 immediately after this one.)

- [ ] **Step 4: Wire the navigator + region 4**

Update the `PendingChanges` usage (region 2) to call the deterministic promote and show the result:

```tsx
        <PendingChanges
          refreshKey={refreshKey}
          onPromote={handlePromote}
          result={promoteResult}
          onDismissResult={() => setPromoteResult(null)}
        />
```

Update the `ResourceTree` usage: leaf selection sets the active leaf; "+add" opens QuickCreate for a leaf; add the "+ new leaf" entry point:

```tsx
        <ResourceTree
          selected={selected}
          onSelect={(item) => {
            setSelectedItem(item);
            setSelected(inventoryToResource(item));
            setBlueprintNode(null);
            setCreating(null);
            setCreatingLeaf(false);
          }}
          onSelectLeaf={(coords) => setActiveLeaf(coords)}
          onAddToLeaf={(coords) => {
            setActiveLeaf(coords);
            setCreating(coords);
            setCreatingLeaf(false);
          }}
          onNewLeaf={() => {
            setCreatingLeaf(true);
            setCreating(null);
          }}
          onDiscover={(scope) => setPendingPrompt(discoveryPrompt(scope))}
          refreshKey={refreshKey}
        />
```

Update the canvas usage: pass `activeLeaf`, replace `onCommitToPR` with the promote handler, drop nothing else:

```tsx
          <BlueprintCanvas
            selectedNodeId={blueprintNode?.id ?? null}
            onSelectNode={setBlueprintNode}
            renameEvent={blueprintRename}
            onRenameConsumed={() => setBlueprintRename(null)}
            reloadKey={blueprintReload}
            onCanvasNodeDelete={handleBlueprintDelete}
            panToAddress={blueprintPanTo}
            onPanConsumed={() => setBlueprintPanTo(null)}
            activeLeaf={activeLeaf}
            onPromote={handlePromote}
            onAdopted={() => {
              setBlueprintReload((k) => k + 1);
              setRefreshKey((k) => k + 1);
            }}
          />
```

Replace the region-4 ladder so LeafForm and the coord-bearing QuickCreate render first:

```tsx
      {/* Region 4 — Inspector */}
      <aside className="w-[380px] shrink-0 border-l border-border flex flex-col min-h-0">
        {creatingLeaf ? (
          <LeafForm
            onCreate={(coords) => {
              setActiveLeaf(coords);
              setCreating(coords);
              setCreatingLeaf(false);
            }}
            onCancel={() => setCreatingLeaf(false)}
          />
        ) : creating ? (
          <QuickCreate
            coords={creating}
            onCreated={(c) => {
              setCreating(null);
              setRefreshKey((k) => k + 1);
              const item: InventoryResource = {
                address: `${c.type}.${c.name}`,
                type: c.type,
                name: c.name,
                id: null,
                arn: null,
                account: creating.account,
                region: creating.region,
                layer: creating.layer,
                managed: false,
                state: "planned",
                component: creating.component,
                component_source: "leaf",
                draft_kind: "new",
                tags: {},
                values: {},
              };
              setSelectedItem(item);
              setSelected(inventoryToResource(item));
              setBlueprintNode(null);
            }}
            onCancel={() => setCreating(null)}
          />
        ) : blueprintNode ? (
          <BlueprintNodeDrawer
            node={blueprintNode}
            activeLeaf={activeLeaf}
            onClose={() => setBlueprintNode(null)}
            onRename={(nodeId, newName) => {
              setBlueprintRename({ nodeId, newName });
              setBlueprintNode((prev) =>
                prev && prev.id === nodeId
                  ? { ...prev, data: { ...prev.data, name: newName } }
                  : prev,
              );
            }}
            onResourceWritten={() => {
              setBlueprintReload((k) => k + 1);
              setRefreshKey((k) => k + 1);
            }}
            onResourceDeleted={(nodeId) => {
              setBlueprintNode((prev) =>
                prev && prev.id === nodeId ? null : prev,
              );
              setBlueprintReload((k) => k + 1);
              setRefreshKey((k) => k + 1);
            }}
            onNavigateToRef={setBlueprintPanTo}
          />
        ) : selectedItem ? (
          <ResourceInspector
            item={selectedItem}
            change={selectedChange}
            activeLeaf={activeLeaf}
            onClose={() => {
              setSelected(null);
              setSelectedItem(null);
            }}
            onOpenInPlanDiff={openInPlanDiff}
            onReassign={handleReassign}
            onChanged={() => setRefreshKey((k) => k + 1)}
          />
        ) : (
          <ResourceDrawer resource={null} onClose={() => setSelected(null)} />
        )}
      </aside>
```

Update the `QuickCreate` onCreated callback signature usage — note it now passes a component string via `c.component`; QuickCreate (Task 10) is changed to call `onCreated({ type, name, component })` where `component = coords.component`.

Also update the Plan tab usage to pass leaf state (added in Task 15) — leave the `PlanDiff` props as-is for now; Task 15 adds `leaf`/`onLeafChange`/`leaves`.

- [ ] **Step 5: Verify (interim)**

Run: `cd app/frontend && npx tsc --noEmit`
Expected: errors only in the not-yet-updated child components (`ResourceTree`, `QuickCreate`, `ResourceInspector`, `BlueprintNodeDrawer`, `BlueprintCanvas`, `PendingChanges`) whose prop contracts just changed. These are Tasks 9-14.

- [ ] **Step 6: Commit**

```bash
git add app/frontend/app/page.tsx
git commit -m "feat(ui): active-leaf state, deterministic promote, drop agent commit prompts"
```

---

## Task 9: `ResourceTree.tsx` — add the Layer level + leaf selection

Insert a Layer level between Region and Component (Account→Region→Layer→Component→type→resource), make a leaf (component) node selectable and "+add"-able with its full coords, and add a "+ new leaf" header button.

**Files:**
- Modify: `app/frontend/components/ResourceTree.tsx`

- [ ] **Step 1: Update the grouping types + function for the Layer level**

Replace the group type aliases (~12-15) and `groupInventory` (~33-55):

```typescript
type TypeGroup = { type: string; resources: InventoryResource[] };
type ComponentGroup = { component: string; types: TypeGroup[] };
type LayerGroup = { layer: string; components: ComponentGroup[] };
type RegionGroup = { region: string; layers: LayerGroup[] };
type AccountGroup = { account: string; regions: RegionGroup[] };

function groupInventory(items: InventoryResource[]): AccountGroup[] {
  const accounts: AccountGroup[] = [];
  const byAccount = groupBy(items, (r) => r.account);
  for (const account of sortKeys([...byAccount.keys()])) {
    const regions: RegionGroup[] = [];
    const byRegion = groupBy(byAccount.get(account)!, (r) => r.region);
    for (const region of sortKeys([...byRegion.keys()])) {
      const layers: LayerGroup[] = [];
      const byLayer = groupBy(byRegion.get(region)!, (r) => r.layer || "unassigned");
      for (const layer of sortKeys([...byLayer.keys()])) {
        const components: ComponentGroup[] = [];
        const byComp = groupBy(byLayer.get(layer)!, (r) => r.component);
        for (const component of sortKeys([...byComp.keys()])) {
          const types: TypeGroup[] = [];
          const byType = groupBy(byComp.get(component)!, (r) => r.type);
          for (const type of [...byType.keys()].sort()) {
            types.push({ type, resources: byType.get(type)! });
          }
          components.push({ component, types });
        }
        layers.push({ layer, components });
      }
      regions.push({ region, layers });
    }
    accounts.push({ account, regions });
  }
  return accounts;
}
```

Update `sortKeys` to push the unassigned bucket last case-insensitively:

```typescript
function sortKeys(keys: string[]): string[] {
  const isUnassigned = (k: string) => k.toLowerCase() === "unassigned";
  return keys.sort((a, b) =>
    isUnassigned(a) ? 1 : isUnassigned(b) ? -1 : a.localeCompare(b),
  );
}
```

- [ ] **Step 2: Add the new props + a coords helper**

Add to the `ResourceTree` props (replace `onAddToComponent`):

```typescript
export function ResourceTree({
  selected,
  onSelect,
  onSelectLeaf,
  onAddToLeaf,
  onNewLeaf,
  onDiscover,
  refreshKey,
}: {
  selected: Resource | null;
  onSelect: (item: InventoryResource) => void;
  /** Fired when a leaf (component) node is opened — sets the authoring target. */
  onSelectLeaf?: (coords: LeafCoords) => void;
  /** Fired by a leaf node's "+add" — opens QuickCreate for these coords. */
  onAddToLeaf?: (coords: LeafCoords) => void;
  /** Fired by the "+ new leaf" header button. */
  onNewLeaf?: () => void;
  onDiscover?: (scope: string) => void;
  refreshKey?: number;
}) {
```

Add to the imports: `import { COORD_RE } from "@/lib/api";` and `import type { InventoryResource, LeafCoords, Resource } from "@/lib/types";`.

A leaf is authorable only when all four coords are valid (real managed/unmanaged buckets sit under `unassigned` layer / `Unassigned` component and fail this — their "+add" is hidden). Add a module-scope helper:

```typescript
function authorableLeaf(
  account: string,
  region: string,
  layer: string,
  component: string,
): LeafCoords | null {
  const coords = { account, region, layer, component };
  return Object.values(coords).every((c) => COORD_RE.test(c)) ? coords : null;
}
```

- [ ] **Step 3: Add the "+ new leaf" header button**

In the header row (the `<div>` with the "discover"/"refresh" buttons, ~130-149), add a button before "discover":

```tsx
        <div className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
          {onNewLeaf && (
            <button
              type="button"
              className="px-1.5 h-5 rounded-sm hover:bg-muted text-emerald-700 dark:text-emerald-400"
              title="Create a new leaf (account/region/layer/component) to author into"
              onClick={onNewLeaf}
            >
              ＋ leaf
            </button>
          )}
          {onDiscover && (
            <button
              type="button"
              className="px-1.5 h-5 rounded-sm hover:bg-muted"
              title="Ask the agent to discover unmanaged AWS resources"
              onClick={() => onDiscover("all")}
            >
              discover
            </button>
          )}
          <button
            type="button"
            className="px-1.5 h-5 rounded-sm hover:bg-muted"
            onClick={() => load()}
            disabled={loading}
          >
            refresh
          </button>
        </div>
```

- [ ] **Step 4: Render the Layer level + leaf actions in the tree body**

Replace the tree-render block (the `tree.map((acct) => ...)` JSX, ~158-224) with the four-level version. The component (leaf) branch now: (a) calls `onSelectLeaf` when toggled open if authorable, and (b) shows a "+add" action when authorable:

```tsx
        {tree.map((acct) => (
          <TreeBranch
            key={acct.account}
            id={`a:${acct.account}`}
            label={acct.account}
            kind="account"
            collapsed={collapsed}
            onToggle={toggle}
          >
            {acct.regions.map((reg) => (
              <TreeBranch
                key={reg.region}
                id={`a:${acct.account}/r:${reg.region}`}
                label={reg.region}
                kind="region"
                collapsed={collapsed}
                onToggle={toggle}
              >
                {reg.layers.map((lay) => (
                  <TreeBranch
                    key={lay.layer}
                    id={`${acct.account}/${reg.region}/l:${lay.layer}`}
                    label={lay.layer}
                    kind="layer"
                    collapsed={collapsed}
                    onToggle={toggle}
                  >
                    {lay.components.map((comp) => {
                      const coords = authorableLeaf(
                        acct.account, reg.region, lay.layer, comp.component,
                      );
                      return (
                        <TreeBranch
                          key={comp.component}
                          id={`${acct.account}/${reg.region}/${lay.layer}/c:${comp.component}`}
                          label={comp.component}
                          kind="component"
                          collapsed={collapsed}
                          onToggle={toggle}
                          onOpen={
                            coords && onSelectLeaf
                              ? () => onSelectLeaf(coords)
                              : undefined
                          }
                          action={
                            coords && onAddToLeaf ? (
                              <button
                                type="button"
                                title={`Add a resource to ${comp.component}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onAddToLeaf(coords);
                                }}
                                className="shrink-0 px-1.5 h-5 text-[11px] font-mono text-emerald-700 dark:text-emerald-400 hover:bg-muted rounded-sm"
                              >
                                ＋
                              </button>
                            ) : null
                          }
                        >
                          {comp.types.map((tg) => (
                            <TreeBranch
                              key={tg.type}
                              id={`${acct.account}/${reg.region}/${lay.layer}/${comp.component}/t:${tg.type}`}
                              label={`${tg.type} (${tg.resources.length})`}
                              kind="type"
                              collapsed={collapsed}
                              onToggle={toggle}
                            >
                              {tg.resources.map((r) => (
                                <ResourceRow
                                  key={r.address}
                                  item={r}
                                  selected={selected?.address === r.address}
                                  onSelect={() => onSelect(r)}
                                />
                              ))}
                            </TreeBranch>
                          ))}
                        </TreeBranch>
                      );
                    })}
                  </TreeBranch>
                ))}
              </TreeBranch>
            ))}
          </TreeBranch>
        ))}
```

- [ ] **Step 5: Update `TreeBranch` for the new `layer` kind + `onOpen`**

Replace the `TreeBranch` signature, the `kind` union, the `indent` map, and the toggle handler so opening a leaf also fires `onOpen`:

```typescript
function TreeBranch({
  id,
  label,
  kind,
  collapsed,
  onToggle,
  onOpen,
  action,
  children,
}: {
  id: string;
  label: string;
  kind: "account" | "region" | "layer" | "component" | "type";
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  /** Called when this branch is opened (expanded). Used by leaf nodes to
   *  set the active authoring leaf. */
  onOpen?: () => void;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const isCollapsed = collapsed.has(id);
  const indent = { account: 0, region: 12, layer: 24, component: 36, type: 48 }[kind];
  return (
    <div>
      <div className="w-full flex items-center pr-2 border-b border-border hover:bg-muted">
        <button
          type="button"
          onClick={() => {
            if (isCollapsed && onOpen) onOpen();
            onToggle(id);
          }}
          style={{ paddingLeft: indent + 8 }}
          className="flex-1 min-w-0 flex items-center gap-1.5 h-6 text-left font-mono"
        >
          <span className={`transition-transform ${isCollapsed ? "" : "rotate-90"}`}>
            ›
          </span>
          <span className={`truncate ${kind === "component" ? "font-semibold" : ""}`}>
            {label}
          </span>
        </button>
        {action}
      </div>
      {!isCollapsed && children}
    </div>
  );
}
```

Update `ResourceRow`'s `paddingLeft` from `56` to `68` (one level deeper now).

- [ ] **Step 6: Verify**

Run: `cd app/frontend && npx tsc --noEmit && npm run lint`
Expected: no errors in `ResourceTree.tsx`. (`page.tsx` already passes the new props.)

- [ ] **Step 7: Commit**

```bash
git add app/frontend/components/ResourceTree.tsx
git commit -m "feat(ui): navigator Layer level + leaf select/add"
```

---

## Task 10: `QuickCreate.tsx` — author into leaf coords

The form now creates into a full leaf, not just a component.

**Files:**
- Modify: `app/frontend/components/QuickCreate.tsx`

- [ ] **Step 1: Rework the props + the create call**

Replace the props block + `create` (and drop the "ask the agent" escape hatch, which seeded a now-deleted prompt):

```typescript
import { useState } from "react";

import { writeDraft } from "@/lib/api";
import { PALETTE } from "@/lib/blueprintPalette";
import type { LeafCoords } from "@/lib/types";

const _NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function QuickCreate({
  coords,
  onCreated,
  onCancel,
}: {
  coords: LeafCoords;
  onCreated: (created: { type: string; name: string; component: string }) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState(PALETTE[0]?.type ?? "aws_s3_bucket");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const valid = _NAME_RE.test(name);

  const create = async () => {
    if (!valid) return;
    setBusy(true);
    setErr(null);
    try {
      await writeDraft({ kind: "new", type, name, ...coords });
      onCreated({ type, name, component: coords.component });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
```

- [ ] **Step 2: Update the header + helper text to show the leaf, drop the agent button**

In the header, replace the "Add to component" block's value (`{component}`) with the leaf relpath:

```tsx
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            Add to leaf
          </div>
          <div className="font-mono text-xs text-foreground break-all">
            {coords.account}/{coords.region}/{coords.layer}/{coords.component}
          </div>
```

Replace the helper `<p>` near the bottom of the body:

```tsx
        <p className="text-[10px] text-muted-foreground">
          Creates a draft in{" "}
          <span className="font-mono">{coords.layer}/{coords.component}</span>.
          Fill in its attributes in the inspector, then promote to a PR.
        </p>
```

Delete the "or ask the agent instead →" button in the footer (the `onAskAgent` block) and remove `onAskAgent` from the props.

- [ ] **Step 3: Verify**

Run: `cd app/frontend && npx tsc --noEmit`
Expected: no errors in `QuickCreate.tsx`.

- [ ] **Step 4: Commit**

```bash
git add app/frontend/components/QuickCreate.tsx
git commit -m "feat(ui): QuickCreate authors into a leaf"
```

---

## Task 11: `ResourceInspector.tsx` — coords on draft ops; park managed edit/delete; adopt needs a leaf

A draft row (state `planned`) carries its own coords, so edit/discard use them. An unmanaged row adopts into the **active leaf** (disabled if none chosen). A managed row with no draft has no leaf path → Edit/Delete are parked (hidden).

**Files:**
- Modify: `app/frontend/components/ResourceInspector.tsx`

- [ ] **Step 1: Add the `activeLeaf` prop + a coords resolver**

Add `activeLeaf` to imports/props:

```typescript
import type {
  InventoryResource, LeafCoords, Resource, ResourceSchema,
} from "@/lib/types";
```

```typescript
export function ResourceInspector({
  item,
  change,
  activeLeaf,
  onClose,
  onOpenInPlanDiff,
  onReassign,
  onChanged,
}: {
  item: InventoryResource;
  change?: ChangeSummary | null;
  /** The current authoring leaf. Adopt targets this; null disables adopt. */
  activeLeaf: LeafCoords | null;
  onClose: () => void;
  onOpenInPlanDiff?: (r: Resource) => void;
  onReassign?: (address: string, component: string) => Promise<void> | void;
  onChanged: () => void;
}) {
```

Add a memo that resolves the coords to use for a draft op:
- For a row that already has a draft (`planned`): the row's own coords.
- For an unmanaged adopt: the `activeLeaf`.

```typescript
  // A draft row carries its leaf coords; adopting an unmanaged row uses the
  // active leaf. Managed rows with no draft have no leaf → null (parked).
  const draftCoords: LeafCoords | null = useMemo(() => {
    if (item.draft_kind) {
      return {
        account: item.account,
        region: item.region,
        layer: item.layer,
        component: item.component,
      };
    }
    if (isUnmanaged) return activeLeaf;
    return null;
  }, [item, isUnmanaged, activeLeaf]);
```

(Place it after `isUnmanaged` is defined.)

- [ ] **Step 2: Pass coords through `save`, `discard`, `deleteResource`; gate on coords**

In `save` (~97-135), the draft op needs coords. Guard and spread:

```typescript
  const save = useCallback(async () => {
    if (!schema || !draftCoords) return;
    setSaveState({ status: "saving" });
    try {
      const editable = new Set(
        schema.attributes.filter((a) => !a.read_only).map((a) => a.name),
      );
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(attrs)) {
        if (!editable.has(k)) continue;
        if (v === undefined || v === null) continue;
        if (typeof v === "string" && v.trim() === "") continue;
        clean[k] = v;
      }
      const existing = item.draft_kind;
      const kind: "new" | "adopt" | "edit" =
        existing === "new" || existing === "adopt" || existing === "edit"
          ? existing
          : isUnmanaged
            ? "adopt"
            : "edit";
      await writeDraft({
        kind,
        type: item.type,
        name: item.name,
        source_address: item.address,
        import_id: kind === "adopt" ? (item.id ?? undefined) : undefined,
        attributes: clean,
        ...draftCoords,
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      setSaveState({ status: "error", message: (e as Error).message });
    }
  }, [schema, attrs, isUnmanaged, item, onChanged, draftCoords]);
```

Replace `discard` and `deleteResource` to pass coords (and only act when coords exist):

```typescript
  const discard = useCallback(async () => {
    try {
      if (item.draft_kind && draftCoords) {
        await discardDraft(item.type, item.name, draftCoords);
        onChanged();
      }
    } finally {
      setEditing(false);
    }
  }, [item, onChanged, draftCoords]);

  const hasDraft = !!item.draft_kind;
  // Park managed edit/delete (no leaf path). Draft rows can be discarded;
  // unmanaged rows can be adopted into the active leaf.
  const canDelete = hasDraft && !!draftCoords;
  const deleteResource = useCallback(async () => {
    if (hasDraft && draftCoords) {
      await discardDraft(item.type, item.name, draftCoords);
      onChanged();
    }
  }, [hasDraft, item, onChanged, draftCoords]);
```

(Note: this **removes** the old "managed → propose a `delete` draft" path, per the parking decision.)

- [ ] **Step 3: Gate the Edit/Adopt affordance in the view-mode drawer**

Edit/Adopt should be offered only when there's a leaf to write into. In the `if (!editing)` return, compute and pass an `onEdit` that's `undefined` when parked:

```tsx
  if (!editing) {
    // Managed rows with no draft are parked (no leaf path). Drafts edit in
    // place; unmanaged rows adopt into the active leaf (needs one selected).
    const canEdit = hasDraft || (isUnmanaged && !!activeLeaf);
    const editHint = isUnmanaged && !activeLeaf
      ? "Select or create a leaf first (tree → + leaf)"
      : undefined;
    return (
      <ResourceDrawer
        resource={resource}
        change={change}
        onClose={onClose}
        onOpenInPlanDiff={onOpenInPlanDiff}
        component={item.component}
        onReassign={onReassign}
        onEdit={canEdit ? enterEdit : undefined}
        editLabel={isUnmanaged ? "Adopt & edit" : "Edit"}
        editDisabledHint={editHint}
        onDelete={canDelete ? () => void deleteResource() : undefined}
        deleteLabel="Discard draft"
      />
    );
  }
```

If `ResourceDrawer` doesn't already accept `editDisabledHint`, either add a simple optional prop that renders a `title` on a disabled state, or drop `editDisabledHint` and instead rely on `onEdit` being undefined (the button hides). **Simplest: omit `editDisabledHint`** and just hide the button — check `ResourceDrawer`'s props before adding anything. Read `app/frontend/components/ResourceDrawer.tsx` first; if it has no hint mechanism, leave it out.

- [ ] **Step 4: Verify**

Run: `cd app/frontend && npx tsc --noEmit`
Expected: no errors in `ResourceInspector.tsx` (resolve any `ResourceDrawer` prop mismatch from Step 3).

- [ ] **Step 5: Commit**

```bash
git add app/frontend/components/ResourceInspector.tsx
git commit -m "feat(ui): inspector — coords on draft ops, adopt into active leaf, park managed edit/delete"
```

---

## Task 12: `BlueprintNodeDrawer.tsx` — save/delete via the draft path

The drawer is where canvas-dropped resources get saved. Route Save through `writeDraft` (with the node's leaf or the active leaf + blocks) and Delete through `discardDraft`.

**Files:**
- Modify: `app/frontend/components/BlueprintNodeDrawer.tsx`

- [ ] **Step 1: Swap imports + add `activeLeaf` prop**

```typescript
import {
  discardDraft,
  fetchExistingResources,
  fetchSchemas,
  generateBlueprintConfig,
  writeDraft,
} from "@/lib/api";
import type { BlueprintNode } from "@/components/BlueprintCanvas";
import { ResourceForm, type FormBlocks } from "@/components/ResourceForm";
import type { LeafCoords, ResourceSchema } from "@/lib/types";
```

Add `activeLeaf` to the props:

```typescript
export function BlueprintNodeDrawer({
  node,
  activeLeaf,
  onClose,
  onRename,
  onResourceWritten,
  onResourceDeleted,
  onNavigateToRef,
}: {
  node: BlueprintNode | null;
  /** Authoring leaf for a freshly-dropped node that has no leaf yet. */
  activeLeaf: LeafCoords | null;
  onClose: () => void;
  onRename?: (nodeId: string, newName: string) => void;
  onResourceWritten?: () => void;
  onResourceDeleted?: (nodeId: string) => void;
  onNavigateToRef?: (targetAddress: string) => void;
}) {
```

- [ ] **Step 2: Add a coords resolver helper (module scope)**

```typescript
// "a/r/l/c" -> LeafCoords or null.
function coordsFromLeaf(leaf?: string): LeafCoords | null {
  if (!leaf) return null;
  const [account, region, layer, component] = leaf.split("/");
  if (!account || !region || !layer || !component) return null;
  return { account, region, layer, component };
}
```

- [ ] **Step 3: Rework `handleSave`**

A saved node carries `node.data.leaf`; a fresh drop uses `activeLeaf`. Adopted nodes keep their `adopt` kind + import id; everything else is `new`/`edit`.

```typescript
  const handleSave = useCallback(async () => {
    if (!node || !formState || !schema) return;
    const coords = coordsFromLeaf(node.data.leaf) ?? activeLeaf;
    if (!coords) {
      setSaveState({
        status: "error",
        message: "Select or create a leaf first (tree → + leaf).",
      });
      return;
    }
    setSaveState({ status: "saving" });
    try {
      const editableNames = new Set(
        schema.attributes.filter((a) => !a.read_only).map((a) => a.name),
      );
      const cleanAttrs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(formState.attrs)) {
        if (!editableNames.has(k)) continue;
        if (v === undefined || v === null) continue;
        if (typeof v === "string" && v.trim() === "") continue;
        cleanAttrs[k] = v;
      }
      const adopted = Boolean(node.data.imported || node.data.importId);
      await writeDraft({
        kind: adopted ? "adopt" : "new",
        type: node.data.resourceType,
        name: formState.name,
        import_id: adopted ? (node.data.importId ?? undefined) : undefined,
        attributes: cleanAttrs,
        blocks: formState.blocks,
        ...coords,
      });
      setSaveState({ status: "saved", path: `${coords.layer}/${coords.component}` });
      if (onRename && formState.name !== node.data.name) {
        onRename(node.id, formState.name);
      }
      onResourceWritten?.();
    } catch (e) {
      setSaveState({ status: "error", message: (e as Error).message });
    }
  }, [node, formState, schema, onRename, onResourceWritten, activeLeaf]);
```

(The `SaveState` `saved` variant stores `path`; we reuse it for the leaf label. The "✓ wrote {path}" footer text still renders — optionally change it to "✓ saved to {path}".)

- [ ] **Step 4: Rework `handleDelete`**

```typescript
  const handleDelete = useCallback(async () => {
    if (!node) return;
    const coords = coordsFromLeaf(node.data.leaf);
    setSaveState({ status: "saving" });
    try {
      // Only a saved node (has a leaf) needs a backend discard; an unsaved
      // drop just leaves the canvas.
      if (coords) {
        await discardDraft(node.data.resourceType, node.data.name, coords);
      }
      setSaveState({ status: "idle" });
      onResourceDeleted?.(node.id);
    } catch (e) {
      setSaveState({ status: "error", message: (e as Error).message });
    }
  }, [node, onResourceDeleted]);
```

- [ ] **Step 5: Verify**

Run: `cd app/frontend && npx tsc --noEmit`
Expected: no errors in `BlueprintNodeDrawer.tsx` (the `node.data.leaf`/`importId` fields land in Task 13's `BlueprintNodeData`; if executing in order, do Task 13 next to clear those references).

- [ ] **Step 6: Commit**

```bash
git add app/frontend/components/BlueprintNodeDrawer.tsx
git commit -m "feat(ui): canvas drawer saves/deletes via the draft overlay"
```

---

## Task 13: `BlueprintCanvas.tsx` — drop into the active leaf; remove layout persistence

Make the canvas leaf-aware: each server node carries its `leaf`; palette/adopt drops require an active leaf and write drafts; positions are always auto-laid-out (the overlay has no `_layout.json`); the "commit to PR" button calls the deterministic promote.

**Files:**
- Modify: `app/frontend/components/BlueprintCanvas.tsx`

- [ ] **Step 1: Update imports + node data**

Drop the removed wrappers; keep `fetchBlueprintResources`:

```typescript
import { fetchBlueprintResources, writeDraft } from "@/lib/api";
import { autoLayoutNodes } from "@/lib/blueprintLayout";
```

(Remove `patchBlueprintLayout`, `writeBlueprintResource`, and `shouldAutoLayout` from imports — see Step 4.)

Add `leaf` to `BlueprintNodeData` (after `importId`/`imported`):

```typescript
  /** account/region/layer/component relpath this node was saved into.
   *  Absent for un-saved drops (they use the active leaf on save). */
  leaf?: string;
```

Add to the type import: `import type { ..., LeafCoords } from "@/lib/types";`.

- [ ] **Step 2: Thread `activeLeaf` + `onPromote` through both component layers**

Replace `onCommitToPR` with `onPromote` and add `activeLeaf` in both the `BlueprintCanvas` wrapper props and the `CanvasInner` props (and the pass-through in `BlueprintCanvas`'s body). For each props block, change:

```typescript
  onCommitToPR?: () => void;
```
to:
```typescript
  activeLeaf: LeafCoords | null;
  onPromote?: () => void;
```

and in `BlueprintCanvas`'s `<CanvasInner ... />`, pass `activeLeaf={activeLeaf}` and `onPromote={onPromote}` instead of `onCommitToPR`.

- [ ] **Step 3: Rework `onDrop` (both adopt-drop and palette-drop) to require a leaf and write drafts**

```typescript
  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      if (!activeLeaf) {
        setLoadError("Select or create a leaf first (tree → + leaf).");
        return;
      }

      // Adopt-drop: a discovered resource dragged from the tree.
      const existingRaw = e.dataTransfer.getData(EXISTING_DRAG_TYPE);
      if (existingRaw) {
        let existing: ExistingResource;
        try {
          existing = JSON.parse(existingRaw) as ExistingResource;
        } catch {
          return;
        }
        const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const adoptMeta = familyOf(existing.type);
        const leafRel = `${activeLeaf.account}/${activeLeaf.region}/${activeLeaf.layer}/${activeLeaf.component}`;
        const adoptedNode: BlueprintNode = {
          id: `${existing.type}.${existing.name}`,
          type: "resource",
          position,
          data: {
            resourceType: existing.type,
            name: existing.name,
            family: adoptMeta.family,
            monogram: adoptMeta.monogram,
            attributes: existing.summary_attributes,
            importId: existing.import_id,
            imported: true,
            leaf: leafRel,
          },
        };
        setNodes((nds) => [
          ...nds.filter((n) => n.id !== adoptedNode.id),
          adoptedNode,
        ]);
        onSelectNode(adoptedNode);
        void writeDraft({
          kind: "adopt",
          type: existing.type,
          name: existing.name,
          import_id: existing.import_id,
          attributes: existing.summary_attributes,
          ...activeLeaf,
        })
          .then(() => onAdopted?.())
          .catch((err) =>
            setLoadError(`Adopt failed: ${(err as Error).message}`),
          );
        return;
      }

      // Palette-drop: a fresh resource. Persisted when the user saves the
      // drawer form; we just place a client-only node tagged with the leaf.
      const resourceType = e.dataTransfer.getData(PALETTE_DRAG_TYPE);
      if (!resourceType) return;
      const meta = familyOf(resourceType);
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const leaf = resourceType.replace(/^aws_/, "");
      const n = (nextNameByType[resourceType] ?? 0) + 1;
      setNextNameByType((prev) => ({ ...prev, [resourceType]: n }));
      const leafRel = `${activeLeaf.account}/${activeLeaf.region}/${activeLeaf.layer}/${activeLeaf.component}`;
      const newNode: BlueprintNode = {
        id: `${resourceType}.${leaf}_${n}_${Date.now().toString(36)}`,
        type: "resource",
        position,
        data: {
          resourceType,
          name: `${leaf}_${n}`,
          family: meta.family,
          monogram: meta.monogram,
          leaf: leafRel,
        },
      };
      setNodes((nds) => [...nds, newNode]);
      onSelectNode(newNode);
    },
    [activeLeaf, screenToFlowPosition, setNodes, nextNameByType, onSelectNode, onAdopted],
  );
```

- [ ] **Step 4: Drop layout persistence; always auto-layout server nodes**

The overlay has no `_layout.json`, and `list_resources` returns no `position`. Simplify:

1. In the load effect (~202-275), remove the `layoutToPersist`/`patchBlueprintLayout` branch and always auto-layout when there are server resources. Replace the `setNodes((prev) => {...})` body with:

```typescript
        setNodes((prev) => {
          const reconciled = reconcileNodes(prev, res.resources);
          newArrivalIds = reconciled.newArrivals;
          // Overlay has no persisted positions; auto-layout keeps the graph
          // readable. Un-saved client drops keep their dropped position via
          // reconcileNodes (they aren't in `res.resources`).
          return autoLayoutNodes(reconciled.nodes, newEdges);
        });
```

Delete the `layoutToPersist` declaration and the `if (layoutToPersist) { ... }` block.

2. Delete the drag-to-save machinery: `pendingPositionsRef`, `positionFlushTimerRef`, `flushPendingPositions`, `handleNodesChange` (revert the `ReactFlow` prop to `onNodesChange={onNodesChange}`), the unmount-flush effect, and `runManualLayout`'s `patchBlueprintLayout` call. Keep a simple manual layout:

```typescript
  const runManualLayout = useCallback(() => {
    if (nodes.length === 0) return;
    setNodes(autoLayoutNodes(nodes, edges));
  }, [nodes, edges, setNodes]);
```

3. In `serverNodeFrom` (~648-670), positions come from auto-layout, not the response. Replace `position: r.position,` with `position: r.position ?? { x: 0, y: 0 },` and add `leaf: r.leaf,` into `data`.

4. Remove `shouldAutoLayout` from the import (no longer used).

- [ ] **Step 5: Replace the "commit to PR" canvas button with promote**

In the `<Panel position="top-right">`, change the second button:

```tsx
            <button
              type="button"
              onClick={() => onPromote?.()}
              disabled={nodes.length === 0 || !onPromote}
              title="Promote staged leaves into a PR (deterministic — no agent)"
              className="px-1.5 h-6 text-[10px] font-mono rounded-sm border border-accent bg-accent text-white hover:opacity-90 transition-colors disabled:opacity-50"
            >
              promote to PR
            </button>
```

Optionally add an active-leaf indicator Panel (top-left) so the user knows where drops land:

```tsx
          <Panel position="top-left" className="!m-2">
            <span className="px-1.5 h-6 inline-flex items-center text-[10px] font-mono rounded-sm border border-border bg-background/95 text-muted-foreground">
              {activeLeaf
                ? `leaf: ${activeLeaf.layer}/${activeLeaf.component}`
                : "no leaf selected"}
            </span>
          </Panel>
```

- [ ] **Step 6: Verify**

Run: `cd app/frontend && npx tsc --noEmit && npm run lint`
Expected: no errors in `BlueprintCanvas.tsx`. `page.tsx`, `BlueprintNodeDrawer.tsx` references to `node.data.leaf` now resolve.

- [ ] **Step 7: Commit**

```bash
git add app/frontend/components/BlueprintCanvas.tsx
git commit -m "feat(ui): canvas drops author into the active leaf; drop layout sidecar; deterministic promote"
```

---

## Task 14: `PendingChanges.tsx` — deterministic promote + PR URL

The bar's "commit to PR" now calls `promoteDrafts` and shows the returned PR link (or error).

**Files:**
- Modify: `app/frontend/components/PendingChanges.tsx`

- [ ] **Step 1: Replace the props + button**

```typescript
export function PendingChanges({
  refreshKey,
  onPromote,
  result,
  onDismissResult,
}: {
  refreshKey?: number;
  /** Fires the deterministic promote (parent calls promoteDrafts). */
  onPromote: () => void;
  /** Set by the parent after promote resolves/rejects. */
  result: { url: string } | { error: string } | null;
  onDismissResult: () => void;
}) {
```

The grouping currently keys on `d.component`; that still works (drafts carry `component`). Optionally group by leaf instead — keep `component` for now.

Replace the action button + add a result strip. Replace the `return` block:

```tsx
  if (drafts.length === 0 && !result) return null;

  return (
    <div className="shrink-0 border-b border-border bg-amber-50/60 dark:bg-amber-950/30 px-3 py-1.5 space-y-1">
      {drafts.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-amber-800 dark:text-amber-300">
            {drafts.length} pending
          </span>
          <span className="flex-1 min-w-0 truncate text-[10px] font-mono text-muted-foreground">
            {byComponent.map(([c, n]) => `${c} ${n}`).join(" · ")}
          </span>
          <button
            type="button"
            onClick={onPromote}
            className="shrink-0 h-6 px-2 inline-flex items-center justify-center text-[10px] font-medium rounded-sm bg-accent text-white hover:opacity-90 transition-colors"
          >
            promote to PR
          </button>
        </div>
      )}
      {result && (
        <div className="flex items-center gap-2 text-[10px] font-mono">
          {"url" in result ? (
            <a
              href={result.url}
              target="_blank"
              rel="noreferrer"
              className="flex-1 min-w-0 truncate text-emerald-700 dark:text-emerald-400 underline"
            >
              PR opened: {result.url}
            </a>
          ) : (
            <span className="flex-1 min-w-0 truncate text-red-600 dark:text-red-400">
              ✗ {result.error}
            </span>
          )}
          <button
            type="button"
            onClick={onDismissResult}
            className="shrink-0 h-5 px-1.5 rounded-sm text-muted-foreground hover:bg-muted"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run: `cd app/frontend && npx tsc --noEmit`
Expected: no errors in `PendingChanges.tsx` (`page.tsx` already passes `onPromote`/`result`/`onDismissResult`).

- [ ] **Step 3: Commit**

```bash
git add app/frontend/components/PendingChanges.tsx
git commit -m "feat(ui): pending bar promotes deterministically and shows the PR URL"
```

---

## Task 15: `PlanDiff.tsx` — per-leaf preview selector

Add a leaf dropdown next to the existing root selector (only when `root === "blueprint"`). It lists the owner's staged leaves and drives the `leaf` param on `fetchPlanDiff`.

**Files:**
- Modify: `app/frontend/components/PlanDiff.tsx`
- Modify: `app/frontend/app/page.tsx` (lift `planLeaf` state; pass leaf to `fetchPlanDiff`)

- [ ] **Step 1: Read the current `PlanDiff` props**

Run: `sed -n '1,80p' app/frontend/components/PlanDiff.tsx` to see the existing `root`/`onRootChange` props and the root selector markup. (Not pasted here — it wasn't in the plan author's read set; match its existing style.)

- [ ] **Step 2: Lift `planLeaf` into `page.tsx`**

Add state next to `planRoot`:

```typescript
  const [planLeaf, setPlanLeaf] = useState<string | null>(null);
  const [stagedLeaves, setStagedLeaves] = useState<string[]>([]);
```

Populate `stagedLeaves` from the overlay (unique `leaf` values) on mount + after `blueprintReload`:

```typescript
  useEffect(() => {
    const ac = new AbortController();
    fetchBlueprintResources(ac.signal)
      .then((res) => {
        const uniq = Array.from(
          new Set(res.resources.map((r) => r.leaf).filter(Boolean) as string[]),
        ).sort();
        setStagedLeaves(uniq);
      })
      .catch(() => setStagedLeaves([]));
    return () => ac.abort();
  }, [blueprintReload]);
```

(Add `fetchBlueprintResources` to the api import in `page.tsx`.)

Thread `leaf` into `runPlan`:

```typescript
      setPlanDiff(await fetchPlanDiff(ac.signal, planRoot, planLeaf ?? undefined));
```

and add `planLeaf` to `runPlan`'s dependency array.

Pass new props to `<PlanDiff>`:

```tsx
          <PlanDiff
            diff={planDiff}
            loading={planLoading}
            error={planError}
            onRunPlan={runPlan}
            focusAddress={planFocusAddress}
            root={planRoot}
            onRootChange={(r) => {
              setPlanRoot(r);
              if (r !== "blueprint") setPlanLeaf(null);
            }}
            leaf={planLeaf}
            onLeafChange={setPlanLeaf}
            leaves={stagedLeaves}
          />
```

- [ ] **Step 3: Add the leaf selector to `PlanDiff`**

Add to `PlanDiff`'s props: `leaf: string | null`, `onLeafChange: (leaf: string | null) => void`, `leaves: string[]`. Next to the existing root `<select>`, render (only when `root === "blueprint"`):

```tsx
        {root === "blueprint" && (
          <select
            value={leaf ?? ""}
            onChange={(e) => onLeafChange(e.target.value || null)}
            className="text-[10px] font-mono rounded-sm border border-border bg-background px-1.5 h-6 outline-none focus:border-accent"
            title="Preview a single staged leaf"
          >
            <option value="">whole blueprint</option>
            {leaves.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        )}
```

- [ ] **Step 4: Verify**

Run: `cd app/frontend && npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add app/frontend/components/PlanDiff.tsx app/frontend/app/page.tsx
git commit -m "feat(ui): per-leaf plan preview selector"
```

---

## Task 16: Full verification + manual Moto e2e

**Files:** none (verification).

- [ ] **Step 1: Backend suite + lint**

Run: `cd app/backend && uv run pytest -q && uv run ruff check src/devex_app`
Expected: all pass; ruff clean. Fix any older test that asserted the removed flat endpoints or the old draft shape.

- [ ] **Step 2: Frontend type-check, lint, build**

Run: `cd app/frontend && npx tsc --noEmit && npm run lint && npm run build`
Expected: all clean. (`npm run build` is the strongest gate given no test runner.)

- [ ] **Step 3: Manual e2e against Moto**

```bash
# repo root, Moto up (make local-up); start backend + frontend
. ./dev.local.env
( cd app/backend && uv run uvicorn devex_app.main:app --port 8090 --host 127.0.0.1 & )
( cd app/frontend && npm run dev & )   # proxies /api to the backend
```

Then in the browser (http://localhost:3000), walk the golden path **and** the edge cases:
1. **New leaf:** tree → "＋ leaf" → fill `billing-prod-account / us-east-1 / infra / net` → "Use this leaf". QuickCreate opens for that leaf.
2. **Author raw:** create an `aws_vpc` named `main`. It appears under `…/infra/net` as a `plan` row; the inspector shows it.
3. **Canvas:** switch to the canvas tab — the active-leaf indicator shows `infra/net`; drag a palette tile, fill the form, Save. Confirm it lands in the leaf (check `live/blueprint/drafts/local/billing-prod-account/us-east-1/infra/net/`).
4. **Adopt:** run discovery (or pre-seed `_discovered.json`), drag an unmanaged row onto the canvas (or use the inspector "Adopt & edit") — confirm it requires the active leaf and writes an `import {}` block.
5. **Per-leaf preview:** Plan tab → root `blueprint`, leaf `billing-prod-account/us-east-1/infra/net` → run plan → a VPC create shows.
6. **Edge cases:** try a drop with **no** active leaf (expect the "Select or create a leaf first" hint); confirm a **managed** resource row shows no Edit/Delete buttons (parked); discard a draft and confirm the leaf prunes when empty.
7. **Promote (careful — opens a real PR):** only if intended, click "promote to PR" in the bar; confirm the returned PR URL renders as a link and the drafts clear. In routine testing, **skip** this or point `DEVEX_LIVE_ROOT`/repo at a throwaway.

Document anything that can't be exercised (e.g., promote skipped) explicitly rather than claiming success.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A app/backend app/frontend
git commit -m "test(app): align suites with the leaf-overlay frontend"
```

---

## Optional / deferred (note, don't build unless asked)

- **Dependency edges on the canvas.** Phase 2a set `list_resources` `edges: []`. Restoring cross-leaf reference derivation would re-enable arrows + dependency-aware auto-layout. Deferred to keep 2b bounded; auto-layout currently grids nodes without edges.
- **Per-leaf canvas scoping.** The canvas shows all of the owner's overlay resources at once (tagged by leaf) rather than filtering to the active leaf. A leaf filter is a small follow-up if the canvas gets crowded.
- **Nested-block authoring in the inspector.** `ResourceInspector` still sends attributes only (pre-existing behavior); the canvas drawer now sends `blocks`. Unifying block support in the inspector is a follow-up.
- **Module-catalog authoring (Phase 3)**, **OKTA/RBAC identity (Phases 4-5)**, **bot identity for promote (Phase 4/6)** — out of Phase 2 entirely.

---

## Self-review (against the spec + the user's decisions)

- **Layer nav level** → Task 1 (backend coord) + Task 9 (tree).
- **Author into the selected leaf via draft endpoints** → Tasks 5/6 (types/api), 7/8 (leaf selection + active-leaf state), 10 (QuickCreate), 11 (inspector adopt), 12/13 (canvas drawer + drops). Coords now required on every draft write/discard.
- **Flat write path gone** → already removed in 2a; Task 4 removes the remaining dead flat `layout`/`resource-delete` endpoints and Task 6 removes their client wrappers; the canvas no longer calls them.
- **Promote button → PR URL (deterministic, no agent)** → Task 14 (bar) + Task 13 (canvas button) call `promoteDrafts`; Task 8 deletes the agent prompts.
- **Delete the agent commit prompts** → Task 8 (`BLUEPRINT_COMMIT_PROMPT` ×2, `commitDraftsPrompt`, `addToComponentPrompt`).
- **Decision 1 (leaf form + leaf "+add")** → Tasks 7, 9. **Decision 2 (park managed edit/delete; adopt needs leaf)** → Task 11. **Decision 3 (per-leaf preview)** → Tasks 3, 15.
- **No-regression on nested blocks** → Task 2 teaches the draft writer to render blocks; Task 12 forwards them.
- **Type consistency:** `LeafCoords` used uniformly; `discardDraft(type, name, coords)` everywhere; `writeDraft({..., ...coords})`; `BlueprintNodeData.leaf` + `BlueprintResource.leaf` + `InventoryResource.layer` align with the backend.
- **Ordering caveat:** Tasks 8 and 12-13 reference `BlueprintNodeData.leaf`, which is defined in Task 13. If running strictly task-by-task with a green type-check between each, do **8 → 13 → 12 → others**, or accept that the type-check first fully greens at Task 13. The build gate is Task 16 regardless.
