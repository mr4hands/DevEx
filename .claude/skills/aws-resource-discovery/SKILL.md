---
name: aws-resource-discovery
description: Discover existing (unmanaged) AWS resources for the Blueprint canvas's existing-resources tree. Load when the user asks to discover/list/find existing AWS resources, populate the tree, or "what's already in AWS". Reads via the read-only AWS API MCP; writes a manifest at live/blueprint/_discovered.json. Never mutates AWS and never runs tofu apply/import.
---

# AWS resource discovery → Blueprint manifest

Enumerate existing AWS resources (read-only) and write them into the
discovery manifest the Blueprint "existing (aws)" tree renders. The tree
calls `GET /api/existing-resources`, which serves
`live/blueprint/_discovered.json`. Your job is to fill that file so the
user can drag a resource onto the canvas and adopt it (the canvas writes
an `import { }` block + a `resource { }` body via the deterministic
backend — you do **not** write `bp.*.tf` files).

## Scope

The user (or a seeded prompt) gives a scope:

- `all` — the common supported types listed below.
- a single resource type (e.g. `aws_s3_bucket`) — refresh just that branch.

Default supported types: `aws_s3_bucket`, `aws_instance`, `aws_vpc`,
`aws_subnet`, `aws_iam_role`. You may discover other types when asked.

## How to discover (read-only)

Use the AWS API MCP (`awslabs.aws-api-mcp-server`, `READ_OPERATIONS_ONLY`).
It honors `AWS_ENDPOINT_URL_*`, so a Moto-sourced shell hits Moto and a
vanilla shell hits real AWS. Use the right list/describe call per type and
extract the correct **import id** — the value OpenTofu's
`import { id = ... }` expects, which is **not** always the ARN:

| Type | List call | import_id |
|------|-----------|-----------|
| aws_s3_bucket | s3 ListBuckets | bucket name |
| aws_instance | ec2 DescribeInstances | instance id (i-…) |
| aws_vpc | ec2 DescribeVpcs | vpc id (vpc-…) |
| aws_subnet | ec2 DescribeSubnets | subnet id (subnet-…) |
| aws_iam_role | iam ListRoles | role name |

For any other type, look up its import-id format (the Terraform/OpenTofu
registry "Import" section — the `terraform` MCP can fetch this) before
writing entries. Getting the import id wrong means adoption fails at plan
time, so verify the format rather than guessing.

## Manifest format

Write `live/blueprint/_discovered.json`. **Merge** — never drop branches
you did not just discover. Update `generated_at` and `scopes_loaded`.

```json
{
  "source": "aws",
  "generated_at": "<current UTC ISO-8601>",
  "scopes_loaded": ["aws_s3_bucket"],
  "groups": [
    {
      "type": "aws_s3_bucket",
      "resources": [
        {
          "address": "aws_s3_bucket.<safe_name>",
          "type": "aws_s3_bucket",
          "name": "<safe_name>",
          "import_id": "<real id>",
          "summary_attributes": { "bucket": "<name>", "region": "<region>" }
        }
      ]
    }
  ]
}
```

`name` must be a valid OpenTofu identifier (letters, digits, `_`; start
with a letter or underscore). Derive it from the resource's name/id,
replacing illegal characters with `_`.

### What to put in `summary_attributes`

These are the resource's **live AWS values**, shown in the canvas drawer's
read-only "Set by AWS" section (the user never edits them, and they're
never written into HCL — the backend strips read-only attributes on
write). So capture the deployed identifiers the user would want to see,
including the computed ones:

- always include `arn` when the resource has one (IAM ListRoles returns
  `Arn`; for S3 build `arn:aws:s3:::<bucket>`; EC2/VPC/subnet expose it on
  the describe response),
- `region` and, where relevant, `availability_zone`,
- the human-recognizable config field (bucket name, cidr_block, instance
  type, role name) so the editable form pre-fills sensibly.

The authoritative *editable* config still comes from `generate-config-out`
(the canvas's "generate clean config" button); `summary_attributes` is the
live snapshot for display + a thin pre-fill, so erring toward including
identifiers like `arn` is correct here.

## Rules

- Read-only. Never create/update/delete AWS resources. Never run
  `tofu apply` or the `tofu import` CLI (both denied in `settings.json`).
- Only write `live/blueprint/_discovered.json`. Do not touch `bp.*.tf` or
  any other file.
- If the AWS MCP is unavailable, say so plainly and write nothing.
- After writing, report a one-line summary (counts per type).
