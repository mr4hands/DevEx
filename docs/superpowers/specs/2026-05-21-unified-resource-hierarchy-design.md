# Unified resource hierarchy navigator — design

Refactor the app's resource UX into a single hierarchical navigator that
groups every resource by **Account → Region → Component → type →
resource**, where "Component" is a product area / service (Solr, Jenkins,
Frontend, Backend…). The tree is the primary way developers browse the
org's infrastructure, inspect resources, adopt unmanaged ones, and add new
resources to a component — via the form or by talking to the agent.

This realizes "Ask 2" (structural composition) from
`research/blueprint-state-visualization-design.md`, which flagged the
account/region/team dimensioning as a platform decision needing definition
before code. **Status: design only, no implementation yet.**

---

## Motivation

Today resources live in two disconnected views: the **List** tab (live
managed state from `/api/plan`, full attributes incl `arn`) and the
**Blueprint** tab's flat "existing (aws)" rail (the thin discovery
manifest, no `arn`). They group only by resource type. There's no notion
of *which product component* a resource belongs to, so a developer can't
navigate to "Solr" and add capacity there.

Goals:

- One hierarchical navigator, **Account → Region → Component → type →
  resource**, that replaces both the List tab and the flat blueprint rail.
- Classify resources into components automatically from tags, with a
  UI-editable override for the rest.
- Let a developer select a component and add resources to it (form or
  agent), landing under that component immediately and promotable to the
  component's module.
- One data path, which incidentally fixes the `arn` discrepancy.

This serves the whole org eventually: every team/component is a branch;
developers self-serve within their branch.

---

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Tree shape | Component → **type** → resources (extra type grouping under each component) |
| Component source | **Auto from tags** (`Component` → `Service` → `Team`, first match), with a **UI-editable mapping override**; unmatched → **Unassigned** |
| Add-to-component | Author into the **blueprint sandbox** with `Component=<name>` auto-applied; **promote to the component's module** via commit-to-PR |
| Tree scope | **Unified navigator** — replaces both the List tab and the flat blueprint rail |
| Data source | **Merge** managed (tofu state, full attrs) + unmanaged (AWS discovery), deduped by id/arn |
| Account/Region | Account = discovered AWS account id; Region = resource region. Single account/region today; tiers present for multi-account later |

---

## Architecture & data model

**Build split:** the backend produces a *flat, classified inventory*; the
frontend groups it into the tree. Re-grouping (today by component, later by
region/account) stays a client concern with no round-trip, and the backend
keeps one source of truth for the mapping.

### Inventory (`GET /api/inventory`, new)

Merges two sources into one deduped list (key: resource id, falling back to
arn):

- **Managed** — from `tofu show -json` (today's `resources_from_state`):
  full attributes incl `arn`, `tags`, region. Flagged `managed=true`.
- **Unmanaged** — from the AWS discovery manifest (`_discovered.json`):
  resources not present in state. Flagged `managed=false` (adoptable).

A resource present in both (managed *and* discoverable) appears once,
flagged `managed=true`.

Each inventory item:

```json
{
  "address": "aws_instance.solr_1",
  "type": "aws_instance",
  "name": "solr_1",
  "id": "i-0ab12cd34",
  "arn": "arn:aws:ec2:us-east-1:123456789012:instance/i-0ab12cd34",
  "account": "123456789012",
  "region": "us-east-1",
  "managed": true,
  "component": "solr",
  "component_source": "tag",
  "tags": { "Component": "solr", "Environment": "prod" }
}
```

`component_source` is one of `tag` | `override` | `unassigned`, so the UI
can show how a resource got classified.

### Classification

For each resource, in order:

1. `mapping_override[address]` if present → `component`, `component_source=override`.
2. else the first present of tags `Component`, `Service`, `Team` →
   `component`, `component_source=tag`.
3. else `component="Unassigned"`, `component_source=unassigned`.

Account = AWS account id (from discovery / `aws_caller_identity`). Region =
the resource's region attribute (or provider region for managed state).

### Mapping file (`live/blueprint/_hierarchy.json`, new)

```json
{
  "components": {
    "solr":    { "display_name": "Solr",    "target_module": "modules/solr" },
    "jenkins": { "display_name": "Jenkins", "target_module": "modules/jenkins" }
  },
  "overrides": {
    "aws_s3_bucket.old_bucket": "solr"
  }
}
```

- `components` — display names + the module promotion targets for
  add-to-component.
- `overrides` — manual `address → component` assignments that win over
  tags.

Edited via the UI (reassign a resource, create a component) through backend
CRUD. Malformed file → overrides ignored (tree still builds from tags).

---

## Components

### Backend (`app/backend/src/devex_app`)

- **`routes/inventory.py` (new)** — `GET /api/inventory`. Calls
  `resources_from_state` (managed) + reads the discovery manifest
  (unmanaged), dedups, classifies via the mapping + tags, returns the flat
  list + the loaded `components` map. Read-only, deterministic.
- **`routes/hierarchy.py` (new)** — CRUD over `_hierarchy.json`:
  `PUT /api/hierarchy/override` (`{address, component}`), `DELETE` an
  override, `POST /api/hierarchy/component` (`{name, display_name,
  target_module}`).
- **`routes/blueprint.py` (changed)** — `write_resource` stamps
  `tags.Component=<name>` when the request carries a `component`, so
  added/adopted resources self-classify.
- **`tofu.py` / discovery** — already surface `tags` + `arn`; ensure both
  flow through `resources_from_state` and the manifest for classification +
  display.

### Frontend (`app/frontend`)

- **`components/ResourceTree.tsx` (new)** — fetches `/api/inventory` and
  groups client-side into Account → Region → Component → type → resource,
  plus an **Unassigned** bucket. Rows show `mgd`/`unmgd` badges; component
  nodes have a `＋ add` affordance and are selectable as the add-target.
  Replaces `ResourceList` and `ExistingResourceTree`.
- **`app/page.tsx` (changed)** — restructure to four regions: Agent
  (collapsible) · ResourceTree · Work surface (Canvas / Plan-diff tabs) ·
  Inspector. Drop the `list` tab.
- **Inspector (`ResourceDrawer` consolidation)** — one drawer routes by
  kind: **managed** → inspect (full attrs incl arn, read-only "Set by
  AWS"); **unmanaged** → Adopt; **blueprint node** → the existing edit
  form. Adds a **reassign-component** control that writes an override.
- **`components/BlueprintCanvas.tsx` (changed)** — scopes to the selected
  component, shows the add-target banner, applies the `Component` tag on
  add/adopt.
- **`lib/api.ts` / `lib/types.ts` (changed)** — client + types for
  `/api/inventory` and hierarchy CRUD.

---

## Layout (four regions)

```
┌──────────┬────────────────────┬─────────────────────┬───────────────┐
│ Agent    │ Resources (tree)   │ Work surface        │ Inspector     │
│ (collap- │ Account→Region→    │ canvas │ plan diff  │ editable vs   │
│  sible)  │  Component→type→   │ scoped to component │ Set-by-AWS,   │
│          │  resource +        │ + add resource      │ reassign      │
│          │  Unassigned        │                     │ component     │
└──────────┴────────────────────┴─────────────────────┴───────────────┘
```

Interactions:

- **Click a resource** → Inspector. Managed shows full attributes incl
  `arn`; unmanaged shows an **Adopt** action.
- **Click a component** → it becomes the add-target; the canvas scopes to
  it; `＋ add resource` / ask the agent.
- **Reassign** → change a resource's component in the Inspector (or drag
  between branches) → writes a mapping override.
- **Unassigned** bucket collects untagged/unmapped resources to triage.

---

## Data flow

1. Discovery (agent skill) + tofu state populate the two sources.
2. `GET /api/inventory` merges + classifies → flat list.
3. `ResourceTree` groups it into the hierarchy.
4. Click a **resource** → Inspector (inspect / adopt); click a
   **component** → add-target.
5. Add (form or agent) authors into the blueprint sandbox with
   `Component=<name>` → appears under that component immediately.
6. "Commit to PR" promotes the component's sandbox resources into its
   `target_module`. Apply stays manual.

---

## Error handling & edge cases

- **No discovery manifest** → tree builds from managed state only (no
  unmanaged branch); a hint points to running discovery.
- **No tags + no override** → resource lands in **Unassigned** (never
  dropped).
- **Malformed `_hierarchy.json`** → overrides ignored; tree still builds
  from tags; surface a non-fatal warning.
- **Dedup conflicts** (same resource managed + discovered) → managed wins,
  shown once.
- **Reassign to a non-existent component** → create it on the fly (minimal
  component def) or reject with a clear message; spec picks **create on the
  fly** with `display_name` defaulted from the name.
- **Safety** — discovery and inventory are read-only; adds author HCL only;
  `apply` / `tofu import` stay manual/denied.

---

## Phasing (for the implementation plan)

1. **Inventory + tree** — `GET /api/inventory` (merge/dedup/classify from
   tags only) + hierarchical `ResourceTree` replacing the List tab.
   Read-only navigation works end to end.
2. **Mapping** — `_hierarchy.json` + CRUD + Inspector reassign control +
   Unassigned triage.
3. **Add-to-component** — `Component` tag stamping on add/adopt + canvas
   scoping + add-target banner + promote-to-module wiring.
4. **Layout polish** — four-region restructure, collapsible agent, retire
   `ResourceList` / `ExistingResourceTree`.

Each phase ships something usable; later phases layer on.

---

## Testing

- **Backend (pytest):** inventory merge + dedup (managed/unmanaged/both),
  classification precedence (override > tag > unassigned), hierarchy CRUD
  (set/clear override, create component), malformed-file tolerance, the
  `Component` tag stamp on write. All mock at the tofu/manifest boundary —
  no AWS needed.
- **Frontend:** tsc + eslint + `next build`; grouping logic exercised via
  the build + manual smoke (no FE unit harness today).
- **Manual smoke:** discover against Moto, confirm a tagged resource lands
  under its component, an untagged one lands in Unassigned, reassigning
  moves it, and adding to a component stamps the tag + shows it under the
  branch.

---

## Non-goals

- **Cross-account state aggregation** — the Account tier exists, but only
  the current account/region populate until multi-account is real.
- **Editing live state directly** — adds/edits flow config → PR → manual
  apply, never direct mutation.
- **Auto-creating components without a tag or explicit assignment** —
  untagged resources sit in Unassigned until a human classifies them.
- **A frontend unit-test harness** — out of scope; verification stays
  tsc/lint/build + manual.
