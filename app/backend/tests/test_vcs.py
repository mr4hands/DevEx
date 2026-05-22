from __future__ import annotations

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
