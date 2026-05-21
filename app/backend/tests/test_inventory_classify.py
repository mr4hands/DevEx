from __future__ import annotations

from devex_app.inventory import account_region, classify_component


def test_classify_prefers_override():
    comp, src = classify_component(
        {"Component": "frontend"}, "aws_s3_bucket.x", {"aws_s3_bucket.x": "solr"}
    )
    assert comp == "solr" and src == "override"


def test_classify_falls_back_to_tag_precedence():
    assert classify_component({"Service": "jenkins"}, "a", {}) == ("jenkins", "tag")
    # Component wins over Service when both present.
    assert classify_component(
        {"Component": "solr", "Service": "x"}, "a", {}
    ) == ("solr", "tag")


def test_classify_unassigned_when_nothing_matches():
    assert classify_component({}, "a", {}) == ("Unassigned", "unassigned")


def test_account_region_parses_arn():
    acct, region = account_region(
        {"arn": "arn:aws:ec2:us-east-1:123456789012:instance/i-0ab"}
    )
    assert acct == "123456789012" and region == "us-east-1"


def test_account_region_falls_back_to_region_attr():
    # S3 arns carry no account/region; fall back to the region attribute.
    acct, region = account_region(
        {"arn": "arn:aws:s3:::my-bucket", "region": "eu-west-1"}
    )
    assert region == "eu-west-1" and acct == "unknown"


def test_account_region_unknown_when_absent():
    assert account_region({}) == ("unknown", "unknown")
