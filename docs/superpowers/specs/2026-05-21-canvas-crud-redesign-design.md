# Inspector-centric CRUD redesign — design

Redesign how resources are created, edited, and deleted in the DevEx app.
Today CRUD is canvas-centric, split across two drawers, slow, and can't
touch imported/managed resources. This makes a **fast, unified inspector**
the primary CRUD surface (driven from the tree), turns the canvas into an
optional "see the picture" view, and introduces a **sandbox-draft model**
so any resource — managed, unmanaged, or planned — is editable in one place.

**Status: design only, no implementation yet.**

---

## Motivation

After the unified-hierarchy refactor, the tree is the navigator but CRUD
still lives on the canvas:

- **Split / disconnected** — browsing is in the tree/inspector; creating &
  editing is in the canvas's `BlueprintNodeDrawer`. Two worlds.
- **Clunky create** — drag a palette tile, then fill a long form, then save.
- **Canvas role unclear** — now that the tree navigates, the canvas's job is
  ambiguous.
- **Editing isn't powerful enough** — no diffs, no edits to existing infra.
- **Imported/managed resources can't be updated or dragged in** — adoption
  requires the canvas; managed resources are inspect-only.
- **Slow and unclear** — too many steps, unclear where actions live.

Goal: one fast, keyboard-friendly inspector that does create/edit/delete for
**every** resource state, with edits to existing resources captured as
drafts and promoted through the existing PR → manual-apply path.

---

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Canvas role | **Secondary / optional** "see the picture" view; not required for any operation |
| Primary CRUD surface | **Inspector + inline create**, driven from the tree |
| Edit scope | **Everything**, including already-managed resources (full unification) |
| Edit representation | **Sandbox-draft model** — every create/edit/adopt/delete is a draft (`bp.*.tf` + `_drafts.json`), promoted per component |
| Concurrency | **Owner-scoped drafts** — drafts belong to a developer (owner) so simultaneous editing never clobbers; full multi-user identity/collaboration + prod env are a later phase |

---

## Architecture

### The draft layer

The blueprint sandbox becomes a universal **draft / change-set** layer. A new
sidecar `live/blueprint/_drafts.json` records each pending change's intent;
the `bp.<type>.<name>.tf` file holds its HCL (when applicable):

```json
{
  "aws_instance.solr_1": {
    "kind": "edit",
    "owner": "alice",
    "source_address": "aws_instance.solr_1",
    "target_module": "modules/solr",
    "component": "solr"
  },
  "aws_sqs_queue.new_queue": {
    "kind": "new",
    "owner": "alice",
    "target_module": "modules/jenkins",
    "component": "jenkins"
  }
}
```

Every draft carries an **`owner`** (the developer working it). Draft storage
is namespaced per owner so two developers never overwrite each other's
`bp.*.tf` or draft entries — see *Multi-user & concurrency* below.

Draft kinds:

- **new** — fresh `bp` file authored from the create form, `Component` tag
  applied. Promotes into the component's module.
- **adopt** — `bp` file with an `import {}` block + body seeded from the
  unmanaged resource's discovered attributes. Promotes as an import.
- **edit** — `bp` file seeded from a managed resource's current state
  (editable attrs only, computed/read-only dropped). `source_address` is the
  real resource; the inspector shows a **diff vs live**. Promotes by
  modifying that resource in its real module.
- **delete** — marker only (no HCL). Promotes by removing the resource from
  its module (a proposed destroy).

A resource may be **both** a live state (managed/unmanaged) **and** have a
draft — e.g. an edited managed resource shows `managed ●draft` in the tree.

### Inventory integration

`GET /api/inventory` reads `_drafts.json` and annotates each resource with
its draft (`draft_kind`, and for edits the seeded draft attributes for the
diff). The existing `planned` state continues to mean "has a `new`/`adopt`
draft and no live counterpart"; a managed/unmanaged resource with an `edit`
or `delete` draft keeps its state but gains a `draft` annotation.

### Multi-user & concurrency (foundation now, full workflow later)

The platform serves many developers at once, so the draft layer is designed
**owner-scoped from day one** — even though real identity, collaboration,
and a production environment are a separate, later phase. The foundations
this redesign commits to:

- **Owner-scoped draft storage.** Each developer's drafts live in their own
  namespace (`live/blueprint/drafts/<owner>/`: that owner's `bp.*.tf`,
  `_drafts.json`, `_layout.json`). Two developers editing concurrently never
  touch the same files, so there's no clobbering and no shared-file write
  race. Atomic temp-write+rename stays.
- **Owner identity is pluggable.** Every draft API call carries an owner
  (request header); until auth lands it defaults to a single configurable
  local owner, so single-developer behavior is unchanged. Wiring real
  identity is a drop-in later.
- **Shared vs per-owner data.** Org-level data stays shared: the discovery
  manifest (`_discovered.json`) and the component hierarchy/mapping
  (`_hierarchy.json`). Work-in-progress (drafts) is per-owner.
- **Inventory is owner-aware.** `GET /api/inventory` takes the owner and
  overlays *that owner's* drafts onto the shared live + discovered
  inventory, so each developer sees their own pending changes, not everyone's.
- **Promote is per-owner.** "Commit to PR" promotes only the requesting
  owner's drafts, onto their own branch/PR.
- **Concurrent edits to the same resource** are *detectable* (two owners with
  an `edit`/`delete` draft for the same `source_address`). This redesign
  keeps them isolated; surfacing/merging the conflict is part of the later
  multi-user workflow.

Explicitly **deferred** to the later multi-user/production discussion:
authentication & real identity, conflict detection/resolution UI,
per-owner `tofu plan` preview isolation (separate plan workspaces),
locking, and the production deployment model.

---

## Components

### Backend (`app/backend/src/devex_app`)

- **Owner resolution** — a small dependency reads the owner from a request
  header (`X-DevEx-Owner`), defaulting to a configurable local owner. All
  draft + inventory routes use it to pick the owner's draft namespace
  (`live/blueprint/drafts/<owner>/`).
- **`routes/blueprint.py` — `POST /api/blueprint/draft` (new)** — create or
  update a draft of any kind for the owner. Body: `{kind, type, name,
  component?, source_address?, attributes?, import_id?}`. Writes the `bp`
  file into the owner's namespace (seeded for `edit`/`adopt`, read-only attrs
  stripped, `Component` stamped) and the owner's `_drafts.json` entry (with
  `owner`). For `delete`, writes only the marker.
- **`DELETE /api/blueprint/draft/{type}/{name}` (new)** — discard one of the
  owner's drafts (removes the `bp` file + the `_drafts.json` entry).
- **`routes/inventory.py` (changed)** — read the owner's `_drafts.json`;
  annotate resources with `draft_kind` and seeded draft attributes; for
  managed/unmanaged resources, attach an `edit`/`delete` draft without
  changing their base `state`. Only the requesting owner's drafts overlay.
- **Promote** — extend the commit-to-PR prompt to read the **owner's**
  `_drafts.json` and route each draft by kind (new → component module, edit →
  modify in the resource's real module, adopt → import, delete → remove),
  grouped into PR(s) per component, onto that owner's branch. Apply stays
  manual.
- **Seeding** — `edit` drafts seed from the resource's live `values`
  (already in the inventory payload), filtered to editable attributes via the
  existing read-only/`_AWS_ASSIGNED_ATTRS` logic so computed values never
  enter the draft HCL.

### Frontend (`app/frontend`)

- **`components/Inspector.tsx` (new)** — one state-aware inspector replacing
  `ResourceDrawer` + `BlueprintNodeDrawer`. Renders, per selection:
  - the schema-driven editable form (reused from the current
    `BlueprintNodeDrawer`), with read-only "Set by AWS" fields;
  - a **diff vs live** strip when an `edit` draft exists;
  - state-aware actions: **Save draft**, **Discard**, **Delete**
    (planned → drop draft; managed → propose destroy), **Adopt & edit**
    (unmanaged);
  - the component reassign control (from the hierarchy work).
  Editing a managed/unmanaged resource auto-creates the appropriate draft on
  first change.
- **`components/ResourceTree.tsx` (changed)** — `＋` create affordance on
  component (and type) nodes; `●draft` indicators; feeds the pending-changes
  bar.
- **`components/QuickCreate.tsx` (new)** — fast create form opened by `＋`:
  resource-type picker + required fields, `Component` pre-filled from the
  branch, keyboard submit → `new` draft.
- **`components/PendingChanges.tsx` (new)** — a bar/panel summarizing drafts
  grouped by component with a **commit to PR** action.
- **`app/page.tsx` (changed)** — wire the unified inspector into region 4;
  canvas remains an optional work-surface tab.
- **`lib/api.ts` / `lib/types.ts` (changed)** — draft CRUD client + types;
  `draft_kind` / draft attributes on `InventoryResource`.

---

## Data flow

1. **Create** → `＋` on a component → QuickCreate → `POST /api/blueprint/
   draft {kind:"new", component}` → `new` draft appears under the component
   (`draft` badge).
2. **Edit** (any state) → editing a field puts the inspector in draft mode
   (in memory, seeded from current state — import block for unmanaged) and
   shows the diff above the form; **Save draft** persists it (writes the `bp`
   file + `_drafts.json`). Nothing is written until Save.
3. **Delete** → planned: discard draft. managed: `delete` draft (propose
   destroy).
4. **Adopt** → unmanaged resource → **Adopt & edit** → `adopt` draft, then
   editable like any draft.
5. **Promote** → pending-changes bar → **commit to PR** → agent applies each
   draft to the right module per kind/component, opens PR(s). Manual apply
   after merge.

---

## Layout

Unchanged four regions (Agent · Tree · Work surface · Inspector). The
inspector (region 4) becomes the CRUD workhorse; the work surface keeps the
**canvas | plan-diff** tabs, with the canvas now optional (it visualizes the
selected component's resources + dependency edges, but no operation requires
it).

---

## Error handling & edge cases

- **Editing without saving** → draft is only written on **Save draft**;
  unsaved edits live in component state and can be discarded.
- **Malformed `_drafts.json`** → ignored; resources show without draft
  annotations (never crash).
- **Edit draft whose source resource disappears** (deleted out of band) →
  surfaced as a stale-draft warning at promote, not a crash.
- **Delete draft on a planned resource** → just discards the draft (nothing
  was live).
- **Computed values** never enter draft HCL (read-only filter), so promoting
  an edit won't write `arn`/`id`/`tags_all`.
- **Safety** — drafts only author HCL; `apply` / `tofu import` stay
  manual/denied; promote opens a PR, never applies.

---

## Phasing (for the implementation plan)

1. **Unified inspector + edit-as-draft (owner-scoped)** — owner resolution +
   per-owner draft namespace; one `Inspector` component;
   `POST/DELETE /api/blueprint/draft` for `new`/`edit`/`adopt`; inventory
   draft annotation + diff, overlaying only the owner's drafts. Editing any
   resource produces a draft.
2. **Quick create + delete** — `＋` QuickCreate (`new` drafts) and
   Delete/propose-destroy (`delete` drafts).
3. **Pending-changes bar + promote** — drafts summary grouped by component +
   per-kind/per-component commit-to-PR routing.
4. **Cleanup** — retire `ResourceDrawer` + `BlueprintNodeDrawer` in favor of
   `Inspector`; canvas-optional polish.

Each phase ships something usable.

---

## Testing

- **Backend (pytest):** draft CRUD per kind (new/adopt/edit/delete) writes
  the right `bp` file + `_drafts.json`; `edit` seeding drops read-only attrs;
  inventory annotates drafts (incl. managed `●draft`); discard removes both
  file + entry; promote-prompt assembly includes all drafts routed by kind.
  **Owner isolation:** two owners' drafts don't collide, and inventory for
  owner A never shows owner B's drafts. Mock at the tofu/manifest boundary —
  no AWS.
- **Frontend:** tsc + eslint + `next build`; inspector state-routing and diff
  exercised via build + manual smoke (no FE unit harness).
- **Manual smoke:** create under a component (draft appears), edit a managed
  resource (diff shows, draft annotated), delete (propose destroy), commit to
  PR (drafts routed correctly).

---

## Non-goals

- **Direct live mutation** — all CRUD flows config → draft → PR → manual
  apply.
- **Applying from the UI** — promote opens PRs only.
- **Spatial CRUD on the canvas** — the canvas is read/visualize only; no
  create/edit/delete happens there.
- **A frontend unit-test harness** — verification stays tsc/lint/build +
  manual.
- **Full multi-user workflow & production env** — this redesign lays the
  owner-scoped *foundation* (per-owner drafts, pluggable owner identity), but
  real authentication, conflict detection/resolution, per-owner plan-preview
  isolation, locking, and the production deployment model are a separate,
  later phase (per the user's note).
