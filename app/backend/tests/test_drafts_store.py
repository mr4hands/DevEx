from __future__ import annotations

from devex_app import drafts


def test_owner_dir_is_namespaced(tmp_path):
    d = drafts.owner_dir(tmp_path, "alice")
    assert d == (tmp_path / "drafts" / "alice").resolve()


def test_owner_dir_rejects_escape(tmp_path):
    # Defense-in-depth: owner_dir refuses paths that resolve ABOVE the
    # blueprint root (the route-layer regex blocks the rest).
    import pytest

    for bad in ("../../etc", "/absolute/path"):
        with pytest.raises(ValueError):
            drafts.owner_dir(tmp_path, bad)


def test_save_and_load_draft(tmp_path):
    drafts.save_draft_entry(
        tmp_path, "alice", "aws_s3_bucket.logs", {"kind": "new", "owner": "alice"}
    )
    loaded = drafts.load_drafts(tmp_path, "alice")
    assert loaded["aws_s3_bucket.logs"]["kind"] == "new"
    # Different owner is isolated.
    assert drafts.load_drafts(tmp_path, "bob") == {}


def test_delete_draft_entry(tmp_path):
    drafts.save_draft_entry(tmp_path, "alice", "aws_vpc.main", {"kind": "edit"})
    drafts.delete_draft_entry(tmp_path, "alice", "aws_vpc.main")
    assert drafts.load_drafts(tmp_path, "alice") == {}


def test_malformed_drafts_file_is_ignored(tmp_path):
    d = drafts.owner_dir(tmp_path, "alice")
    d.mkdir(parents=True)
    (d / "_drafts.json").write_text("{not json")
    assert drafts.load_drafts(tmp_path, "alice") == {}
