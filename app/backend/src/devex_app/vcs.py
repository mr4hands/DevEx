"""Thin git/gh seam for deterministic promote. `runner` is injectable so the
promote logic is unit-testable without touching a real repo."""

from __future__ import annotations

import subprocess
from collections.abc import Callable, Sequence

Runner = Callable[[Sequence[str], str], str]


def _default_runner(args: Sequence[str], cwd: str) -> str:
    return subprocess.run(
        list(args), cwd=cwd, check=True, capture_output=True, text=True
    ).stdout


def promote_branch(
    *,
    repo_root: str,
    branch: str,
    paths: Sequence[str],
    commit_message: str,
    pr_title: str,
    pr_body: str,
    base: str = "main",
    runner: Runner | None = None,
) -> str:
    """Branch off the latest origin/<base>, commit the given paths, push, open a
    PR against <base>. Returns the PR URL. Never branches off a feature branch."""
    run = runner or _default_runner
    run(["git", "fetch", "origin", base], repo_root)
    run(["git", "checkout", "-b", branch, f"origin/{base}"], repo_root)
    run(["git", "add", *paths], repo_root)
    run(["git", "commit", "-m", commit_message], repo_root)
    run(["git", "push", "-u", "origin", branch], repo_root)
    out = run(
        [
            "gh", "pr", "create", "--base", base, "--head", branch,
            "--title", pr_title, "--body", pr_body,
        ],
        repo_root,
    )
    return out.strip().splitlines()[-1].strip()
