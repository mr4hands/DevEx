"""Blueprint canvas routes.

The Blueprint tab in the UI is a visual builder for OpenTofu config.
Users drag resource tiles onto a canvas, and the form pane on the
right edits the resource's attributes. The HCL the canvas writes
lives in the workspace pointed at by `settings.blueprint_root`
(default: `live/blueprint/`).

Generated files use a `bp.<type>.<name>.tf` naming convention and
live at the workspace root (not in a subdirectory). The root-only
placement is mandatory: OpenTofu's root-module loader doesn't recurse,
so files in a `resources/` subdir are silently invisible to `tofu plan`.
The `bp.` prefix keeps them visually distinct from hand-authored
files (`main.tf`, `versions.tf`, etc.) and easy to gitignore.

Routes:
- `GET /api/schemas` — provider schema for the supported types.
- `POST /api/blueprint/resource` — writes one resource per file.
- `GET /api/blueprint/resources` — canvas state (nodes + edges).
- `DELETE /api/blueprint/resource/{type}/{name}` — removes a file.
- `PATCH /api/blueprint/layout` — drag-to-save canvas positions.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Literal

import hcl2
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from .. import drafts, leaves
from ..settings import get_settings
from ..tofu import TofuError, generate_resource_config, providers_schema
from ._deps import resolve_owner

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


def _type_meta(type_: str) -> dict[str, str]:
    """Cosmetic label + family for a type. Curated entries win; anything
    else gets a humanized label and the generic "other" family so the
    canvas can still render adopted resources of any type."""
    if type_ in SUPPORTED_TYPES:
        return SUPPORTED_TYPES[type_]
    leaf = type_.removeprefix("aws_").replace("_", " ")
    return {"label": leaf or type_, "family": "other"}


@router.get("/schemas")
def schemas(
    types: list[str] = Query(default=None),  # noqa: B008  (FastAPI idiom)
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

    # Format-only validation — any valid resource-type identifier is
    # allowed now (existing-resource adoption can surface any type). Types
    # missing from the provider schema are simply skipped in the loop below.
    bad = [t for t in requested if not _DELETE_TYPE_RE.match(t)]
    if bad:
        raise HTTPException(
            status_code=400,
            detail=f"Malformed resource type identifiers: {', '.join(bad)}",
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
        meta = _type_meta(t)
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


# Attributes the user must never author, even though the AWS provider marks
# them `optional + computed`. `id` is the resource identifier (AWS-assigned;
# Terraform ignores it in config — the optional flag is a legacy quirk).
# `tags_all` is the computed merge of `tags` + provider `default_tags`;
# users edit `tags`. These are surfaced read-only, not dropped.
_AWS_ASSIGNED_ATTRS = frozenset({"id", "tags_all"})


def _normalize_attributes(attrs: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten the provider-schema attribute map into a list the
    frontend form can render directly.

    Every attribute is surfaced — nothing is dropped — but each carries a
    `read_only` flag so the form knows what the user authors vs. what AWS
    assigns:

    - `read_only=True`  — pure-computed outputs (`arn`, `region`,
      `create_date`, …) plus the AWS-assigned `id` / `tags_all`. Shown
      disabled ("known after apply" when no value yet).
    - `read_only=False`, `computed=True` — optional-computed (`bucket`,
      `cidr_block`): editable, but AWS fills it if left blank.
    - `read_only=False`, `computed=False` — plain required/optional fields.
    """
    out: list[dict[str, Any]] = []
    for name, info in attrs.items():
        required = bool(info.get("required"))
        optional = bool(info.get("optional"))
        computed = bool(info.get("computed"))
        # Read-only = AWS-assigned: pure-computed outputs, or the special
        # id / tags_all the provider marks optional+computed.
        read_only = (computed and not optional and not required) or (
            name in _AWS_ASSIGNED_ATTRS
        )
        out.append(
            {
                "name": name,
                "type": info.get("type"),
                "description": info.get("description") or "",
                "required": required,
                "optional": optional,
                "computed": computed,
                "read_only": read_only,
                "sensitive": bool(info.get("sensitive")),
                "deprecated": bool(info.get("deprecated")),
            }
        )
    # Editable first (required, then optional), read-only last; alpha within.
    out.sort(key=lambda a: (a["read_only"], not a["required"], a["name"]))
    return out


# Max recursion depth when normalizing nested block_types into the
# schema response. AWS provider schemas can nest 5+ levels deep
# (lifecycle_rule → transition → ...); we cap at 3 to keep the form
# manageable. Deeper-nested blocks come back as `{ ..., block_types: [] }`
# — the form falls back to a "deeper than supported" hint for those.
_MAX_BLOCK_DEPTH = 3


def _normalize_block_types(
    block_types: dict[str, Any],
    depth: int = 0,
) -> list[dict[str, Any]]:
    """Recursive provider-schema normalizer for nested blocks
    (`versioning { ... }`, `lifecycle_rule { ... }`, etc.). At each
    level we return the block's `attributes` (full schema, same shape
    as the top-level resource attrs) and its `block_types` (recursed
    up to `_MAX_BLOCK_DEPTH`). The frontend form can render editors
    for any depth the response actually contains; truncated branches
    show as collapsed "deeper than supported" hints."""
    out: list[dict[str, Any]] = []
    for name, info in block_types.items():
        nesting = info.get("nesting_mode") or ""
        block = info.get("block") or {}
        nested_block_types: list[dict[str, Any]] = []
        if depth < _MAX_BLOCK_DEPTH:
            nested_block_types = _normalize_block_types(
                block.get("block_types") or {},
                depth=depth + 1,
            )
        out.append(
            {
                "name": name,
                "nesting_mode": nesting,
                "description": info.get("description") or block.get("description") or "",
                "min_items": info.get("min_items") or 0,
                "max_items": info.get("max_items") or 0,
                "attributes": _normalize_attributes(block.get("attributes") or {}),
                "block_types": nested_block_types,
                # Surface whether we truncated, so the UI can hint at it.
                "truncated": depth >= _MAX_BLOCK_DEPTH
                and bool(block.get("block_types")),
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

# Format-only check for resource-type identifiers (used by DELETE +
# parse-error fallback). Looser than `SUPPORTED_TYPES` membership
# because delete needs to work for orphan files, AI-agent-written
# resources, and types that get added between client and server
# deploys.
_DELETE_TYPE_RE = re.compile(r"^[a-z][a-z0-9_]+$")


class BlockInstance(BaseModel):
    """One instance of a nested HCL block (e.g., one `ingress` rule
    inside an `aws_security_group`).

    `attributes` are the block's leaf-level values. `blocks` is the
    same map shape as on `ResourceWriteRequest`, recursively — so
    `lifecycle_rule.transition` etc. round-trip through the same
    structure all the way down."""

    attributes: dict[str, Any] = Field(default_factory=dict)
    blocks: dict[str, list[BlockInstance]] = Field(default_factory=dict)


class ResourceWriteRequest(BaseModel):
    """The body of `POST /api/blueprint/resource`.

    `attributes` are user-supplied leaf-level values keyed by attribute
    name (string / number / bool / JSON-serializable list-or-map).

    `blocks` carries nested HCL blocks (`versioning {}`, `ingress {}`,
    `lifecycle_rule {}`, etc.) as a map of `block_name → list[BlockInstance]`.
    The list shape works for every nesting_mode: `single` blocks have
    0 or 1 entries; `list`/`set` blocks have N entries; `map` blocks
    are flattened to a list with the key in the attributes (Phase 4
    doesn't fully support map mode — most AWS schemas use list/set
    for the resources we care about).
    """

    type: str = Field(..., description="Resource type, e.g. aws_s3_bucket")
    name: str = Field(..., description="HCL block label, e.g. 'logs'")
    import_id: str | None = Field(
        default=None,
        description="Real cloud id. When set, an `import { to, id }` block is "
        "emitted above the resource so OpenTofu adopts the existing resource "
        "instead of creating a new one.",
    )
    attributes: dict[str, Any] = Field(default_factory=dict)
    blocks: dict[str, list[BlockInstance]] = Field(default_factory=dict)
    position: dict[str, float] | None = Field(
        default=None,
        description="Optional canvas (x, y) coords. Stored in `_layout.json` "
        "sidecar so the canvas can restore positions across reloads.",
    )

    @field_validator("type")
    @classmethod
    def _type_valid(cls, v: str) -> str:
        # Format-only — adoption of existing resources can surface any
        # type, so we no longer gate writes to SUPPORTED_TYPES. The
        # supported list still drives the palette + cosmetics.
        if not _DELETE_TYPE_RE.match(v):
            raise ValueError(
                f"Invalid resource type identifier {v!r}. "
                "Must look like aws_s3_bucket."
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


def _read_only_attr_names(type_: str) -> set[str]:
    """Names of attributes the provider marks read-only (AWS-assigned) for
    `type_` — pure-computed outputs plus `id` / `tags_all`. Used to keep
    those values out of authored HCL even when a client (e.g. a rich
    discovery payload) sends them. Empty set when the schema is
    unavailable (unknown type / workspace not initialized), in which case
    we don't filter."""
    settings = get_settings()
    try:
        schema = providers_schema(settings.blueprint_root)
    except TofuError:
        return set()
    provider_schemas = schema.get("provider_schemas") or {}
    for key in AWS_PROVIDER_KEYS:
        resources_block = (provider_schemas.get(key) or {}).get(
            "resource_schemas"
        ) or {}
        resource_schema = resources_block.get(type_)
        if resource_schema:
            attrs = (resource_schema.get("block") or {}).get("attributes") or {}
            return {a["name"] for a in _normalize_attributes(attrs) if a["read_only"]}
    return set()


def _render_import_block(type_: str, name: str, import_id: str) -> str:
    """Render an `import { to, id }` block. `to` is a bare resource
    address; `id` is a quoted, escaped literal. Emitted above the
    resource so OpenTofu adopts an existing resource instead of creating
    a duplicate."""
    escaped = import_id.replace("\\", "\\\\").replace('"', '\\"')
    return f'import {{\n  to = {type_}.{name}\n  id = "{escaped}"\n}}\n'


def _render_resource_block(
    type_: str,
    name: str,
    attributes: dict[str, Any],
    blocks: dict[str, list[BlockInstance]] | None = None,
) -> str:
    """Build the HCL text for a single resource block.

    Top-level attributes get rendered as `<name> = <value>`. Nested
    blocks render with the standard HCL block syntax:

        resource "aws_s3_bucket" "logs" {
          bucket = "my-bucket"

          versioning {
            enabled = true
          }
        }

    Values are typed: strings get quoted (with escaping), bools/numbers
    render verbatim, lists/maps as inline HCL collections, reference-
    shaped strings as bare expressions. Empty/null values are dropped
    so we don't litter the file with `attr = null`.

    Phase 4 added nested-block support (the `blocks` arg) — instances
    flatten via `_render_block_body` recursively, so `lifecycle_rule
    { transition { ... } }` round-trips without special-casing.
    """
    filtered_attrs = {
        k: v for k, v in attributes.items() if v not in (None, "", [])
    }
    nonempty_blocks = {
        bn: list(instances)
        for bn, instances in (blocks or {}).items()
        if instances
    }

    if not filtered_attrs and not nonempty_blocks:
        return f'resource "{type_}" "{name}" {{}}\n'

    body_lines = _render_block_body(filtered_attrs, nonempty_blocks, indent=1)
    lines = [f'resource "{type_}" "{name}" {{', *body_lines, "}"]
    return "\n".join(lines) + "\n"


def _render_block_body(
    attributes: dict[str, Any],
    blocks: dict[str, list[Any]],
    indent: int,
) -> list[str]:
    """Render the body of a `{ ... }` block: top-level attributes
    aligned by `=`, then nested blocks each on their own newline-
    separated block. Used both for the top-level resource body and
    recursively for nested blocks (versioning, lifecycle_rule, etc.).
    """
    pad = "  " * indent
    out: list[str] = []
    filtered_attrs = {
        k: v for k, v in attributes.items() if v not in (None, "", [])
    }
    if filtered_attrs:
        width = max(len(k) for k in filtered_attrs)
        for key, value in sorted(filtered_attrs.items()):
            out.append(f"{pad}{key.ljust(width)} = {_render_hcl_value(value)}")

    for block_name in sorted(blocks):
        for inst in blocks[block_name]:
            inst_attrs = (
                inst.attributes if isinstance(inst, BlockInstance) else inst.get("attributes", {})
            )
            inst_blocks = (
                inst.blocks if isinstance(inst, BlockInstance) else inst.get("blocks", {})
            )
            inst_filtered_attrs = {
                k: v for k, v in inst_attrs.items() if v not in (None, "", [])
            }
            inst_nonempty_blocks = {
                bn: list(insts) for bn, insts in (inst_blocks or {}).items() if insts
            }
            # Empty-body block: write as `name {}` and move on.
            if not inst_filtered_attrs and not inst_nonempty_blocks:
                # Blank line before each nested block keeps the file
                # reading like `tofu fmt` output.
                if out:
                    out.append("")
                out.append(f"{pad}{block_name} {{}}")
                continue
            if out:
                out.append("")
            out.append(f"{pad}{block_name} {{")
            out.extend(
                _render_block_body(inst_filtered_attrs, inst_nonempty_blocks, indent + 1)
            )
            out.append(f"{pad}}}")
    return out


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
        # `module.x.y`, `var.region`) and `${...}` interpolation
        # syntax get emitted as bare HCL expressions rather than
        # quoted literals. Phase 3's edge derivation depends on this:
        # `vpc_id = aws_vpc.main.id` produces a parseable interpolation
        # in the round-trip, which becomes a canvas edge; the literal
        # string `"aws_vpc.main.id"` wouldn't.
        #
        # Important: `${...}` is *string-interpolation* syntax, valid
        # inside double-quoted strings but a syntax error in expression
        # position in HCL 0.12+. So when the value is wrapped, we
        # strip the `${...}` and emit the bare body. This matters
        # because the round-trip from `tofu show` / python-hcl2 re-
        # normalizes refs back to `${...}` form; saving the form
        # verbatim would otherwise produce invalid HCL on the next
        # save (`tofu validate` would reject it).
        bare = _unwrap_interpolation(value)
        if bare is not None and _looks_like_bare_reference(bare):
            return bare
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
# `local`, `data`). Designed to be conservative: rejects strings with
# spaces, quotes, leading punctuation, etc., so a literal text value
# isn't mis-emitted as code.
_REF_PREFIX_RE = re.compile(
    r"^(?:aws_[a-z][a-z0-9_]*|module|var|local|data)\.[a-zA-Z_][a-zA-Z0-9_]*"
    r"(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$"
)


def _unwrap_interpolation(value: str) -> str | None:
    """If `value` is a `${...}` interpolation, return the inside text;
    otherwise return the trimmed value. Used at write time so we never
    emit a literal `${...}` in expression position (which is invalid
    HCL 0.12+ syntax)."""
    v = value.strip()
    if not v:
        return None
    if v.startswith("${") and v.endswith("}"):
        return v[2:-1].strip()
    return v


def _looks_like_bare_reference(value: str) -> bool:
    """True when `value` is a recognized bare HCL reference (no
    quotes, no interpolation wrapper). Use `_unwrap_interpolation`
    first if the caller might be holding a `${...}` form."""
    return bool(_REF_PREFIX_RE.match(value))


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
    _merge_layout(
        blueprint_root,
        {
            f"{type_}.{name}": {
                "x": position.get("x", 0),
                "y": position.get("y", 0),
            }
        },
    )


def _merge_layout(
    blueprint_root: Path,
    entries: dict[str, dict[str, float]],
) -> None:
    """Apply a batch of `<addr> → {x, y}` updates to `_layout.json`,
    creating the file if missing. Used by both the single-resource
    write path (POST) and the drag-to-save layout PATCH endpoint."""
    layout_path = blueprint_root / "_layout.json"
    if layout_path.exists():
        try:
            layout = json.loads(layout_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            layout = {}
    else:
        layout = {}
    for addr, pos in entries.items():
        layout[addr] = {"x": pos.get("x", 0), "y": pos.get("y", 0)}
    layout_path.write_text(
        json.dumps(layout, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# POST /api/blueprint/generate-config — clean HCL for an adopted resource
# ---------------------------------------------------------------------------


class GenerateConfigRequest(BaseModel):
    """Body of POST /api/blueprint/generate-config — the 'generate clean
    config' action for an adopted resource in the owner's overlay leaf."""

    type: str = Field(..., description="Resource type, e.g. aws_s3_bucket")
    name: str = Field(..., description="HCL block label")
    account: str = Field(...)
    region: str = Field(...)
    layer: str = Field(...)
    component: str = Field(...)


@router.post("/blueprint/generate-config")
def generate_config(
    req: GenerateConfigRequest, owner: str = Depends(resolve_owner)
) -> dict[str, Any]:
    """Replace an adopted resource's thin pre-fill body with apply-clean
    HCL from `tofu plan -generate-config-out`, preserving its import block.
    The resource must already exist in the owner's overlay leaf with an
    import block (i.e. it was adopted, not authored from scratch)."""
    settings = get_settings()
    try:
        leaf = leaves.leaf_dir(
            settings.blueprint_root,
            owner,
            req.account,
            req.region,
            req.layer,
            req.component,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    path = leaf / f"{req.type}.{req.name}.tf"
    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"No draft for {req.type}.{req.name}.",
        )
    parsed = _parse_resource_file(path)
    import_id = parsed.get("import_id") if parsed else None
    if not import_id:
        raise HTTPException(
            status_code=400,
            detail="Resource has no import block; nothing to generate from.",
        )
    try:
        generated_block = generate_resource_config(
            leaf, req.type, req.name, import_id
        )
    except TofuError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    hcl = (
        _render_import_block(req.type, req.name, import_id)
        + "\n"
        + generated_block.strip()
        + "\n"
    )
    tmp = path.with_suffix(".tf.tmp")
    tmp.write_text(hcl, encoding="utf-8")
    tmp.replace(path)
    return {"type": req.type, "name": req.name, "hcl": hcl}


# ---------------------------------------------------------------------------
# PATCH /api/blueprint/layout — drag-to-save canvas positions
# ---------------------------------------------------------------------------


class LayoutPatchRequest(BaseModel):
    """Bulk update for `_layout.json`. The canvas calls this after the
    user drags nodes; debounced client-side so a single drag interaction
    produces one request, not one per pixel.

    Keys in `positions` are `<type>.<name>` (matching the canvas's
    node addresses). The endpoint is permissive about which resources
    exist — entries for resources whose `.tf` files have since been
    deleted are still persisted (harmless; the GET endpoint ignores
    them when it doesn't find a matching file).
    """

    positions: dict[str, dict[str, float]] = Field(default_factory=dict)


@router.patch("/blueprint/layout")
def patch_layout(req: LayoutPatchRequest) -> dict[str, Any]:
    if not req.positions:
        return {"updated": 0}
    settings = get_settings()
    _merge_layout(settings.blueprint_root, req.positions)
    return {"updated": len(req.positions)}


# ---------------------------------------------------------------------------
# GET /api/blueprint/resources — read the canvas state back from disk
# ---------------------------------------------------------------------------

# Matches `${<type>.<name>...}` interpolations inside HCL-stringified
# references. The lib returns refs to other resources as e.g.
# `${aws_vpc.main.id}`; this captures the (type, name) pair so we can
# turn them into edges.
_REF_RE = re.compile(r"\$\{(aws_[a-zA-Z0-9_]+)\.([a-zA-Z_][a-zA-Z0-9_]*)(?:\.|})")


@router.get("/blueprint/resources")
def list_resources(owner: str = Depends(resolve_owner)) -> dict[str, Any]:
    """Reads the requesting owner's draft overlay (resource files across all
    leaves) and returns the canvas state. Boilerplate files are skipped. Edge
    derivation returns to the canvas in Phase 2b."""
    settings = get_settings()
    base = leaves.owner_overlay_dir(settings.blueprint_root, owner)
    resources: list[dict[str, Any]] = []
    if base.is_dir():
        for tf in sorted(base.rglob("*.tf")):
            if tf.name in leaves.BOILERPLATE_FILENAMES:
                continue
            try:
                parsed = _parse_resource_file(tf)
            except Exception:  # noqa: BLE001
                continue
            if not parsed:
                continue
            leaf_rel = tf.parent.relative_to(base).as_posix()
            resources.append(
                {
                    "type": parsed["type"],
                    "name": parsed["name"],
                    "attributes": parsed["attributes"],
                    "blocks": parsed.get("blocks") or {},
                    "import_id": parsed.get("import_id"),
                    "leaf": leaf_rel,
                    "filename": tf.name,
                }
            )
    return {
        "blueprint_root": str(settings.blueprint_root),
        "resources": resources,
        "edges": [],
    }


def _split_filename(stem: str) -> tuple[str, str]:
    """Split a `bp.<type>.<name>` file stem (no `.tf`) into the
    `(type, name)` pair the canvas uses. Used by the parse-error
    fallback so a malformed file still renders as a node the user can
    Delete.

    Tolerates a missing `bp.` prefix (older files, hand-created) by
    stripping it only when present. Returns `("unknown", stem)` if the
    remainder doesn't match the convention; both halves still pass the
    relaxed identifier checks used by the DELETE endpoint, so the
    broken-file flow keeps working."""
    s = stem
    if s.startswith("bp."):
        s = s[len("bp.") :]
    if "." in s:
        type_, _, name = s.partition(".")
        if _DELETE_TYPE_RE.match(type_) and _NAME_RE.match(name):
            return type_, name
    return "unknown", s


def _migrate_legacy_resources(blueprint_root: Path) -> int:
    """One-time migration: move `resources/<type>.<name>.tf` files
    (the old, broken layout) to `bp.<type>.<name>.tf` at the workspace
    root. The old layout placed files in a subdirectory, which
    OpenTofu's root-module loader silently ignored — so `tofu plan`
    saw zero resources. Idempotent: skips files that already exist at
    the destination, and removes the `resources/` dir once emptied.
    Returns the count moved."""
    legacy_dir = blueprint_root / "resources"
    if not legacy_dir.is_dir():
        return 0
    moved = 0
    for old_path in legacy_dir.glob("*.tf"):
        new_path = blueprint_root / f"bp.{old_path.name}"
        if not new_path.exists():
            old_path.rename(new_path)
            moved += 1
    try:
        legacy_dir.rmdir()  # only succeeds if empty
    except OSError:
        pass
    return moved


def _parse_resource_file(path: Path) -> dict[str, Any] | None:
    """Parses one `*.tf` file expected to hold exactly one `resource`
    block (the shape this module writes). Returns
    `{type, name, attributes, blocks}` with HCL quoting stripped, or
    `None` if the file doesn't actually contain a resource block.

    Phase 4 split: leaf-level attributes go in `attributes`; nested
    blocks (single, list, or set nesting modes) go in `blocks` as
    `{block_name: [BlockInstance, ...]}`. python-hcl2 marks blocks
    with `__is_block__: True` — we use that to distinguish a
    `versioning { ... }` block from a `tags = {...}` map.
    """
    raw = path.read_text(encoding="utf-8")
    parsed = hcl2.loads(raw)
    resource_blocks = parsed.get("resource") or []
    if not resource_blocks:
        return None
    block = resource_blocks[0]
    # Shape: `{ '"aws_s3_bucket"': { '"logs"': { <body> } } }`.
    # python-hcl2 v8 wraps both the type and name keys in literal
    # quotes; strip them.
    type_quoted = next(iter(block))
    type_ = _strip_quotes(type_quoted)
    inner = block[type_quoted]
    name_quoted = next(iter(inner))
    name = _strip_quotes(name_quoted)
    raw_body = inner[name_quoted]
    attrs, blocks = _split_attrs_and_blocks(raw_body)

    # An adopted resource carries a sibling `import { to, id }` block.
    # Match it to this resource by its `to` address and surface the id.
    import_id: str | None = None
    for imp in parsed.get("import") or []:
        if _import_to_matches(imp.get("to"), type_, name):
            raw_id = imp.get("id")
            import_id = _strip_quotes(str(raw_id)) if raw_id is not None else None
            break

    return {
        "type": type_,
        "name": name,
        "attributes": attrs,
        "blocks": blocks,
        "import_id": import_id,
    }


def _import_to_matches(to: Any, type_: str, name: str) -> bool:
    """python-hcl2 returns the `to` expression interpolation-wrapped
    (`${aws_s3_bucket.logs}`) or bare (`aws_s3_bucket.logs`). Normalize
    both before comparing to `<type>.<name>`."""
    if not isinstance(to, str):
        return False
    bare = to.strip()
    if bare.startswith("${") and bare.endswith("}"):
        bare = bare[2:-1].strip()
    return bare == f"{type_}.{name}"


def _split_attrs_and_blocks(
    raw: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
    """Walk a parsed HCL block body and partition it into leaf
    attributes and nested blocks. Used by the resource parser to
    surface the same `{attributes, blocks}` shape the writer
    expects on POST.

    Disambiguates a block from a map by python-hcl2's `__is_block__`
    sentinel: a dict with that key is a single-instance nested block,
    a list of such dicts is list/set-mode block instances, anything
    else is a leaf attribute.
    """
    attrs: dict[str, Any] = {}
    blocks: dict[str, list[dict[str, Any]]] = {}
    for k, v in raw.items():
        if k == "__is_block__":
            continue
        if isinstance(v, dict) and v.get("__is_block__") is True:
            # Single-instance nested block.
            inner_attrs, inner_blocks = _split_attrs_and_blocks(v)
            blocks[k] = [{"attributes": inner_attrs, "blocks": inner_blocks}]
        elif (
            isinstance(v, list)
            and v
            and all(
                isinstance(x, dict) and x.get("__is_block__") is True for x in v
            )
        ):
            # List- or set-mode block: N instances.
            instances: list[dict[str, Any]] = []
            for x in v:
                inner_attrs, inner_blocks = _split_attrs_and_blocks(x)
                instances.append(
                    {"attributes": inner_attrs, "blocks": inner_blocks}
                )
            blocks[k] = instances
        else:
            attrs[k] = _normalize_value(v)
    return attrs, blocks


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
# POST /api/blueprint/draft — owner-scoped draft CRUD
# ---------------------------------------------------------------------------


class DraftRequest(BaseModel):
    """Body of POST /api/blueprint/draft. `kind` selects the change type;
    `attributes`/`import_id` seed the HCL for new/adopt/edit; `delete`
    records a marker only."""

    kind: Literal["new", "adopt", "edit", "delete"]
    type: str = Field(...)
    name: str = Field(...)
    account: str = Field(...)
    region: str = Field(...)
    layer: str = Field(...)
    component: str = Field(...)
    source_address: str | None = None
    import_id: str | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)

    @field_validator("type")
    @classmethod
    def _type_valid(cls, v: str) -> str:
        if not _DELETE_TYPE_RE.match(v):
            raise ValueError(f"Invalid resource type {v!r}")
        return v

    @field_validator("name")
    @classmethod
    def _name_valid(cls, v: str) -> str:
        if not _NAME_RE.match(v):
            raise ValueError(f"Invalid resource name {v!r}")
        return v


def _component_target_module(component: str | None) -> str | None:
    if not component:
        return None
    slug = component.lower().replace(" ", "_")
    return f"modules/{slug}"


@router.post("/blueprint/draft")
def write_draft(
    req: DraftRequest, owner: str = Depends(resolve_owner)
) -> dict[str, Any]:
    settings = get_settings()
    try:
        leaf = leaves.ensure_leaf(
            settings.blueprint_root,
            owner,
            req.account,
            req.region,
            req.layer,
            req.component,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    address = f"{req.type}.{req.name}"
    res_path = leaf / f"{req.type}.{req.name}.tf"
    hcl = ""
    if req.kind == "delete":
        if res_path.exists():
            res_path.unlink()
    else:
        read_only = _read_only_attr_names(req.type)
        authored = {k: v for k, v in req.attributes.items() if k not in read_only}
        resource_hcl = _render_resource_block(req.type, req.name, authored, {})
        if req.kind == "adopt" and req.import_id:
            hcl = (
                _render_import_block(req.type, req.name, req.import_id)
                + "\n"
                + resource_hcl
            )
        else:
            hcl = resource_hcl
        tmp = res_path.with_suffix(".tf.tmp")
        tmp.write_text(hcl, encoding="utf-8")
        tmp.replace(res_path)

    leaf_rel = leaves.leaf_relpath(req.account, req.region, req.layer, req.component)
    entry = {
        "kind": req.kind,
        "owner": owner,
        "leaf": leaf_rel,
        "account": req.account,
        "region": req.region,
        "layer": req.layer,
        "component": req.component,
        "source_address": req.source_address,
    }
    drafts.save_draft_entry(
        settings.blueprint_root, owner, f"{leaf_rel}::{address}", entry
    )
    return {
        "address": address,
        "owner": owner,
        "leaf": leaf_rel,
        "entry": entry,
        "hcl": hcl,
    }


class DiscardDraftRequest(BaseModel):
    account: str
    region: str
    layer: str
    component: str


@router.delete("/blueprint/draft/{type_}/{name}")
def discard_draft(
    type_: str,
    name: str,
    req: DiscardDraftRequest,
    owner: str = Depends(resolve_owner),
) -> dict[str, Any]:
    if not _DELETE_TYPE_RE.match(type_) or not _NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Invalid type/name")
    settings = get_settings()
    try:
        leaf = leaves.leaf_dir(
            settings.blueprint_root, owner, req.account, req.region, req.layer, req.component
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    res_path = leaf / f"{type_}.{name}.tf"
    if res_path.exists():
        res_path.unlink()
    leaf_rel = leaves.leaf_relpath(req.account, req.region, req.layer, req.component)
    drafts.delete_draft_entry(
        settings.blueprint_root, owner, f"{leaf_rel}::{type_}.{name}"
    )
    leaves.prune_if_empty(leaf)
    return {"address": f"{type_}.{name}", "owner": owner, "discarded": True}


@router.get("/blueprint/drafts")
def list_drafts(owner: str = Depends(resolve_owner)) -> dict[str, Any]:
    """List the requesting owner's pending drafts (the pending-changes bar
    reads this). Each entry is the `_drafts.json` value plus its address."""
    settings = get_settings()
    data = drafts.load_drafts(settings.blueprint_root, owner)
    items = [{"address": address, **entry} for address, entry in data.items()]
    items.sort(key=lambda d: (str(d.get("component") or "~"), d["address"]))
    return {"owner": owner, "drafts": items}


# ---------------------------------------------------------------------------
# DELETE /api/blueprint/resource/{type}/{name}
# ---------------------------------------------------------------------------


@router.delete("/blueprint/resource/{type_}/{name}")
def delete_resource(type_: str, name: str) -> dict[str, Any]:
    """Remove a resource from the canvas: deletes its `.tf` file and
    drops the matching `_layout.json` entry. Idempotent on missing
    files so a double-click in the UI doesn't 404.

    The type check here is *format-only* — any valid HCL resource type
    identifier is accepted, not just `SUPPORTED_TYPES`. The supported-
    types list gates *writes*; deletion needs to work for anything the
    user has on disk, including resources written by the AI agent
    through its `Edit`/`Write` tools (Phase 4 hookup) and orphaned
    files left by failed parses.
    """
    if not _DELETE_TYPE_RE.match(type_):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid resource type identifier {type_!r}.",
        )
    if not _NAME_RE.match(name):
        raise HTTPException(
            status_code=400, detail=f"Invalid resource name {name!r}."
        )

    settings = get_settings()
    file_path = settings.blueprint_root / f"bp.{type_}.{name}.tf"
    # Fall back to the legacy path so a delete still works if the
    # migration hasn't run for some reason.
    legacy_path = settings.blueprint_root / "resources" / f"{type_}.{name}.tf"
    layout_path = settings.blueprint_root / "_layout.json"

    deleted_file = False
    for candidate in (file_path, legacy_path):
        if candidate.exists():
            candidate.unlink()
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
