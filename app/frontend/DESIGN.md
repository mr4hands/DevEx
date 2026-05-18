# Design tokens

The frontend's design tokens, the rationale behind them, and the rules
Claude Design (or any other generator) should respect when producing new
components for this app.

This doc is **descriptive of what exists**, not aspirational. It's meant
to be pasted (or linked) into a [Claude Design](https://claude.ai/design)
session so the tool produces components that drop into the existing
codebase without restyling.

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router, Turbopack) |
| Styling | Tailwind CSS v4 (no PostCSS plugins; uses `@theme inline`) |
| Type system | TypeScript strict |
| Fonts | `Geist` (sans) and `Geist Mono` (mono), loaded via `next/font/google` |
| Theme | Light + dark via `prefers-color-scheme` (no manual toggle yet) |
| Icons | None today — text glyphs (`✕`, `+`, `~`, `→`) only |

**Important:** the project uses Tailwind v4's CSS-first theming
(`@theme inline { ... }` in `app/globals.css`). There is **no**
`tailwind.config.ts`. New utilities should match the existing tokens or
be introduced via the same `@theme inline` block.

---

## Color tokens

Defined in `app/globals.css`. Light mode is default; dark mode kicks in
on `prefers-color-scheme: dark`. Tailwind v4 exposes them as
`bg-{token}`, `text-{token}`, `border-{token}`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `background` | `#fafaf9` | `#0c0a09` | Page background. |
| `foreground` | `#1c1917` | `#f5f5f4` | Primary text. |
| `muted` | `#f5f5f4` | `#1c1917` | Subtle surfaces — code blocks, expanded diff bodies, chat bubbles. |
| `muted-foreground` | `#57534e` | `#a8a29e` | Secondary text — descriptions, metadata. |
| `border` | `#e7e5e4` | `#292524` | All borders + dividers. |
| `accent` | `#d97706` | `#f59e0b` | Brand orange. Used sparingly: primary action button background, focus rings, active tab indicator. |

The palette is **stone**-family (warm grays) for neutrals and **amber**
for the accent. Picked to feel adjacent to OpenTofu's visual identity
without copying it.

### Status colors

These are **not** in the theme; they're applied per-component with
explicit Tailwind classes so dark-mode pairs are always intentional:

| Intent | Light | Dark |
|---|---|---|
| Success / create | `text-emerald-600 bg-emerald-50` | `text-emerald-400 bg-emerald-950` |
| Warning / update | `text-amber-600 bg-amber-50` | `text-amber-400 bg-amber-950` |
| Danger / destroy | `text-red-600 bg-red-50` | `text-red-400 bg-red-950` |
| Replace | `text-orange-600` | `text-orange-400` |
| Info / import | `text-sky-600` | `text-sky-400` |
| Error border | `border-red-200` | `border-red-900` |

Any new status surface should reuse these pairings.

---

## Typography

| Variable | Family | Notable use |
|---|---|---|
| `--font-sans` (Geist) | Inter-adjacent geometric sans | Body, headers, controls. |
| `--font-mono` (Geist Mono) | Monospaced | Resource addresses, attribute keys, attribute values, code blocks. |

Type scale used today (Tailwind v4 defaults, no overrides):

| Class | Pixel approx | Use |
|---|---|---|
| `text-sm` | 14px | Body, chat messages, drawer content. |
| `text-xs` | 12px | Descriptions, secondary labels, button text, monospace addresses. |
| `text-[11px]` (arbitrary) | 11px | Sub-labels, sticky group headers, tool-call chips. |
| `text-[10px]` (arbitrary) | 10px | Smallest chips — used only on tool-call tags in chat. |

`uppercase tracking-wide` is used on group headers (`§ TYPE · N`) and
section titles in the drawer. Otherwise body case is sentence case.

**Density bias:** this is an info-dense tool, not marketing. Prefer
`text-xs`/`text-[11px]` for metadata, `text-sm` for primary content. No
hero text larger than `text-sm`.

---

## Layout

```
┌─────────────────────┬──────────────────────────┬─────────────────────────┐
│ ChatPanel           │ ResourceList | PlanDiff  │ ResourceDrawer          │
│ width: 360px (fixed)│ flex-1 (fills)           │ width: 420px (fixed)    │
│ border-r            │ —                        │ border-l                │
└─────────────────────┴──────────────────────────┴─────────────────────────┘
```

- The three panes are siblings in a horizontal `flex` (`page.tsx`). Each
  pane is `h-screen` and manages its own internal `overflow-y-auto`
  region.
- All scrolling lives inside the middle/inner content of each pane;
  pane headers and chat composer stay pinned.
- The middle pane has a tab bar (`State` / `Plan`) above its content.
- **Mobile/responsive is not in scope yet.** The app is desktop-only
  local-dev today. Any redesign should keep the three-pane structure as
  the default and treat narrow-viewport collapse as a stretch goal.

### Spacing rhythm

| Spacing | Where |
|---|---|
| `px-4 py-3` | Pane headers (top of each column). |
| `px-4 py-2` | Resource list rows, filter row. |
| `px-3 py-2` | Form controls (chat input, send button). |
| `p-3` | Chat composer (border-t row). |
| `gap-1` to `gap-2` | Inline element clusters. |

Borders are always `border-border` (1px). Rounded corners are `rounded`
(default) or `rounded-full` for chips. Never use `rounded-lg` or
`rounded-xl` — too soft for the info density.

---

## Interaction patterns

- **Buttons:**
  - Primary action: `bg-accent text-white` (e.g., Send).
  - Secondary action: `bg-muted border-border` (e.g., Refresh, Run plan).
  - Disabled: `disabled:opacity-50`.
- **Inputs:** `border-border bg-background focus:border-accent` — accent
  ring is the only focus indicator today.
- **Selected row:** `bg-muted`. Hover state is also `hover:bg-muted` —
  the distinction is subtle, fine for dense lists.
- **Sticky group headers:** `sticky top-0 bg-background/95 backdrop-blur`.
- **Truncation:** every address/identity is `truncate` or `break-all`.
  Don't let long IDs blow out a row.

---

## What "fits the system" means

When proposing a new component or redesign:

1. **Reuse the six color tokens** above for any neutral surface. New
   colors require justification.
2. **Stick to the existing type scale** (`text-sm`, `text-xs`,
   `text-[11px]`). If you reach for `text-base` or larger, you're
   probably building for the wrong density.
3. **Mono for identity, sans for prose.** Resource addresses, attribute
   keys, IDs → mono. Descriptions, headings → sans.
4. **One accent per screen.** The accent orange is for *the* primary
   action or *the* selected/active state. Multiple accent-orange
   surfaces compete.
5. **Status colors live outside the theme.** Use the explicit
   emerald/amber/red/sky pairs in the table above; don't extend the
   theme palette without discussion.
6. **No motion/animation today.** No transitions beyond Tailwind's
   `transition-colors` on hover. No spinners — text "…" or "loading…"
   is the loading affordance.
