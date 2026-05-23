"""Thin git/gh seam for deterministic promote. `runner` is injectable so the
promote logic is unit-testable without touching a real repo."""

from __future__ import annotations

import subprocess
from collections.abc import Callable, Sequence

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
) -> None:
    """Best-effort cleanup: unstage, restore original branch, delete temp branch.

    Each step is wrapped individually so a failure in one step does not prevent
    the remaining steps from running, and none of them can mask the original
    exception (caller re-raises after calling this).
    """
    for cmd in (
        ["git", "reset", "--", "."],
        ["git", "checkout", original],
        ["git", "branch", "-D", branch],
    ):
        try:
            run(cmd, repo_root)
        except Exception:
            pass


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
        _restore(run, repo_root, original, branch)
        raise
