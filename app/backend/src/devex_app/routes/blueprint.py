"""Blueprint canvas routes.

The Blueprint tab in the UI is a visual builder for OpenTofu config.
Users drag resource tiles onto a canvas, and the form pane on the
right edits the resource's attributes. The HCL the canvas writes
lives in the workspace pointed at by `settings.blueprint_root`
(default: `live/blueprint/`).

This module owns:
- `GET /api/schemas` — returns the provider schema for the supported
  resource types so the form can render the right fields.
- `POST /api/blueprint/resource` — writes a single resource block as
  its own file under `<blueprint_root>/resources/`. Idempotent on
  `(type, name)` — re-posting overwrites the file. One file per
  resource so re-reading the canvas state in a future phase is just
  a directory listing, no HCL parsing required.

Future phases will add:
- `GET /api/blueprint/resources` — canvas state from the resources/
  directory (file listing + parsed attribute snapshots).
- `DELETE /api/blueprint/resource/{type}/{name}` — removes a resource.
- Dependency edge derivation from inter-resource references.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import hcl2
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from ..settings import get_settings
from ..tofu import TofuError, providers_schema

router = APIRouter()

# The Blueprint MVP supports a curated set of AWS resource types. Each
# entry has a short friendly name + 2-letter monogram for the canvas
# tile, kept consistent with `frontend/lib/resourceFamilies.ts` so the
# Blueprint and List views read the same visual language.
SUPPORTED_TYPES: dict[str, dict[str, str]] = {
    "aws_s3_bucket": {"label": "S3 bucket", "family": "storage"},
    "aws_instance": {"label": "EC2 instance", "family": "compute"},
    "aws_vpc": {"label": "VPC", "family": "network"},
    "aws_subnet": {"label": "Subnet", "family": "network"},
    "aws_iam_role": {"label": "IAM role", "family": "iam"},
}

# OpenTofu and Terraform serve the AWS provider under different registry
# hostnames in the `providers schema -json` output. We try OpenTofu's
# key first since this repo is OpenTofu-native, and fall back to the
# Terraform Registry key so the same backend works in a Terraform shop.
AWS_PROVIDER_KEYS = (
    "registry.opentofu.org/hashicorp/aws",
    "registry.terraform.io/hashicorp/aws",
)


@router.get("/schemas")
def schemas(
    types: list[str] = Query(default=None),
) -> dict[str, Any]:
    """Returns the resource schemas the Blueprint UI needs to render
    the param form for each supported type.

    By default returns all `SUPPORTED_TYPES`; pass `?types=aws_s3_bucket&types=...`
    to filter. Each returned entry has the attribute schema (name +
    type + required + description) and the nested `block_types` for
    blocks like `versioning` or `lifecycle_rule`.
    """
    settings = get_settings()
    requested = list(types) if types else list(SUPPORTED_TYPES.keys())

    # Reject unknown types up-front rather than 500'ing later when the
    # schema lookup misses.
    unknown = [t for t in requested if t not in SUPPORTED_TYPES]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported resource types: {', '.join(unknown)}",
        )

    try:
        schema = providers_schema(settings.blueprint_root)
    except TofuError as exc:
        raise HTTPException(
            status_code=500,
            detail=(
                f"{exc}\n\nHint: the Blueprint workspace at "
                f"{settings.blueprint_root} may need `tofu init`."
            ),
        ) from exc

    provider_schemas = schema.get("provider_schemas") or {}
    provider_block: dict[str, Any] = {}
    provider_key_used = ""
    for key in AWS_PROVIDER_KEYS:
        if key in provider_schemas:
            provider_block = provider_schemas[key]
            provider_key_used = key
            break
    resources_block = provider_block.get("resource_schemas") or {}

    out: dict[str, Any] = {}
    for t in requested:
        meta = SUPPORTED_TYPES[t]
        resource_schema = resources_block.get(t)
        if resource_schema is None:
            # The provider exists but doesn't have this resource type.
            # Skip rather than failing the whole request.
            continue
        block = resource_schema.get("block") or {}
        out[t] = {
            "label": meta["label"],
            "family": meta["family"],
            "attributes": _normalize_attributes(block.get("attributes") or {}),
            "block_types": _normalize_block_types(block.get("block_types") or {}),
        }

    return {
        "blueprint_root": str(settings.blueprint_root),
        "provider": provider_key_used,
        "resources": out,
    }


def _normalize_attributes(attrs: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten the provider-schema attribute map into a list the
    frontend form can render directly. Keeps only the fields the UI
    cares about; drops sensitive computed-only attributes the user
    can't set."""
    out: list[dict[str, Any]] = []
    for name, info in attrs.items():
        # `computed_only` attributes (e.g., `arn`, `id`) are surfaced
        # in the resource state, not authored by the user — skip.
        if info.get("computed") and not info.get("optional") and not info.get(
            "required"
        ):
            continue
        out.append(
            {
                "name": name,
                "type": info.get("type"),
                "description": info.get("description") or "",
                "required": bool(info.get("required")),
                "optional": bool(info.get("optional")),
                "sensitive": bool(info.get("sensitive")),
                "deprecated": bool(info.get("deprecated")),
            }
        )
    # Required first, then alphabetical. The frontend can re-sort.
    out.sort(key=lambda a: (not a["required"], a["name"]))
    return out


def _normalize_block_types(block_types: dict[str, Any]) -> list[dict[str, Any]]:
    """Same shape as `_normalize_attributes` but for nested blocks
    (`versioning { ... }`, `lifecycle_rule { ... }`, etc.). We surface
    them at one level deep so the form can render a 'configure block'
    button per nested type; full deep-tree handling is a follow-up."""
    out: list[dict[str, Any]] = []
    for name, info in block_types.items():
        nesting = info.get("nesting_mode") or ""
        block = info.get("block") or {}
        attr_count = len(block.get("attributes") or {})
        nested_count = len(block.get("block_types") or {})
        out.append(
            {
                "name": name,
                "nesting_mode": nesting,
                "description": info.get("description") or block.get("description") or "",
                "min_items": info.get("min_items") or 0,
                "max_items": info.get("max_items") or 0,
                "attribute_count": attr_count,
                "nested_block_count": nested_count,
            }
        )
    out.sort(key=lambda b: b["name"])
    return out


# ---------------------------------------------------------------------------
# POST /api/blueprint/resource — write a resource block to HCL
# ---------------------------------------------------------------------------

# Valid OpenTofu identifier for resource labels — same rule the parser
# enforces. Used to reject obviously-malformed input before we go near
# the filesystem.
_NAME_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


class ResourceWriteRequest(BaseModel):
    """The body of `POST /api/blueprint/resource`.

    `attributes` are user-supplied values keyed by attribute name. Only
    primitives (str / int / float / bool) and JSON-serializable lists/maps
    are supported in Phase 2 — anything fancier than that should round-
    trip via the future block-types form.
    """

    type: str = Field(..., description="Resource type, e.g. aws_s3_bucket")
    name: str = Field(..., description="HCL block label, e.g. 'logs'")
    attributes: dict[str, Any] = Field(default_factory=dict)
    position: dict[str, float] | None = Field(
        default=None,
        description="Optional canvas (x, y) coords. Stored in `_layout.json` "
        "sidecar so the canvas can restore positions across reloads.",
    )

    @field_validator("type")
    @classmethod
    def _type_supported(cls, v: str) -> str:
        if v not in SUPPORTED_TYPES:
            raise ValueError(
                f"Unsupported resource type {v!r}. "
                f"Supported: {', '.join(SUPPORTED_TYPES)}"
            )
        return v

    @field_validator("name")
    @classmethod
    def _name_valid(cls, v: str) -> str:
        if not _NAME_RE.match(v):
            raise ValueError(
                f"Invalid resource name {v!r}. "
                "Must be a valid OpenTofu identifier "
                "(start with letter or underscore, then letters/digits/_)."
            )
        return v


@router.post("/blueprint/resource")
def write_resource(req: ResourceWriteRequest) -> dict[str, Any]:
    """Writes the resource as its own `.tf` file under the blueprint
    workspace. One file per resource so we can list/edit/delete without
    HCL parsing (Phase 3 will need parsing for dependency edges; Phase
    2 deliberately stays simple).

    Idempotent on `(type, name)`. Posting twice with the same identity
    overwrites; the file is the source of truth.
    """
    settings = get_settings()
    resources_dir = settings.blueprint_root / "resources"
    resources_dir.mkdir(parents=True, exist_ok=True)

    filename = f"{req.type}.{req.name}.tf"
    path = resources_dir / filename
    hcl = _render_resource_block(req.type, req.name, req.attributes)
    # Use a temp-write + rename so an interrupted write can't leave a
    # half-formed `.tf` that `tofu validate` would choke on.
    tmp = path.with_suffix(".tf.tmp")
    tmp.write_text(hcl, encoding="utf-8")
    tmp.replace(path)

    if req.position is not None:
        _update_layout(settings.blueprint_root, req.type, req.name, req.position)

    return {
        "type": req.type,
        "name": req.name,
        "path": str(path.relative_to(settings.repo_root))
        if path.is_relative_to(settings.repo_root)
        else str(path),
        "hcl": hcl,
    }


def _render_resource_block(
    type_: str, name: str, attributes: dict[str, Any]
) -> str:
    """Build the HCL text for a single resource block.

    Top-level attributes get rendered as `<name> = <value>`. Values are
    typed: strings get quoted (with escaping), bools/numbers render
    verbatim, lists/maps are rendered as inline HCL collections. Nested
    blocks (e.g. `versioning { ... }`) aren't supported in Phase 2 —
    block-type values are silently skipped here and the form prevents
    submitting them.
    """
    # Skip empty / null values so we don't litter the file with
    # `argument = null` that the user didn't intend to set.
    filtered = {k: v for k, v in attributes.items() if v not in (None, "", [])}

    if not filtered:
        return f'resource "{type_}" "{name}" {{}}\n'

    # Find the widest attribute name so all `=`s align like the formatter
    # would produce. This keeps the saved file looking like what
    # `tofu fmt` would emit, so the round-trip isn't noisy.
    width = max(len(k) for k in filtered)

    lines = [f'resource "{type_}" "{name}" {{']
    for key, value in sorted(filtered.items()):
        rendered = _render_hcl_value(value)
        lines.append(f"  {key.ljust(width)} = {rendered}")
    lines.append("}\n")
    return "\n".join(lines)


def _render_hcl_value(value: Any) -> str:
    """Render a Python value into its HCL equivalent. Conservative —
    falls back to JSON for anything we don't recognize, which produces
    valid HCL for primitives but not for HCL-specific constructs like
    references."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        # Reference-looking strings (e.g., `aws_vpc.main.id`,
        # `module.x.y`, `var.region`) and explicit `${...}` expressions
        # get emitted bare so they're real HCL references rather than
        # quoted literals. Phase 3's edge derivation depends on this:
        # `vpc_id = aws_vpc.main.id` produces a parseable interpolation
        # in the round-trip, which becomes a canvas edge; the literal
        # string `"aws_vpc.main.id"` wouldn't.
        if _looks_like_reference(value):
            return value
        # Heredoc for anything with a literal newline so the file stays
        # readable; otherwise an escaped one-liner.
        if "\n" in value:
            return _heredoc(value)
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    if isinstance(value, list):
        items = ", ".join(_render_hcl_value(v) for v in value)
        return f"[{items}]"
    if isinstance(value, dict):
        if not value:
            return "{}"
        pairs = ", ".join(
            f"{_hcl_key(k)} = {_render_hcl_value(v)}" for k, v in value.items()
        )
        return f"{{ {pairs} }}"
    # Fallback: stringify and quote. Loses fidelity but never produces
    # invalid HCL.
    return f'"{str(value)}"'


# Reference detection at write-time. Matches `<scope>.<name>(.<attr>)*`
# where scope is a known HCL prefix (resource type, `module`, `var`,
# `local`, `data`) or an explicit `${...}` interpolation. Designed to
# be conservative: rejects strings with spaces, quotes, leading
# punctuation, etc., so a literal text value isn't mis-emitted as code.
_REF_PREFIX_RE = re.compile(
    r"^(?:aws_[a-z][a-z0-9_]*|module|var|local|data)\.[a-zA-Z_][a-zA-Z0-9_]*"
    r"(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$"
)


def _looks_like_reference(value: str) -> bool:
    """True when `value` should be emitted as a bare HCL reference
    rather than a quoted string literal."""
    v = value.strip()
    if not v:
        return False
    if v.startswith("${") and v.endswith("}"):
        return True
    return bool(_REF_PREFIX_RE.match(v))


def _hcl_key(key: str) -> str:
    """Render a map key. Bare identifier if valid, quoted otherwise."""
    if _NAME_RE.match(key):
        return key
    escaped = key.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _heredoc(value: str) -> str:
    """Emit a multi-line value as an HCL heredoc."""
    body = value if value.endswith("\n") else value + "\n"
    return f"<<EOT\n{body}EOT"


def _update_layout(
    blueprint_root: Path, type_: str, name: str, position: dict[str, float]
) -> None:
    """Persist canvas position to a sidecar `_layout.json` so reloading
    the workspace restores the user's spatial arrangement. The file lives
    alongside the `resources/` dir so it's easy to spot but doesn't end
    up parsed by OpenTofu."""
    import json

    layout_path = blueprint_root / "_layout.json"
    if layout_path.exists():
        layout = json.loads(layout_path.read_text(encoding="utf-8"))
    else:
        layout = {}
    layout[f"{type_}.{name}"] = {"x": position.get("x", 0), "y": position.get("y", 0)}
    layout_path.write_text(
        json.dumps(layout, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# GET /api/blueprint/resources — read the canvas state back from disk
# ---------------------------------------------------------------------------

# Matches `${<type>.<name>...}` interpolations inside HCL-stringified
# references. The lib returns refs to other resources as e.g.
# `${aws_vpc.main.id}`; this captures the (type, name) pair so we can
# turn them into edges.
_REF_RE = re.compile(r"\$\{(aws_[a-zA-Z0-9_]+)\.([a-zA-Z_][a-zA-Z0-9_]*)(?:\.|})")


@router.get("/blueprint/resources")
def list_resources() -> dict[str, Any]:
    """Reads every `*.tf` file under the blueprint workspace's
    `resources/` dir + the sidecar `_layout.json` and returns the
    canvas state.

    Each resource is one node; edges are derived from HCL references
    found in attribute values (e.g. `vpc_id = aws_vpc.main.id` ties
    the subnet to the VPC). Resources written by the AI agent through
    its `Edit`/`Write` tools land in the same dir and flow through
    this endpoint just like the canvas's own writes.
    """
    settings = get_settings()
    resources_dir = settings.blueprint_root / "resources"
    layout_path = settings.blueprint_root / "_layout.json"

    if not resources_dir.exists():
        return {
            "blueprint_root": str(settings.blueprint_root),
            "resources": [],
            "edges": [],
        }

    layout: dict[str, dict[str, float]] = {}
    if layout_path.exists():
        try:
            layout = json.loads(layout_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            # Corrupt layout file shouldn't break the canvas — fall
            # back to laid-out-at-origin and let the user re-position.
            layout = {}

    resources: list[dict[str, Any]] = []
    refs: list[tuple[str, str]] = []  # (source_address, target_address)

    for path in sorted(resources_dir.glob("*.tf")):
        try:
            parsed = _parse_resource_file(path)
        except (ValueError, Exception) as exc:  # noqa: BLE001
            # A malformed file shouldn't take down the whole canvas.
            # Emit a placeholder node so the user can see + fix it
            # rather than wondering why the resource vanished.
            resources.append(
                {
                    "type": "",
                    "name": path.stem,
                    "attributes": {},
                    "position": layout.get(path.stem, {"x": 0, "y": 0}),
                    "parse_error": str(exc),
                    "filename": path.name,
                }
            )
            continue

        if not parsed:
            continue

        type_ = parsed["type"]
        name = parsed["name"]
        address = f"{type_}.{name}"
        attrs = parsed["attributes"]

        resources.append(
            {
                "type": type_,
                "name": name,
                "attributes": attrs,
                "position": layout.get(address, {"x": 0, "y": 0}),
                "filename": path.name,
            }
        )

        # Walk the attributes looking for ${<type>.<name>...} refs.
        for ref_target in _find_references(attrs):
            refs.append((address, ref_target))

    # Edges only count when both endpoints exist as resources on the
    # canvas — references to things that aren't part of the blueprint
    # (e.g., a hand-typed `data.aws_caller_identity.current.account_id`)
    # are ignored.
    known_addresses = {f"{r['type']}.{r['name']}" for r in resources}
    edges = [
        {"source": s, "target": t}
        for s, t in refs
        if s in known_addresses and t in known_addresses and s != t
    ]
    # Deduplicate; multiple attrs pointing at the same target only
    # warrants one edge.
    seen = set()
    edges = [
        e for e in edges
        if (e["source"], e["target"]) not in seen
        and not seen.add((e["source"], e["target"]))
    ]

    return {
        "blueprint_root": str(settings.blueprint_root),
        "resources": resources,
        "edges": edges,
    }


def _parse_resource_file(path: Path) -> dict[str, Any] | None:
    """Parses one `*.tf` file expected to hold exactly one `resource`
    block (the shape this module writes). Returns
    `{type, name, attributes}` with HCL quoting stripped, or `None`
    if the file doesn't actually contain a resource block.
    """
    raw = path.read_text(encoding="utf-8")
    parsed = hcl2.loads(raw)
    resource_blocks = parsed.get("resource") or []
    if not resource_blocks:
        return None
    block = resource_blocks[0]
    # Shape: `{ '"aws_s3_bucket"': { '"logs"': { <attrs> } } }`.
    # python-hcl2 v8 wraps both the type and name keys in literal
    # quotes; strip them.
    type_quoted = next(iter(block))
    type_ = _strip_quotes(type_quoted)
    inner = block[type_quoted]
    name_quoted = next(iter(inner))
    name = _strip_quotes(name_quoted)
    raw_attrs = inner[name_quoted]
    # Drop the `__is_block__` sentinel the lib emits.
    attrs = {k: _normalize_value(v) for k, v in raw_attrs.items() if k != "__is_block__"}
    return {"type": type_, "name": name, "attributes": attrs}


def _strip_quotes(s: str) -> str:
    """Strip a single layer of surrounding double quotes from a key
    or string value produced by python-hcl2."""
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        return s[1:-1]
    return s


def _normalize_value(v: Any) -> Any:
    """Recursively strip python-hcl2's literal-quote wrapping on
    string values, preserving non-string types verbatim.

    Reference interpolations like `${aws_vpc.main.id}` are left
    intact so callers can find them when building edges; the frontend
    form displays them as-is too."""
    if isinstance(v, str):
        return _strip_quotes(v)
    if isinstance(v, list):
        return [_normalize_value(x) for x in v]
    if isinstance(v, dict):
        return {k: _normalize_value(val) for k, val in v.items() if k != "__is_block__"}
    return v


def _find_references(attrs: Any) -> list[str]:
    """Walks the attribute payload looking for `${<type>.<name>...}`
    interpolations. Returns the set of `<type>.<name>` addresses
    referenced anywhere in the value tree.
    """
    found: list[str] = []

    def walk(v: Any) -> None:
        if isinstance(v, str):
            for m in _REF_RE.finditer(v):
                found.append(f"{m.group(1)}.{m.group(2)}")
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, dict):
            for val in v.values():
                walk(val)

    walk(attrs)
    return found


# ---------------------------------------------------------------------------
# DELETE /api/blueprint/resource/{type}/{name}
# ---------------------------------------------------------------------------


@router.delete("/blueprint/resource/{type_}/{name}")
def delete_resource(type_: str, name: str) -> dict[str, Any]:
    """Remove a resource from the canvas: deletes its `.tf` file and
    drops the matching `_layout.json` entry. Idempotent on missing
    files so a double-click in the UI doesn't 404.
    """
    if type_ not in SUPPORTED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported resource type {type_!r}.",
        )
    if not _NAME_RE.match(name):
        raise HTTPException(
            status_code=400, detail=f"Invalid resource name {name!r}."
        )

    settings = get_settings()
    resources_dir = settings.blueprint_root / "resources"
    file_path = resources_dir / f"{type_}.{name}.tf"
    layout_path = settings.blueprint_root / "_layout.json"

    deleted_file = False
    if file_path.exists():
        file_path.unlink()
        deleted_file = True

    deleted_layout = False
    if layout_path.exists():
        try:
            layout = json.loads(layout_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            layout = {}
        address = f"{type_}.{name}"
        if address in layout:
            del layout[address]
            layout_path.write_text(
                json.dumps(layout, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            deleted_layout = True

    return {
        "type": type_,
        "name": name,
        "deleted_file": deleted_file,
        "deleted_layout_entry": deleted_layout,
    }
