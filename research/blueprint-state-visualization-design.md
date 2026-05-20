# Blueprint state visualization + structural composition — design

Design pass for two related asks on the Blueprint canvas:

1. **See all existing resources from live state** on the canvas, not
   just resources the canvas authored.
2. **Navigate the resources and their connections**, and organize them
   by a **structural composition model: account / region / team**.

Ask (1) is mostly buildable on existing endpoints. Ask (2) is a
platform-architecture decision that needs defining before any UI code —
hence this doc. **Status: design only, no implementation yet.**

---

## Where we are today

The Blueprint canvas (`app/frontend/components/BlueprintCanvas.tsx`)
renders resources the *canvas authored* — files at
`live/blueprint/bp.<type>.<name>.tf`, read back via
`GET /api/blueprint/resources`. It can drag/drop, edit attributes +
nested blocks, derive dependency edges from HCL references, auto-layout,
and round-trip.

Separately, the **List** and **Plan** tabs read *live state* from a
deployed workspace (`GET /api/plan` → `tofu show -json`,
`GET /api/plan-diff` → `tofu plan`). Those already parse module
structure and resource attributes. So the data to render existing
state on a canvas mostly exists; it's a rendering + model question, not
a new-data-source question.

---

## Ask 1: render live state on the canvas

### What's needed

- A read-only canvas mode that takes the parsed state from `/api/plan`
  (resources + module hierarchy + attribute values) and renders nodes
  + edges, reusing the existing `ResourceNode` + family-color system.
- Dependency edges: state JSON has `depends_on` and resolved attribute
  references. We already derive edges from `${...}` interpolations for
  blueprint HCL; for *applied state* the dependency graph is richer —
  `tofu graph` emits the full DAG, or we walk `resource_changes` /
  `values.root_module` for `depends_on` + reference expressions.
- Read-only affordance: state nodes aren't editable through the
  blueprint form (they're deployed reality). Clicking one shows the
  existing ResourceDrawer (attributes, tags, raw) — not the
  blueprint edit form. This keeps "what's deployed" and "what I'm
  authoring" visually + behaviorally distinct.

### Open question: one canvas or two?

- **Option A — separate "state" canvas tab.** A new middle-pane tab
  ("state map") renders deployed reality; the existing "blueprint" tab
  stays authoring-only. Clean separation, no mode confusion.
- **Option B — unified canvas with a layer toggle.** One canvas; a
  toggle overlays state nodes (read-only, muted) under blueprint nodes
  (editable). Powerful for "import this existing resource into my
  blueprint" flows, but more complex and easy to muddle.

**Recommendation:** start with Option A (separate tab). It ships the
visualization without entangling it with the authoring model. Option B
becomes attractive later if we add a "blueprint adopts existing
resource" flow (which overlaps with the `opentofu-aws-import` skill).

### Effort

Medium. The renderer is mostly a reuse of `BlueprintCanvas`'s node/edge
machinery + a new `/api/state-graph` (or extend `/api/plan`) that emits
nodes + edges + module grouping. No new data source.

---

## Ask 2: structural composition (account / region / team)

This is the part that needs defining. "Group resources by account /
region / team" implies a **dimensional model** the platform doesn't
have yet. The questions below need answers before code.

### The core modeling question

A resource's place in the composition is determined by **where its
state lives** and **how it's tagged / named**. Today this repo has:

- One state backend per workspace (`bootstrap/` creates S3 + DynamoDB).
- `live/dev/` as the only deployed workspace.
- `default_tags` carrying `Project` / `Environment` / `ManagedBy`.

For account/region/team grouping to be meaningful, we need to decide
where each dimension *comes from*:

| Dimension | Candidate sources |
|---|---|
| **Account** | AWS account ID (from `aws_caller_identity` / provider config) · workspace → account mapping · a tag |
| **Region** | provider `region` · resource's `region`/`availability_zone` attribute · workspace config |
| **Team** | a `Team` tag (not currently in `default_tags`) · the repo path (`live/<team>/...`) · a CODEOWNERS-style mapping |

**None of these are reliably present today.** `Team` isn't in
`default_tags`. There's only one account + region in play. So step zero
is **deciding the canonical source of each dimension** and making it
consistently available.

### Proposed canonical model

1. **Account** = the AWS account a workspace's state targets. Derive
   from the workspace's backend config / provider, surfaced as
   workspace metadata. (Aligns with the future multi-account migration
   — see `research/migration-playbook-multi-account.md`.)
2. **Region** = provider region for the workspace, with per-resource
   region as a secondary grouping where a resource is regional.
3. **Team** = a new required `Team` entry in each workspace's
   `default_tags`. Make it a convention enforced by checkov/policy:
   every resource carries `Team`. This is the cleanest source — it's
   on every resource, queryable from state, and doesn't depend on
   repo layout.

This implies a small **platform change** independent of the UI: add
`Team` to the `default_tags` contract (CLAUDE.md HCL conventions
already mandate `Project`/`Environment`/`ManagedBy` — add `Team`).

### How the canvas would render it

Once the three dimensions are reliably on every resource:

- **Swimlanes / frames.** React Flow supports parent nodes (group
  frames). Render account as the outermost frame, region as a nested
  frame, team as a color or sub-frame. Resources sit inside their
  (account, region) frame, tinted by team.
- **Collapsible grouping.** Let the user pick the primary grouping
  dimension (group by account, or by team, or by region) and re-flow.
  Dagre already does the within-group layout; the grouping dimension
  decides the frames.
- **Cross-group edges.** Dependencies that cross account/region
  boundaries (rare but real — e.g., cross-account IAM) render as
  distinct edges so the blast radius of a cross-boundary dependency is
  visible.

### Open questions to resolve before building

1. **Is `Team` a tag we're willing to mandate?** If yes, it's the
   cleanest dimension source. If teams resist tagging, we fall back to
   repo-path-derived team (`live/<team>/<env>/`), which couples team to
   directory structure.
2. **Multi-account is future (per the migration playbook).** Today
   there's one account. Do we build the account dimension now (mostly
   a no-op with one account) or defer until multi-account is real?
   Building the model now means the canvas is ready; deferring avoids
   speculative structure.
3. **Does grouping live in the backend or frontend?** The backend
   could emit pre-grouped data (`{account: {region: {team: [nodes]}}}`)
   or emit flat nodes + dimension tags and let the frontend group. Flat
   + frontend-group is more flexible (re-group without a round-trip).
4. **Region granularity.** Group by region, or by availability zone?
   AZ is finer but noisier. Probably region, with AZ as a node-level
   label.

---

## Recommended sequencing

1. **Platform prerequisite:** add `Team` to the `default_tags`
   contract (CLAUDE.md + each `live/*` provider block + a checkov
   rule). Small, unblocks the team dimension cleanly. *(Decision
   needed: are we mandating the tag?)*
2. **Ship Ask 1** (state-on-canvas, read-only, separate tab) — it's
   independently useful and exercises the renderer.
3. **Layer in grouping** once the dimension sources are reliable:
   start with a single grouping dimension (team, since it's the
   most-requested), add account + region as multi-account becomes real.
4. **Revisit unified canvas (Option B)** only if a "blueprint adopts
   existing state" flow materializes — at which point this overlaps
   with `opentofu-aws-import`.

## Non-goals (for now)

- Editing live state through the canvas (state is deployed reality;
  edits flow through the blueprint → PR → apply path, not direct
  mutation).
- Cross-account graph rendering before multi-account state actually
  exists.
- Auto-discovering team ownership without an explicit `Team` tag or
  path convention — too much guessing.
