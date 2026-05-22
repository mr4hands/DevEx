from __future__ import annotations

from devex_app.agent import SYSTEM_PROMPT_APPEND


def test_agent_prompt_uses_flat_bp_layout_not_legacy_resources_dir():
    """The chat agent's blueprint-write guidance must match the shipped flat
    `bp.<type>.<name>.tf` root layout. The old `live/blueprint/resources/`
    subdir layout only survives via a legacy-migration shim, so instructing
    the agent to write there is stale and should never regress back."""
    assert "live/blueprint/resources/" not in SYSTEM_PROMPT_APPEND
    assert "bp.<aws_type>.<name>.tf" in SYSTEM_PROMPT_APPEND
