from __future__ import annotations

import pytest

from devex_app import vcs


def test_open_pr_branches_off_main_and_targets_main():
    calls = []

    def runner(args, cwd):
        calls.append(list(args))
        if list(args)[:3] == ["gh", "pr", "create"]:
            return "https://github.com/o/r/pull/1\n"
        return ""

    url = vcs.promote_branch(
        repo_root="/repo",
        branch="devex/alice-20260522",
        paths=["live/devex-live"],
        commit_message="promote",
        pr_title="t",
        pr_body="b",
        runner=runner,
    )
    assert url == "https://github.com/o/r/pull/1"
    # Branch is created off origin/main, never a feature branch.
    assert ["git", "fetch", "origin", "main"] in calls
    assert any(a[:2] == ["git", "checkout"] and "origin/main" in a for a in calls)
    # PR targets main.
    pr = next(a for a in calls if a[:3] == ["gh", "pr", "create"])
    assert "--base" in pr and pr[pr.index("--base") + 1] == "main"


def test_promote_branch_restores_original_branch_on_commit_failure():
    calls = []

    def runner(args, cwd):
        a = list(args)
        calls.append(a)
        if a[:2] == ["git", "rev-parse"]:
            return "feat/work\n"
        if a[:2] == ["git", "commit"]:
            raise vcs.PromoteError("commit failed", output="checkov: CKV2_AWS_12 failed")
        if a[:3] == ["gh", "pr", "create"]:
            return "https://github.com/o/r/pull/1\n"
        return ""

    with pytest.raises(vcs.PromoteError) as ei:
        vcs.promote_branch(
            repo_root="/repo", branch="devex/x", paths=["live/devex-live"],
            commit_message="m", pr_title="t", pr_body="b", runner=runner,
        )
    assert "checkov" in ei.value.output
    # Restored: checked out the original branch and deleted the temp branch.
    assert any(a[:2] == ["git", "checkout"] and a[-1] == "feat/work" for a in calls)
    assert ["git", "branch", "-D", "devex/x"] in calls
    # A failed commit must not push or open a PR.
    assert not any(a[:2] == ["git", "push"] for a in calls)
    assert not any(a[:3] == ["gh", "pr", "create"] for a in calls)
    # The render is cleaned (scoped) before we check out the original branch,
    # so an untracked render can't block the restore.
    clean_idx = next(i for i, a in enumerate(calls)
                     if a[:3] == ["git", "clean", "-fd"])
    checkout_orig_idx = next(i for i, a in enumerate(calls)
                             if a[:2] == ["git", "checkout"] and a[-1] == "feat/work")
    assert clean_idx < checkout_orig_idx
