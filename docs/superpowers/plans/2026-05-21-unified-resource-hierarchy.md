# Unified Resource Hierarchy — Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foundational increment of the unified navigator — a `GET /api/inventory` that merges managed (tofu state) + unmanaged (AWS discovery) resources and classifies each by Account/Region/Component (from tags), plus a hierarchical `ResourceTree` that replaces the flat List tab.

**Architecture:** Backend produces a flat, classified inventory (merge + dedup by id, component from `Component`/`Service`/`Team` tag or `Unassigned`); the frontend groups it into Account → Region → Component → type → resource and renders it where the List tab was. Selecting a resource reuses the existing `ResourceDrawer`.

**Tech Stack:** FastAPI + pydantic (pytest + httpx `TestClient`), Next.js 16 + React 19 (verified via tsc/eslint/build).

**Reference spec:** `docs/superpowers/specs/2026-05-21-unified-resource-hierarchy-design.md`

**Scope note:** This is Phase 1 of 4 (inventory + tree). Phases 2 (mapping CRUD + reassign), 3 (add-to-component + canvas scoping), 4 (four-region layout + retire old components) get their own plans after this lands. Component classification here is **tag-only**; the `_hierarchy.json` override layer arrives in Phase 2 (this plan reads overrides if the file happens to exist, but doesn't write it).

**Conventions:** backend pkg `devex_app` (editable); run `./.venv/bin/python -m pytest` from `app/backend`. Tests override settings via env + `get_settings.cache_clear()` (see `tests/conftest.py`). Frontend `/api` is proxied; CORS allows GET/POST.

---

## Task 1: Inventory classification helpers (pure functions)

**Files:**
- Create: `app/backend/src/devex_app/inventory.py`
- Test: `app/backend/tests/test_inventory_classify.py`

- [ ] **Step 1: Write the failing tests**

`app/backend/tests/test_inventory_classify.py`:

```python
from __future__ import annotations

from devex_app.inventory import account_region, classify_component


def test_classify_prefers_override():
    comp, src = classify_component(
        {"Component": "frontend"}, "aws_s3_bucket.x", {"aws_s3_bucket.x": "solr"}
    )
    assert comp == "solr" and src == "override"


def test_classify_falls_back_to_tag_precedence():
    assert classify_component({"Service": "jenkins"}, "a", {}) == ("jenkins", "tag")
    # Component wins over Service when both present.
    assert classify_component(
        {"Component": "solr", "Service": "x"}, "a", {}
    ) == ("solr", "tag")


def test_classify_unassigned_when_nothing_matches():
    assert classify_component({}, "a", {}) == ("Unassigned", "unassigned")


def test_account_region_parses_arn():
    acct, region = account_region(
        {"arn": "arn:aws:ec2:us-east-1:123456789012:instance/i-0ab"}
    )
    assert acct == "123456789012" and region == "us-east-1"


def test_account_region_falls_back_to_region_attr():
    # S3 arns carry no account/region; fall back to the region attribute.
    acct, region = account_region(
        {"arn": "arn:aws:s3:::my-bucket", "region": "eu-west-1"}
    )
    assert region == "eu-west-1" and acct == "unknown"


def test_account_region_unknown_when_absent():
    assert account_region({}) == ("unknown", "unknown")
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_inventory_classify.py -v`
Expected: FAIL — `No module named 'devex_app.inventory'`.

- [ ] **Step 3: Implement the helpers**

`app/backend/src/devex_app/inventory.py`:

```python
"""Pure classification helpers for the unified resource inventory.

Kept side-effect-free so they're trivially unit-testable; the route in
`routes/inventory.py` wires them to the live data sources.
"""

from __future__ import annotations

import re
from typing import Any

# arn:aws:<service>:<region>:<account>:<resource>. region/account are empty
# for some services (e.g. S3, IAM), so callers fall back to attributes.
_ARN_RE = re.compile(
    r"^arn:aws[^:]*:[^:]*:(?P<region>[^:]*):(?P<account>[^:]*):"
)

# Tag keys checked, in order, to infer a resource's component.
COMPONENT_TAG_KEYS = ("Component", "Service", "Team")


def classify_component(
    tags: dict[str, Any],
    address: str,
    overrides: dict[str, str],
) -> tuple[str, str]:
    """Return (component, source). Override wins, then the first present of
    COMPONENT_TAG_KEYS, else ("Unassigned", "unassigned")."""
    if address in overrides:
        return overrides[address], "override"
    for key in COMPONENT_TAG_KEYS:
        value = tags.get(key)
        if value:
            return str(value), "tag"
    return "Unassigned", "unassigned"


def _region_from_values(values: dict[str, Any]) -> str:
    region = values.get("region")
    if isinstance(region, str) and region:
        return region
    az = values.get("availability_zone")
    if isinstance(az, str) and len(az) > 1 and az[-1].isalpha():
        return az[:-1]
    return "unknown"


def account_region(values: dict[str, Any]) -> tuple[str, str]:
    """Best-effort (account, region) for a resource. Parses the arn when it
    carries them; otherwise falls back to the region/az attribute and an
    "unknown" account."""
    arn = values.get("arn")
    region = _region_from_values(values)
    account = "unknown"
    if isinstance(arn, str):
        m = _ARN_RE.match(arn)
        if m:
            if m.group("account"):
                account = m.group("account")
            if m.group("region"):
                region = m.group("region")
    return account, region
```

- [ ] **Step 4: Run to verify pass**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_inventory_classify.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/backend/src/devex_app/inventory.py app/backend/tests/test_inventory_classify.py
git commit -m "feat(app): inventory classification helpers (component, account/region)"
```

---

## Task 2: `GET /api/inventory` (merge managed + unmanaged)

**Files:**
- Create: `app/backend/src/devex_app/routes/inventory.py`
- Modify: `app/backend/src/devex_app/main.py`
- Test: `app/backend/tests/test_inventory_route.py`

- [ ] **Step 1: Write the failing tests**

`app/backend/tests/test_inventory_route.py`:

```python
from __future__ import annotations

import json

import devex_app.routes.inventory as inv
from devex_app.tofu import Resource


def _managed(monkeypatch, resources):
    monkeypatch.setattr(inv, "show_state", lambda root: {"ok": True})
    monkeypatch.setattr(inv, "resources_from_state", lambda state: resources)


def test_inventory_merges_and_classifies(client, blueprint_env, monkeypatch):
    _managed(
        monkeypatch,
        [
            Resource(
                address="aws_instance.solr_1",
                type="aws_instance",
                name="solr_1",
                module="",
                provider="aws",
                mode="managed",
                values={
                    "id": "i-0ab",
                    "arn": "arn:aws:ec2:us-east-1:123456789012:instance/i-0ab",
                    "tags": {"Component": "solr"},
                },
            )
        ],
    )
    # An unmanaged bucket in the discovery manifest.
    (blueprint_env / "_discovered.json").write_text(
        json.dumps(
            {
                "groups": [
                    {
                        "type": "aws_s3_bucket",
                        "resources": [
                            {
                                "address": "aws_s3_bucket.old",
                                "type": "aws_s3_bucket",
                                "name": "old",
                                "import_id": "old-bucket",
                                "summary_attributes": {"arn": "arn:aws:s3:::old-bucket"},
                            }
                        ],
                    }
                ]
            }
        )
    )
    res = client.get("/api/inventory")
    assert res.status_code == 200
    items = {r["address"]: r for r in res.json()["resources"]}
    assert items["aws_instance.solr_1"]["managed"] is True
    assert items["aws_instance.solr_1"]["component"] == "solr"
    assert items["aws_instance.solr_1"]["account"] == "123456789012"
    assert items["aws_instance.solr_1"]["region"] == "us-east-1"
    assert items["aws_s3_bucket.old"]["managed"] is False
    assert items["aws_s3_bucket.old"]["component"] == "Unassigned"


def test_inventory_dedups_managed_over_unmanaged(client, blueprint_env, monkeypatch):
    # Same resource id appears in state AND discovery — managed wins, once.
    _managed(
        monkeypatch,
        [
            Resource(
                address="aws_s3_bucket.logs",
                type="aws_s3_bucket",
                name="logs",
                module="",
                provider="aws",
                mode="managed",
                values={"id": "acme-logs", "arn": "arn:aws:s3:::acme-logs", "tags": {}},
            )
        ],
    )
    (blueprint_env / "_discovered.json").write_text(
        json.dumps(
            {
                "groups": [
                    {
                        "type": "aws_s3_bucket",
                        "resources": [
                            {
                                "address": "aws_s3_bucket.logs",
                                "type": "aws_s3_bucket",
                                "name": "logs",
                                "import_id": "acme-logs",
                                "summary_attributes": {},
                            }
                        ],
                    }
                ]
            }
        )
    )
    res = client.get("/api/inventory")
    rows = [r for r in res.json()["resources"] if r["id"] == "acme-logs"]
    assert len(rows) == 1 and rows[0]["managed"] is True


def test_inventory_survives_no_state(client, blueprint_env, monkeypatch):
    # tofu show failing (no workspace) must not 500 — managed list empty.
    from devex_app.tofu import TofuError

    def boom(root):
        raise TofuError("no state")

    monkeypatch.setattr(inv, "show_state", boom)
    res = client.get("/api/inventory")
    assert res.status_code == 200
    assert res.json()["resources"] == []
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_inventory_route.py -v`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Implement the route**

`app/backend/src/devex_app/routes/inventory.py`:

```python
"""Unified inventory route.

`GET /api/inventory` merges managed resources (tofu state) with unmanaged
resources (the AWS discovery manifest), dedups by id, and classifies each
by account/region/component. Returns a flat list — the frontend groups it
into the Account -> Region -> Component -> type -> resource tree.
Read-only and deterministic.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter

from ..inventory import account_region, classify_component
from ..settings import get_settings
from ..tofu import TofuError, resources_from_state, show_state

router = APIRouter()

_MANIFEST = "_discovered.json"
_HIERARCHY = "_hierarchy.json"


def _load_json(path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


@router.get("/inventory")
def inventory() -> dict[str, Any]:
    settings = get_settings()

    hierarchy = _load_json(settings.blueprint_root / _HIERARCHY)
    overrides: dict[str, str] = hierarchy.get("overrides") or {}
    components: dict[str, Any] = hierarchy.get("components") or {}

    items: dict[str, dict[str, Any]] = {}

    # Managed resources from tofu state — full attributes.
    try:
        managed = resources_from_state(show_state(settings.tofu_root))
    except TofuError:
        managed = []
    for r in managed:
        tags = r.values.get("tags") or {}
        component, source = classify_component(tags, r.address, overrides)
        account, region = account_region(r.values)
        key = r.values.get("id") or r.values.get("arn") or r.address
        items[key] = {
            "address": r.address,
            "type": r.type,
            "name": r.name,
            "id": r.values.get("id"),
            "arn": r.values.get("arn"),
            "account": account,
            "region": region,
            "managed": True,
            "component": component,
            "component_source": source,
            "tags": tags,
            "values": r.values,
        }

    # Unmanaged resources from the discovery manifest.
    manifest = _load_json(settings.blueprint_root / _MANIFEST)
    for group in manifest.get("groups") or []:
        for res in group.get("resources") or []:
            summary = res.get("summary_attributes") or {}
            key = res.get("import_id") or summary.get("arn") or res.get("address")
            if key in items:
                continue  # managed wins
            tags = summary.get("tags") or {}
            address = res.get("address") or f"{res.get('type')}.{res.get('name')}"
            component, source = classify_component(tags, address, overrides)
            account, region = account_region(summary)
            items[key] = {
                "address": address,
                "type": res.get("type"),
                "name": res.get("name"),
                "id": res.get("import_id"),
                "arn": summary.get("arn"),
                "account": account,
                "region": region,
                "managed": False,
                "component": component,
                "component_source": source,
                "tags": tags,
                "values": summary,
            }

    return {"resources": list(items.values()), "components": components}
```

- [ ] **Step 4: Register the router**

In `app/backend/src/devex_app/main.py`, change the import to
`from .routes import blueprint, chat, existing, inventory, plan` and add
after the existing include: `app.include_router(inventory.router, prefix="/api")`.

- [ ] **Step 5: Run to verify pass**

Run: `cd app/backend && ./.venv/bin/python -m pytest tests/test_inventory_route.py -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Full backend suite + ruff**

Run: `cd app/backend && ./.venv/bin/python -m pytest && ./.venv/bin/ruff check src/devex_app/inventory.py src/devex_app/routes/inventory.py tests`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add app/backend/src/devex_app/routes/inventory.py app/backend/src/devex_app/main.py app/backend/tests/test_inventory_route.py
git commit -m "feat(app): GET /api/inventory merges managed + unmanaged resources"
```

---

## Task 3: Frontend inventory types + client

**Files:**
- Modify: `app/frontend/lib/types.ts`
- Modify: `app/frontend/lib/api.ts`

- [ ] **Step 1: Add types**

Append to `app/frontend/lib/types.ts`:

```ts
export type InventoryResource = {
  address: string;
  type: string;
  name: string;
  id: string | null;
  arn: string | null;
  account: string;
  region: string;
  managed: boolean;
  component: string;
  component_source: "tag" | "override" | "unassigned" | string;
  tags: Record<string, unknown>;
  values: Record<string, unknown>;
};

export type InventoryResponse = {
  resources: InventoryResource[];
  components: Record<string, { display_name?: string; target_module?: string }>;
};
```

- [ ] **Step 2: Add the client function**

In `app/frontend/lib/api.ts`, add `InventoryResponse` to the type-import
block, then append:

```ts
/** Unified resource inventory (managed + unmanaged), classified by
 *  account/region/component. The tree groups this client-side. */
export async function fetchInventory(
  signal?: AbortSignal,
): Promise<InventoryResponse> {
  const res = await fetch("/api/inventory", { cache: "no-store", signal });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/inventory failed (${res.status}): ${text}`);
  }
  return res.json();
}
```

- [ ] **Step 3: Typecheck**

Run: `cd app/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/frontend/lib/types.ts app/frontend/lib/api.ts
git commit -m "feat(app): frontend types + client for /api/inventory"
```

---

## Task 4: `ResourceTree` component (hierarchical grouping)

**Files:**
- Create: `app/frontend/components/ResourceTree.tsx`

- [ ] **Step 1: Create the component**

`app/frontend/components/ResourceTree.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchInventory } from "@/lib/api";
import { FAMILY_CLASSES, familyOf } from "@/lib/resourceFamilies";
import type { InventoryResource, Resource } from "@/lib/types";

/** Builds the nested Account -> Region -> Component -> type -> resource
 *  structure from the flat inventory. Unassigned sorts last. */
type TypeGroup = { type: string; resources: InventoryResource[] };
type ComponentGroup = { component: string; types: TypeGroup[] };
type RegionGroup = { region: string; components: ComponentGroup[] };
type AccountGroup = { account: string; regions: RegionGroup[] };

function groupInventory(items: InventoryResource[]): AccountGroup[] {
  const byKey = <T,>(arr: T[], key: (t: T) => string) => {
    const m = new Map<string, T[]>();
    for (const x of arr) {
      const k = key(x as T);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(x as T);
    }
    return m;
  };
  const sortKeys = (keys: string[]) =>
    keys.sort((a, b) =>
      a === "Unassigned" ? 1 : b === "Unassigned" ? -1 : a.localeCompare(b),
    );

  const accounts: AccountGroup[] = [];
  const byAccount = byKey(items, (r) => r.account);
  for (const account of sortKeys([...byAccount.keys()])) {
    const regions: RegionGroup[] = [];
    const byRegion = byKey(byAccount.get(account)!, (r) => r.region);
    for (const region of sortKeys([...byRegion.keys()])) {
      const components: ComponentGroup[] = [];
      const byComp = byKey(byRegion.get(region)!, (r) => r.component);
      for (const component of sortKeys([...byComp.keys()])) {
        const types: TypeGroup[] = [];
        const byType = byKey(byComp.get(component)!, (r) => r.type);
        for (const type of [...byType.keys()].sort()) {
          types.push({ type, resources: byType.get(type)! });
        }
        components.push({ component, types });
      }
      regions.push({ region, components });
    }
    accounts.push({ account, regions });
  }
  return accounts;
}

/** Map an inventory item to the Resource shape the drawer expects. */
function toResource(r: InventoryResource): Resource {
  return {
    address: r.address,
    type: r.type,
    name: r.name,
    module: "",
    mode: r.managed ? "managed" : "unmanaged",
    provider: "",
    values: r.values,
  };
}

export function ResourceTree({
  selected,
  onSelect,
  refreshKey,
}: {
  selected: Resource | null;
  onSelect: (r: Resource) => void;
  refreshKey?: number;
}) {
  const [items, setItems] = useState<InventoryResource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchInventory(signal);
      setItems(res.resources);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(ac.signal);
    return () => ac.abort();
  }, [load, refreshKey]);

  const tree = useMemo(() => groupInventory(items), [items]);
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-3 h-8 border-b border-border text-[11px] shrink-0">
        <span className="text-muted-foreground">
          {loading ? "…" : `${items.length} resources`}
        </span>
        <button
          type="button"
          className="px-1.5 h-5 rounded-sm font-mono text-[10px] text-muted-foreground hover:bg-muted"
          onClick={() => load()}
          disabled={loading}
        >
          refresh
        </button>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 text-[11px]">
        {error && (
          <p className="m-2 text-red-600 dark:text-red-400 break-words">{error}</p>
        )}
        {!error && items.length === 0 && !loading && (
          <p className="m-2 text-muted-foreground">No resources found.</p>
        )}
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
                {reg.components.map((comp) => (
                  <TreeBranch
                    key={comp.component}
                    id={`${acct.account}/${reg.region}/c:${comp.component}`}
                    label={comp.component}
                    kind="component"
                    collapsed={collapsed}
                    onToggle={toggle}
                  >
                    {comp.types.map((tg) => (
                      <TreeBranch
                        key={tg.type}
                        id={`${acct.account}/${reg.region}/${comp.component}/t:${tg.type}`}
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
                            onSelect={() => onSelect(toResource(r))}
                          />
                        ))}
                      </TreeBranch>
                    ))}
                  </TreeBranch>
                ))}
              </TreeBranch>
            ))}
          </TreeBranch>
        ))}
      </div>
    </div>
  );
}

function TreeBranch({
  id,
  label,
  kind,
  collapsed,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  kind: "account" | "region" | "component" | "type";
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  const isCollapsed = collapsed.has(id);
  const indent = { account: 0, region: 12, component: 24, type: 36 }[kind];
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(id)}
        style={{ paddingLeft: indent + 8 }}
        className="w-full flex items-center gap-1.5 h-6 pr-2 text-left hover:bg-muted border-b border-border font-mono"
      >
        <span className={`transition-transform ${isCollapsed ? "" : "rotate-90"}`}>›</span>
        <span className={kind === "component" ? "font-semibold" : ""}>{label}</span>
      </button>
      {!isCollapsed && children}
    </div>
  );
}

function ResourceRow({
  item,
  selected,
  onSelect,
}: {
  item: InventoryResource;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = familyOf(item.type);
  const classes = FAMILY_CLASSES[meta.family];
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{ paddingLeft: 56 }}
      className={`w-full flex items-center gap-2 h-6 pr-2 text-left border-b border-border font-mono ${
        selected ? "bg-amber-50/60 dark:bg-amber-950/30" : "hover:bg-muted"
      }`}
    >
      <span className={`w-[2px] self-stretch my-1 ${classes.rail}`} />
      <span className="truncate flex-1">{item.name}</span>
      <span
        className={`px-1 rounded-sm text-[9px] ${
          item.managed
            ? "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300"
            : "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
        }`}
      >
        {item.managed ? "mgd" : "unmgd"}
      </span>
    </button>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd app/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/frontend/components/ResourceTree.tsx
git commit -m "feat(app): hierarchical ResourceTree grouping the unified inventory"
```

---

## Task 5: Swap the List tab to render `ResourceTree`

**Files:**
- Modify: `app/frontend/app/page.tsx`

- [ ] **Step 1: Replace the List tab body**

In `app/frontend/app/page.tsx`, change the import
`import { ResourceList } from "@/components/ResourceList";` to
`import { ResourceTree } from "@/components/ResourceTree";`.

Replace the `middleTab === "list"` block:

```tsx
        {middleTab === "list" && (
          <ResourceTree
            selected={selected}
            onSelect={setSelected}
            refreshKey={refreshKey}
          />
        )}
```

(Leave the `pendingByAddress` plumbing in place for other tabs; the tree
doesn't need it in Phase 1.)

- [ ] **Step 2: Typecheck, lint, build**

Run: `cd app/frontend && npx tsc --noEmit && npm run lint && npm run build`
Expected: build succeeds. (`ResourceList` may now be unused — if eslint flags
the import elsewhere, remove the dead import; the component file stays for
reference until Phase 4 retires it.)

- [ ] **Step 3: Commit**

```bash
git add app/frontend/app/page.tsx
git commit -m "feat(app): render hierarchical ResourceTree in place of the flat list"
```

---

## Task 6: Verify end to end

- [ ] **Step 1: Backend suite + ruff**

Run: `cd app/backend && ./.venv/bin/python -m pytest && ./.venv/bin/ruff check src/devex_app/inventory.py src/devex_app/routes/inventory.py tests`
Expected: all green.

- [ ] **Step 2: Frontend tsc + lint + build**

Run: `cd app/frontend && npx tsc --noEmit && npm run lint && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Boot check (routes registered)**

Run:
```bash
cd app/backend && ./.venv/bin/python -c "
from fastapi.testclient import TestClient
from devex_app.main import create_app
c = TestClient(create_app())
r = c.get('/api/inventory')
print('inventory status:', r.status_code, 'keys:', sorted(r.json().keys()))
"
```
Expected: `inventory status: 200 keys: ['components', 'resources']`.

- [ ] **Step 4: Manual smoke (document; needs Moto + app running)**

Discover/seed resources, open the app, switch to the (now hierarchical)
first tab, confirm: resources nest Account → Region → Component → type →
resource; a `Component`-tagged resource lands under its component; an
untagged one lands under **Unassigned**; clicking a managed resource opens
the drawer with full attributes incl `arn`. If Moto can't run here, note it
rather than claiming success.

---

## Self-review notes

- **Spec coverage (Phase 1):** inventory merge+dedup+classify (T1, T2),
  flat-list contract (T2), frontend group into Account→Region→Component→type
  (T4), replace List tab (T5), managed/unmanaged badges (T4), Unassigned
  bucket (T1 classify + T4 sort). Mapping CRUD, reassign, add-to-component,
  and the four-region layout are explicitly **Phase 2–4**, not this plan.
- **arn fix:** managed resources carry full `values` (incl `arn`) into the
  drawer, so the List-vs-Blueprint arn discrepancy is gone for the new tree.
- **Type consistency:** `InventoryResource`/`InventoryResponse` (T3) match
  the route payload (T2); `toResource` maps to the existing `Resource` type
  the drawer consumes.
- **No new FE test harness** — verification is tsc/lint/build + manual.
