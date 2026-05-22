"""Deterministic promote: render the owner's overlay into devex-live, branch
off main, and open a PR. No agent."""

from __future__ import annotations

import datetime as _dt
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import drafts, leaves, vcs
from ..settings import get_settings
from ._deps import resolve_owner

router = APIRouter()


class PromoteRequest(BaseModel):
    pass  # whole-overlay promote for now


@router.post("/blueprint/promote")
def promote(req: PromoteRequest, owner: str = Depends(resolve_owner)) -> dict[str, Any]:
    settings = get_settings()
    rel_leaves = leaves.overlay_leaves(settings.blueprint_root, owner)
    if not rel_leaves:
        raise HTTPException(status_code=400, detail="No drafts to promote.")

    rendered = leaves.render_overlay(
        settings.blueprint_root, owner, settings.devex_live_root
    )
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%d-%H%M%S")
    branch = f"devex/{owner}-{stamp}"
    devex_rel = settings.devex_live_root.relative_to(settings.repo_root).as_posix()
    pr_url = vcs.promote_branch(
        repo_root=str(settings.repo_root),
        branch=branch,
        paths=[f"{devex_rel}/{r}" for r in rendered],
        commit_message=(
            f"feat(devex-live): promote {owner}'s drafts "
            f"({len(rendered)} leaf/leaves)"
        ),
        pr_title=f"devex-live: {owner} promote ({len(rendered)} leaf/leaves)",
        pr_body=(
            "Promoted from the DevEx platform overlay.\n\n"
            + "\n".join(f"- {r}" for r in rendered)
        ),
    )

    # Clear promoted drafts + overlay leaves.
    data = drafts.load_drafts(settings.blueprint_root, owner)
    for key in [k for k, v in data.items() if v.get("leaf") in rendered]:
        drafts.delete_draft_entry(settings.blueprint_root, owner, key)
    for r in rendered:
        leaf = leaves.owner_overlay_dir(settings.blueprint_root, owner) / r
        for p in leaf.glob("*"):
            p.unlink()
        leaf.rmdir()

    return {"owner": owner, "leaves": rendered, "pr_url": pr_url, "branch": branch}
