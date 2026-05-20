# DevEx Platform UI

A small web app for talking to a Claude agent about the OpenTofu plan and
clicking through individual resources (VPCs, subnets, S3 buckets, security
groups, etc.) to inspect their attributes.

```
┌─────────────────┬──────────────────────────────┬───────────────────────┐
│                 │                              │                       │
│   Chat (left)   │   Resource list (center)     │   Detail drawer       │
│                 │                              │   (right, on click)   │
│                 │                              │                       │
└─────────────────┴──────────────────────────────┴───────────────────────┘
```

- **Chat** runs a full Claude Agent SDK session with the same toolset
  Claude Code uses — Read, Glob, Grep, Bash, Edit, Write, WebFetch. Its
  cwd is this repo and it inherits this repo's `.claude/settings.json`,
  so the deny list (no `tofu apply`, no `tofu destroy`, no `tofu import`,
  no state mutations) applies to the chat agent just like it applies to
  Claude Code itself.
- **Resource list** shows everything in the configured `tofu_root` (default
  `live/dev`), grouped by type, with a filter box.
- **Detail drawer** opens when you click a row — it pretty-prints identity,
  type-specific fields (security-group rules, VPC CIDRs, S3 buckets), tags,
  and the raw attribute payload.

## Stack

- **`backend/`** — FastAPI (Python 3.12+, managed via [`uv`](https://docs.astral.sh/uv/)).
  Uses the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python)
  for chat (full Read/Edit/Bash toolset, scoped to the repo) and shells
  out to `tofu show -json` for the plan-list endpoint. Two routes:
  `POST /api/chat` (SSE), `GET /api/plan`.
- **`frontend/`** — Next.js 15 (App Router, Tailwind v4, TypeScript).
  Three-pane layout, hand-rolled SSE client (no Vercel AI SDK — our event
  shape is custom so we get richer tool-call rendering).

The frontend dev server proxies `/api/*` to the backend, so you can hit
`http://localhost:3000` and not think about ports.

## Setup (one-time)

```bash
# Backend deps
cd app/backend
uv sync

# Frontend deps already installed by create-next-app; if not:
cd ../frontend
npm install
```

You also need an Anthropic API key in the backend's environment:

```bash
cp app/backend/.env.example app/backend/.env
# Edit .env: set ANTHROPIC_API_KEY=sk-ant-...
```

The backend loads `.env` on startup via `python-dotenv`. Alternatively,
export `ANTHROPIC_API_KEY` in your shell before launching uvicorn.

## Run

Two terminals (or `tmux` panes).

**Terminal 1 — backend:**

```bash
cd app/backend
uv run uvicorn devex_app.main:app --reload --port 8088
```

Health check:

```bash
curl http://localhost:8088/api/health
# → {"ok": true, "tofu_root": "...", "model": "...", "anthropic_key_set": true}
```

**Terminal 2 — frontend:**

```bash
cd app/frontend
npm run dev
```

Open <http://localhost:3000>.

## Plan data source

The backend runs `tofu show -json` inside `live/dev/`. For that to return
anything interesting, you need state — i.e. you've applied at least once
against Moto:

```bash
# in a separate shell at the repo root
make local-up
source dev.local.env
make bootstrap-local
make init-dev-local
tofu -chdir=live/dev apply -auto-approve   # remember: applies are not pre-allowed for Claude — you run this
```

After that, hit "Refresh" in the resource list and the rendered state will
show up.

If you only want to see the UI without applying anything, the empty state
("No resources yet") is the expected result against a fresh Moto.

## Configuration

Backend, via env vars (or `.env`):

| Var | Default | Meaning |
|-----|---------|---------|
| `ANTHROPIC_API_KEY` | _(required for chat)_ | Anthropic API key |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Model used by the chat agent |
| `TOFU_ROOT` | `live/dev` | Path under repo root to run `tofu show` from |
| `REPO_ROOT` | auto | Absolute path to repo root (auto-derived if unset) |

Frontend, via env vars:

| Var | Default | Meaning |
|-----|---------|---------|
| `BACKEND_URL` | `http://localhost:8088` | Where `/api/*` rewrites go |

## Blueprint: adopt existing AWS resources

The Blueprint tab can adopt **existing, unmanaged** AWS resources (ClickOps
infra) under OpenTofu management, visually:

1. **Discover.** The left rail has an "existing (aws)" tree. Click *discover*
   (or the ↻ on a type) — this seeds a chat prompt that runs the
   `aws-resource-discovery` skill. The skill enumerates AWS via the
   **read-only** AWS API MCP and writes a manifest to
   `live/blueprint/_discovered.json`. The tree reads that manifest from the
   deterministic `GET /api/existing-resources` (no LLM in the serve path).
2. **Adopt.** Drag a tree row onto the canvas. The backend writes
   `live/blueprint/bp.<type>.<name>.tf` containing an `import { to, id }`
   block plus a thin `resource { }` body pre-filled from the resource's
   summary attributes. Adopted nodes show an **`imp`** badge.
3. **Edit / clean up.** The node opens in the existing schema-driven form.
   The drawer shows the import id and a *generate clean config* button that
   runs `tofu plan -generate-config-out` (`POST /api/blueprint/generate-config`)
   to replace the thin body with apply-clean HCL, preserving the import block.
4. **Preview + promote.** The plan-diff tab (root = blueprint) shows the
   change as `import` / `import_update`. *Commit to PR* promotes it through
   the usual module → PR → manual-apply path.

**Requirements:** the AWS API MCP must be enabled (it's wired in `.mcp.json`
as `awslabs.aws-api-mcp-server`, `READ_OPERATIONS_ONLY=true`; needs `uvx`).
It honors `AWS_ENDPOINT_URL_*`, so a `dev.local.env`-sourced shell discovers
against Moto and a vanilla shell discovers against real AWS. Discovery needs
the chat agent (`ANTHROPIC_API_KEY`); the serve/adopt/generate paths are
deterministic.

## Safety posture

The chat agent is a Claude Agent SDK session with `setting_sources=["project"]`,
which means it inherits this repo's `.claude/settings.json` deny rules:

- `tofu apply`, `tofu destroy`, `tofu state mv|rm|push`, `tofu force-unlock`,
  and `tofu import` — denied at the SDK layer. If the user asks for those,
  the agent is instructed to tell them to run it manually.
- The plan-list endpoint (`/api/plan`) only ever calls `tofu show -json` —
  read-only, no mutation path.

What the agent _can_ do: read any file in the repo, run bash, edit HCL,
run `tofu plan` / `tofu validate` / `tofu test`, grep, web-fetch.
`permission_mode="bypassPermissions"` skips interactive prompts (the UI
has none yet) but does **not** override the deny list above.

**Local dev only.** Don't expose the backend port publicly. The chat
endpoint can edit your repo and run shell commands as your user — same
authority Claude Code has when you launch it from your terminal.

## Known limits (v1)

- **State, not plan-diff.** Right now the list shows current state. Showing
  a pending `tofu plan -out=...` diff (creates / updates / destroys) is a
  natural next step — wire a saved planfile and parse it the same way.
- **No graph view.** The resource list is grouped by type; a node-edge
  graph (React Flow) is scaffolded as v2.
- **No auth.** Local dev only. Don't expose the backend port publicly —
  the chat endpoint sends arbitrary text to your Anthropic account.
- **Single user.** No multi-conversation history persisted on the server;
  state lives in the browser tab.
- **Stateless chat.** Conversation history is replayed as a single prompt
  per request. A per-session `ClaudeSDKClient` would let the SDK keep its
  own session state (cheaper, faster, multi-turn-aware) — a v3 swap.
