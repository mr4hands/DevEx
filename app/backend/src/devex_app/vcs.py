"""Thin git/gh seam for deterministic promote. `runner` is injectable so the
promote logic is unit-testable without touching a real repo."""

from __future__ import annotations

import logging
import subprocess
from collections.abc import Callable, Sequence

log = logging.getLogger(__name__)

Runner = Callable[[Sequence[str], str], str]


class PromoteError(RuntimeError):
    """Raised when a promote step fails (e.g. pre-commit hook blocks the commit).

    `output` carries the combined stdout+stderr of the failed command so the
    caller can surface the hook message in the HTTP response.
    """

    def __init__(self, message: str, *, output: str = "") -> None:
        super().__init__(message)
        self.output = output


def _default_runner(args: Sequence[str], cwd: str) -> str:
    proc = subprocess.run(
        list(args), cwd=cwd, check=False, capture_output=True, text=True
    )
    if proc.returncode != 0:
        raise PromoteError(
            f"command failed: {' '.join(args)}",
            output=(proc.stdout or "") + (proc.stderr or ""),
        )
    return proc.stdout


def _restore(
    run: Runner,
    repo_root: str,
    original: str,
    branch: str,
    paths: Sequence[str],
) -> None:
    """Best-effort restore so a failed promote never strands the working tree on
    the temp branch. `git clean` is SCOPED to the promoted paths so it only
    removes the files we just rendered, never the user's other untracked files.
    Each step is isolated and logged (not raised) so the original PromoteError
    stays the primary error."""
    steps: list[list[str]] = [
        ["git", "reset", "--", "."],            # unstage the `git add`
        ["git", "clean", "-fd", "--", *paths],  # scoped remove: lets checkout succeed
        ["git", "checkout", original],
        ["git", "branch", "-D", branch],
    ]
    for cmd in steps:
        try:
            run(cmd, repo_root)
        except Exception:  # noqa: BLE001 — cleanup is best-effort; keep PromoteError primary
            log.warning("promote restore step failed: %s", " ".join(cmd), exc_info=True)


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

    # Capture the current ref so we can restore it on failure.
    original = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo_root).strip()
    if original == "HEAD":  # detached HEAD — fall back to the full SHA
        # Restoring to a SHA is acceptable; it leaves the repo in detached-HEAD
        # state, which is the same state it started in.
        original = run(["git", "rev-parse", "HEAD"], repo_root).strip()

    run(["git", "fetch", "origin", base], repo_root)
    run(["git", "checkout", "-b", branch, f"origin/{base}"], repo_root)

    try:
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
    except Exception:
        _restore(run, repo_root, original, branch, list(paths))
        raise
