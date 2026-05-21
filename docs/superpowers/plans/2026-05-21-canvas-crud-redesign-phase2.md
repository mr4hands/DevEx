# Inspector-centric CRUD — Phase 2 Plan (unified Inspector UI: edit-as-draft)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Make the right-pane inspector able to edit *any* tree-selected resource (managed / unmanaged / planned) as an owner-scoped draft, reusing the existing schema-driven form, with a diff-vs-live and Save-draft / Discard / Adopt actions wired to the Phase 1 draft API.

**Architecture:** Extract the schema-driven attribute form out of `BlueprintNodeDrawer` into a reusable `ResourceForm`. Build a `ResourceInspector` that wraps the existing read view (`ResourceDrawer`) plus an "Edit as draft" mode using `ResourceForm`; on save it calls `writeDraft` (`kind: edit` for managed/planned, `adopt` for unmanaged) and shows a diff of changed attrs. Wire it into `page.tsx` region 4 for tree selections. New/delete/QuickCreate/pending-bar/promote are Phase 3+.

**Tech Stack:** Next.js 16 + React 19. **No FE unit harness** — verify with `npx tsc --noEmit`, `npm run lint`, `npm run build`. The actual UX needs manual browser verification (call it out; don't claim UX success without it).

**Reference spec:** `docs/superpowers/specs/2026-05-21-canvas-crud-redesign-design.md`. Phase 1 (draft API: `writeDraft`/`discardDraft`, `draft_kind` on inventory) is already shipped.

**Scope guardrails:** Do not touch the backend. Do not retire `BlueprintNodeDrawer` (Phase 4 does that) — only extract its form. Keep the canvas working.

---

## Task 1: Extract `ResourceForm` from `BlueprintNodeDrawer`

**Files:**
- Create: `app/frontend/components/ResourceForm.tsx`
- Modify: `app/frontend/components/BlueprintNodeDrawer.tsx`

**What:** Move the schema-driven editor primitives — `AttrInput`, `ReadOnlyAttr`, `FieldRow`, `BlockEditor`, `BlockInstanceEditor`, `SectionHeader`, `attrKind`, `parseReferenceTarget`, the `_REF_NAV_RE` — and a new top-level `ResourceForm` that renders the Required / Optional / Set-by-AWS / Nested-blocks sections from a `ResourceSchema` + form state, into `ResourceForm.tsx`. `BlueprintNodeDrawer` imports them back and keeps behaving exactly as today.

- [ ] **Step 1: Create `ResourceForm.tsx`** exporting:
  - `ResourceForm({ schema, name, attrs, blocks, onNameChange?, onAttr, onBlocks, onNavigateToRef, observed, nameEditable })` — renders the existing sections. `observed` (optional `Record<string,unknown>`) feeds read-only "Set by AWS" values (as in the current drawer). `nameEditable` toggles the name field (off for live resources whose name is fixed). Pull the JSX/logic verbatim from `BlueprintNodeDrawer`'s body (required/optional/showAll/search/read-only/blocks) so behavior is identical.
  - Re-export the small helpers (`AttrInput`, etc.) it needs internally (keep them module-private; only `ResourceForm` is the public surface unless `BlueprintNodeDrawer` needs a specific one).

- [ ] **Step 2: Update `BlueprintNodeDrawer.tsx`** to import `ResourceForm` (and any helper it still references directly) from `ResourceForm.tsx`, deleting the moved definitions. Keep `BlueprintNodeDrawer`'s own header/footer/save/delete/AdoptedStrip logic; just render `<ResourceForm .../>` where the inline form sections were.

- [ ] **Step 3: Verify** `cd app/frontend && npx tsc --noEmit && npm run lint && npm run build` — all clean. The canvas drawer must still compile and render the same form (manual browser check later).

- [ ] **Step 4: Commit** `refactor(app): extract ResourceForm from BlueprintNodeDrawer`.

---

## Task 2: `ResourceInspector` with edit-as-draft

**Files:**
- Create: `app/frontend/components/ResourceInspector.tsx`
- Modify: `app/frontend/lib/types.ts` (if a small view-model type helps)

**What:** A component for a tree-selected `Resource` (+ its `InventoryResource` extras: `state`, `component`, `draft_kind`, `values`). Two modes:

- **View** (default): the current `ResourceDrawer` content (identity, tags, type-specific, the component reassign control). Add an **Edit as draft** button (label **Adopt & edit** when `state === "unmanaged"`).
- **Edit**: fetch the type's schema via `fetchSchemas([type])`; seed form state from `values` (editable attrs only — drop `read_only`); render `<ResourceForm nameEditable={false} observed={values} />`. Show a **diff vs live** strip (attrs where the edited value differs from `values`). Actions:
  - **Save draft** → `writeDraft({ kind: state==="unmanaged" ? "adopt" : "edit", type, name, source_address: address, import_id: state==="unmanaged" ? (id) : undefined, component, attributes: editedAttrs })` → on success call `onChanged()` (parent refreshes inventory) and return to View.
  - **Discard** → if a draft exists (`draft_kind`), `discardDraft(type, name)` then `onChanged()`; else just exit edit mode.
  - **Cancel** → exit edit mode without saving.

- [ ] **Step 1: Create `ResourceInspector.tsx`** implementing the above. Reuse `ResourceForm` for the editable fields. Keep the read view by composing/duplicating the existing `ResourceDrawer` sections (or render `ResourceDrawer` in view mode and overlay the Edit button). Diff = compare `editedAttrs[k]` vs `values[k]` for changed keys, render `- old / + new`.

- [ ] **Step 2: Verify** `npx tsc --noEmit && npm run lint && npm run build` clean.

- [ ] **Step 3: Commit** `feat(app): ResourceInspector edits any resource as a draft`.

---

## Task 3: Wire `ResourceInspector` into the page

**Files:**
- Modify: `app/frontend/app/page.tsx`
- Modify: `app/frontend/components/ResourceTree.tsx` (pass the selected `InventoryResource` up, not just a mapped `Resource`)

**What:** The tree currently maps the inventory row to a `Resource` for the drawer. The inspector needs the inventory extras (`state`, `id`, `component`, `draft_kind`, `values`). Pass the `InventoryResource` (or the needed fields) on selection.

- [ ] **Step 1:** In `ResourceTree`, change `onSelect(resource, component)` to also surface the `InventoryResource` (e.g. `onSelect(item)` and let the page derive what it needs). Update the page handler.

- [ ] **Step 2:** In `page.tsx` region 4, when a tree resource is selected (not a blueprint node), render `<ResourceInspector item={selectedItem} onChanged={() => setRefreshKey(k=>k+1)} onReassign={handleReassign} onClose={...} />` instead of `ResourceDrawer`. Keep `BlueprintNodeDrawer` for canvas-node selections (unchanged).

- [ ] **Step 3: Verify** `npx tsc --noEmit && npm run lint && npm run build` clean.

- [ ] **Step 4: Commit** `feat(app): wire ResourceInspector into the page for tree selections`.

---

## Task 4: Verify + manual smoke

- [ ] **Step 1:** `cd app/frontend && npx tsc --noEmit && npm run lint && npm run build` — all green.
- [ ] **Step 2:** Backend untouched, but run `cd app/backend && ./.venv/bin/python -m pytest -q` to confirm nothing regressed.
- [ ] **Step 3 (manual, needs the app running):** select a managed resource → Edit as draft → change an attr → see the diff → Save draft → confirm a `bp.*.tf` + `_drafts.json` entry appears under `live/blueprint/drafts/<owner>/` and the tree row shows `●draft`. Repeat Adopt&edit for an unmanaged resource (import block written). Discard removes the draft. **If you can't run the browser, say so — don't claim UX success.**

---

## Self-review notes

- **Spec coverage:** edit-as-draft for managed/unmanaged/planned via the inspector (T2), reusing the schema form (T1), wired from the tree (T3). New/delete/QuickCreate/pending-bar/promote are **Phase 3+** per the spec phasing.
- **DRY:** the form is extracted once (T1) and reused by both `BlueprintNodeDrawer` and `ResourceInspector` — no duplicated form logic.
- **Risk:** large blind UI change; verification is tsc/lint/build only — the reviewer/executor MUST do a browser smoke before declaring the UX done.
- **Type consistency:** `writeDraft`/`discardDraft`/`DraftRequest` (Phase 1) are the save path; `InventoryResource.draft_kind`/`state`/`values` drive the inspector.
