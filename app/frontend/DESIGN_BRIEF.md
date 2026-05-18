# Design brief — DevEx Platform UI

The prompt-ready brief for a [Claude Design](https://claude.ai/design)
session. Paste this (or link it) when starting a session and ask Claude
Design to produce variants for one focused area at a time. Don't ask
for a whole-app redesign in a single turn.

Companion reading:

- [`DESIGN.md`](./DESIGN.md) — the existing token/system reference.
- [`COMPONENTS.md`](./COMPONENTS.md) — what each component owns + known
  pain points.

---

## TL;DR

The DevEx Platform UI is a desktop, info-dense, local-dev tool for
inspecting an OpenTofu plan via chat (left), a resource/plan-diff list
(middle), and a detail drawer (right). It works. It's not delightful.

Help redesign **specific surfaces** to be more scannable, more
hierarchical, and more pleasant — without changing the data shapes or
the three-pane structure.

---

## Audience

- A platform/infra engineer using OpenTofu against AWS.
- Comfortable reading HCL, JSON, resource ARNs.
- Wants density and signal; doesn't want a marketing landing page.
- One developer per session — no team/multi-user UX yet.

---

## Constraints (please respect)

1. **Stack is fixed.** Next.js 15 App Router, Tailwind v4 (no
   `tailwind.config.ts`; uses `@theme inline` in `app/globals.css`),
   TypeScript strict. No new global runtime deps (no Framer Motion, no
   Radix, no Headless UI — at least not in v2).
2. **Three-pane shell stays.** Left ChatPanel (360px fixed), middle
   list (flex-1), right ResourceDrawer (420px fixed). Desktop-only.
3. **Existing tokens are the palette.** Six colors: background,
   foreground, muted, muted-foreground, border, accent (stone neutrals
   + amber accent). Status colors (emerald/amber/red/sky) are reused
   per-component. Don't introduce new theme colors.
4. **Type scale stays compact.** `text-sm`, `text-xs`, `text-[11px]`,
   `text-[10px]`. Nothing larger than `text-sm`.
5. **Mono for identity.** Resource addresses, attribute keys/values,
   IDs → `font-mono`. Prose → sans.
6. **No motion library.** OK to use Tailwind transitions (`transition-colors`,
   short transforms). No spring physics, no Lottie.
7. **Data shapes are contracts** — see `COMPONENTS.md` "Data shapes."
   You can derive new fields client-side, but `Resource`,
   `ResourceChange`, `ChatMessage` shapes shouldn't change.
8. **Accessibility:** keyboard-accessible, screen-reader-readable, but
   no specific WCAG target today. Don't break what's there.

---

## What's working

Don't redesign these unless asked:

- The three-pane layout itself.
- The empty/loading/error states (text-based, no spinners). Density.
- The amber accent as the single "primary action / selected state"
  signal.

---

## Pain points ranked by leverage

### 1. `ResourceDrawer` — biggest gap

Currently a flat dump of key/value tables plus a JSON raw-attributes
block at the bottom. For most resource types (anything outside SG /
VPC / S3), the JSON dump *is* the UI.

**Ask Claude Design for:**

- A hierarchical layout: identity at top, then a smart "primary"
  section per resource type (tags? rules? state?), then a collapsible
  "everything else" instead of the raw JSON dump.
- Inline copy-to-clipboard on identity values (ARN, IDs).
- A "ask the chat agent about this resource" CTA that seeds a chat
  message.
- Better long-string handling (ARNs, policies) — chunked, copyable,
  but not full-bleed wrapping that destroys the eye-line.

### 2. `PlanDiff` row + expanded diff body

The current row works. The expanded diff is just a table with two
lines per attribute (red old / green new), and nested attrs are JSON-
stringified.

**Ask Claude Design for:**

- A denser row: keep the action glyph + address; surface `+N -M`
  attribute counts as inline badges instead of a sub-line.
- An expanded body that handles nested objects (especially `tags`,
  `tags_all`) as proper inline diffs with per-key red/green markers.
- A summary chip at the top of the pane that shows the totals
  (`4 import · 1 update · 0 delete`).

### 3. `ChatPanel` tool-call rendering

Tool calls render as small chips inline with the assistant message.
When the agent runs 5+ tools in a turn, the chips become wallpaper.

**Ask Claude Design for:**

- A collapsible "thinking" / tool-call group above each assistant
  message. Collapsed: "Ran 6 tools." Expanded: per-tool summary.
- A way to see a tool's full input/output (today only `title`
  hover-text shows it).
- A nicer "thinking…" state — the agent has read/grep/bash; tell the
  user what's actually happening.

### 4. `ResourceList` row scannability

Long lists of `module.foo.aws_subnet.public[...]` all look the same.

**Ask Claude Design for:**

- A small left-side type indicator: monogram or color block keyed off
  the resource type (vpc, subnet, sg, ec2, s3, iam, etc.). Subtle —
  the address stays the focal point.
- A better sticky group header with a count and maybe a "collapse"
  control for huge groups.

### 5. Cross-pane integration

Today the panes are independent. Selecting a row only updates the
drawer. The chat doesn't know what's selected; the drawer doesn't
know if the selected resource is in the plan-diff.

**Ask Claude Design for:**

- A way to surface "this resource has pending changes" in
  `ResourceList` (a small dot or pill).
- A way to "send selected resource to chat" — i.e., chat picks up
  the selection as context.

---

## Output format Claude Design should produce

For each session, ask for:

1. **HTML + Tailwind v4 markup** matching the tokens in `DESIGN.md`.
   This is what gets ported to React.
2. **At least 2 variants** per surface, with one-sentence rationale
   for each.
3. **A static asset URL** (Claude Design exports as a URL) for
   review/share before we port.

Ask Claude Design **not** to:

- Introduce new global colors.
- Add a header/footer/logo bar.
- Add motion or spinners.
- Use rounded-lg+ corners (too soft for this density).
- Produce a "marketing-style" hero.

---

## Working order

A reasonable session plan:

1. **Session 1: `ResourceDrawer`** — biggest pain, most leverage.
2. **Session 2: `PlanDiff` row + expanded body** — recent feature,
   easier to iterate on while it's fresh.
3. **Session 3: `ChatPanel` tool-call rendering**.
4. **Session 4: `ResourceList` row + group header**.
5. **Session 5: cross-pane signals** (selected-in-chat, has-changes
   dot).

After each session, the chosen variant gets ported back to React in a
single small PR. Don't let multiple sessions stack up without porting
between them — visual debt compounds fast.
