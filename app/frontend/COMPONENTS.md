# Component inventory

Reference of the existing components in `app/frontend/`, what each owns,
where state lives, and what data flows through. Companion to
[`DESIGN.md`](./DESIGN.md). Together they form the context to paste
into a [Claude Design](https://claude.ai/design) session before asking
for a redesign.

---

## Layout shell

**File:** `app/page.tsx`

The three-pane shell. Owns:

- `selected: Resource | null` — the row clicked in `ResourceList`; passed
  to `ResourceDrawer`.
- `refreshKey: number` — bumped on every chat tool result, signals
  `ResourceList` to refetch.
- `middleTab: "state" | "plan"` — which view the middle pane shows.

Renders `ChatPanel` (left), `ResourceList` or `PlanDiff` (middle, gated
by tab), `ResourceDrawer` (right). Each pane is `h-screen` and manages
its own scroll region internally.

---

## `ChatPanel`

**File:** `components/ChatPanel.tsx`

Left pane. Live chat with a Claude Agent SDK session running inside the
backend.

- **Data flow:**
  - Sends `messages` array via `streamChat()` (SSE).
  - Receives a typed event stream: `text` (token deltas), `tool_use`
    (agent invoking a tool), `tool_result` (tool outcome), `done`,
    `error`.
  - Each `tool_result` calls `onToolResult?.()` so the parent can refresh
    the resource list.
- **State (local):**
  - `messages: ChatMessage[]` — full conversation; replayed every send
    (no per-session SDK client today; that's a v3 roadmap item).
  - `input`, `busy`, `error`.
- **UI:**
  - Header (title + helper text).
  - Scrolling message list. Empty state suggests a starter prompt.
  - User messages: right-aligned `bg-accent text-white` bubbles.
  - Assistant messages: left-aligned `bg-muted border-border` bubbles.
  - Tool calls rendered as small chips above the assistant text:
    `🔧 tool_name label — summary`. Errors flip to red chip variant.
  - Composer: input + `Send` (or `Stop` while busy).

**Known pain points** (in order):

1. Tool-call chips are visually noisy and hard to scan when the agent
   does 5+ tool calls in a turn.
2. The "thinking…" placeholder (just `…`) is anemic — no sense of
   what the agent is doing.
3. No way to expand a tool call to see its full input/output. The
   `title` attribute on the chip shows raw JSON, but it's not
   discoverable.
4. No conversation history persisted — refresh loses everything.

---

## `ResourceList`

**File:** `components/ResourceList.tsx`

Middle pane, "State" tab. Renders the current OpenTofu state from
`tofu show -json`, grouped by resource type.

- **Data flow:**
  - Fetches `/api/plan` via `fetchPlan()` on mount and on `refreshKey`
    change.
  - Receives a `PlanResponse` with `groups: [{ type, resources[] }]`.
- **State (local):**
  - `plan: PlanResponse | null`
  - `error: string | null`, `loading: boolean`
  - `filter: string` — case-insensitive substring filter on `address`,
    `type`, `module`.
- **UI:**
  - Header: title + resource count + "Refresh" button.
  - Filter input below header.
  - Scrolling list. Each type is a `<section>` with a sticky header
    (`§ TYPE · N`) and a list of rows.
  - Row: monospaced address (truncated) + smaller module path.
  - Selected row: `bg-muted`. Hover: also `bg-muted`.
  - Empty state: "No resources yet" with a hint to run `make plan-dev`.
  - Error state: red border box.

**Known pain points:**

1. Rows are visually flat — no resource-type icon or color cue. Easy
   to lose your place in a long list.
2. Type group headers are tiny `text-[11px]` — when scrolling, they
   don't have enough hierarchy.
3. No sort. Always alphabetical by type. No way to see "everything in
   module X" except via the filter box.

---

## `PlanDiff` *(introduced via PR #11)*

**File:** `components/PlanDiff.tsx`

Middle pane, "Plan" tab. Renders pending changes from `tofu plan`.

- **Data flow:**
  - Fetches `/api/plan-diff` via `fetchPlanDiff()` on mount.
  - Receives `PlanDiffResponse` with `changes: ResourceChange[]` and
    `counts: Record<action_kind, n>`.
  - Aborts in-flight request if user re-triggers; `tofu plan` is slow.
- **State (local):**
  - `diff`, `error`, `loading` as `ResourceList`.
  - `expanded: Set<string>` — which change rows have their diff body
    open.
- **UI:**
  - Header: title + status line ("Running tofu plan…" or "1 update, 2
    create"). "Run plan" button.
  - Changes grouped by `action_kind`. Order: delete, replace, create,
    update, import_update, import, no-op, read.
  - Each change row:
    - Glyph + address (mono, truncated).
    - Sub-line: `id=…` for imports, "N attrs change" otherwise.
    - Click toggles a diff body below showing per-attribute `before` →
      `after` lines (red old, green new).
  - Empty state: "No pending changes." Error state: red box with raw
    plan stderr.

**Known pain points:**

1. The diff body is plain key/value pairs. For nested attributes (a
   `tags_all` map with 4 keys), the whole object is JSON-stringified
   — barely readable.
2. The status line ("1 update, 2 create") is small and easy to miss.
3. No filter, unlike `ResourceList`.

---

## `ResourceDrawer`

**File:** `components/ResourceDrawer.tsx`

Right pane. Shows attributes of the resource selected from
`ResourceList`. Tied to `selected` in the shell.

- **Data flow:**
  - Pure prop: `resource: Resource | null`.
  - No fetching; renders what's already in state from the list.
- **UI:**
  - Header: address (mono, truncated) + `type · mode · module`. Close
    button.
  - Body: vertical stack of sections. Always shows:
    - **Identity** — key/value grid of address, type, name, module,
      provider, mode.
    - **Type-specific section** when the type matches:
      - SG → Ingress + Egress rule cards.
      - VPC / subnet → Networking key/value (CIDR, AZ, public-IP toggle).
      - S3 → Bucket key/value (bucket, arn, region).
    - **Tags** — if `values.tags` is an object.
    - **Raw attributes** — JSON dump (`pre` block, mono, wraps).

**Known pain points** (highest leverage for redesign):

1. **The Raw attributes section is a debug dump.** It's there because
   the type-specific sections don't cover most resource types. For an
   IAM role, an aws_instance, an SG association, etc., 90% of the
   useful info lives in that JSON dump.
2. No visual hierarchy beyond section titles. Identity, type-specific,
   and Tags all look the same — three flat key/value tables.
3. No copy-to-clipboard on identity values (ARNs, IDs).
4. No way to "open in agent" — i.e., seed a chat message with
   "explain this resource" pre-filled.
5. The drawer is fixed-width (420px); for long ARNs it just wraps.
6. No before/after view when the drawer is wired to a plan-diff row.
   (Today the drawer only renders for state rows; plan-diff is
   inline-only.)

---

## Data shapes (for reference)

```ts
type Resource = {
  address: string;       // module.network.aws_vpc.this
  type: string;          // aws_vpc
  name: string;          // this
  module: string;        // module.network ("" for root)
  provider: string;
  mode: "managed" | "data";
  values: Record<string, unknown>;
};

type ResourceChange = {
  address: string;
  type: string;
  name: string;
  module: string;
  provider: string;
  mode: string;
  actions: string[];            // ["create"], ["update"], ["delete", "create"], ...
  action_kind: ActionKind;      // single-token category for UI grouping
  importing_id: string | null;  // set when an `import { }` resolves to this addr
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};
```

The redesign should **not** change these shapes — they're contracts
with the backend. Anything new should be derivable client-side.
