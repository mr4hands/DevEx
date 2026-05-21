"""Pure classification helpers for the unified resource inventory.

Kept side-effect-free so they're trivially unit-testable; the route in
`routes/inventory.py` wires them to the live data sources.
"""

from __future__ import annotations

import re
from typing import Any

# arn:aws:<service>:<region>:<account>:<resource>. region/account are empty
# for some services (e.g. S3, IAM), so callers fall back to attributes.
_ARN_RE = re.compile(r"^arn:aws[^:]*:[^:]*:(?P<region>[^:]*):(?P<account>[^:]*):")

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
