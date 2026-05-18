/**
 * Per-resource-type "what's worth showing at the top" helpers.
 *
 * Used by `ResourceDrawer` to pick a sensible Identity section without
 * dumping every attribute. Falls back to a generic ID/ARN pair when the
 * type isn't specifically known.
 */

import type { Resource } from "./types";

export type IdentityField = {
  label: string; // short uppercase label, e.g. "ID", "ARN", "VPC"
  value: string;
  /** Whether the value is monospaced + truncatable + copyable. */
  copyable?: boolean;
};

function pickStringField(
  values: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const k of keys) {
    const v = values[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return null;
}

export function identityFieldsFor(r: Resource): IdentityField[] {
  const v = r.values;
  const fields: IdentityField[] = [];

  const id = pickStringField(v, "id");
  if (id) fields.push({ label: "ID", value: id, copyable: true });

  const arn = pickStringField(v, "arn");
  if (arn) fields.push({ label: "ARN", value: arn, copyable: true });

  // Type-specific add-ons (chosen for "what would a reader want to see
  // without opening the raw dump")
  switch (true) {
    case r.type === "aws_security_group" ||
      r.type === "aws_default_security_group": {
      const vpc = pickStringField(v, "vpc_id");
      if (vpc) fields.push({ label: "VPC", value: vpc, copyable: true });
      const name = pickStringField(v, "name");
      if (name) fields.push({ label: "Name", value: name });
      break;
    }
    case r.type === "aws_vpc": {
      const cidr = pickStringField(v, "cidr_block");
      if (cidr) fields.push({ label: "CIDR", value: cidr });
      break;
    }
    case r.type === "aws_subnet": {
      const vpc = pickStringField(v, "vpc_id");
      if (vpc) fields.push({ label: "VPC", value: vpc, copyable: true });
      const cidr = pickStringField(v, "cidr_block");
      if (cidr) fields.push({ label: "CIDR", value: cidr });
      const az = pickStringField(v, "availability_zone");
      if (az) fields.push({ label: "AZ", value: az });
      break;
    }
    case r.type === "aws_instance": {
      const ami = pickStringField(v, "ami");
      if (ami) fields.push({ label: "AMI", value: ami, copyable: true });
      const type_ = pickStringField(v, "instance_type");
      if (type_) fields.push({ label: "Type", value: type_ });
      const subnet = pickStringField(v, "subnet_id");
      if (subnet) fields.push({ label: "Subnet", value: subnet, copyable: true });
      break;
    }
    case r.type.startsWith("aws_s3_bucket"): {
      const bucket = pickStringField(v, "bucket");
      if (bucket && bucket !== id) {
        fields.push({ label: "Bucket", value: bucket, copyable: true });
      }
      const region = pickStringField(v, "region");
      if (region) fields.push({ label: "Region", value: region });
      break;
    }
    case r.type.startsWith("aws_iam_role"): {
      const name = pickStringField(v, "name");
      if (name && name !== id) fields.push({ label: "Name", value: name });
      const path = pickStringField(v, "path");
      if (path && path !== "/") fields.push({ label: "Path", value: path });
      break;
    }
    case r.type === "aws_internet_gateway":
    case r.type === "aws_nat_gateway":
    case r.type === "aws_route_table": {
      const vpc = pickStringField(v, "vpc_id");
      if (vpc) fields.push({ label: "VPC", value: vpc, copyable: true });
      break;
    }
  }

  return fields;
}

/**
 * Returns the attribute paths whose JSON-serialized values differ
 * between two attribute payloads. Identical to PlanDiff's helper —
 * kept generic so the drawer can compute its own change summary when
 * given a `change` prop.
 */
export function changedKeys(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): string[] {
  if (!before && !after) return [];
  const a = before ?? {};
  const b = after ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    const av = JSON.stringify(a[k] ?? null);
    const bv = JSON.stringify(b[k] ?? null);
    if (av !== bv) out.push(k);
  }
  return out.sort();
}

/**
 * Expands top-level changed keys into per-leaf change rows.
 *
 * For scalar attributes: returns one row with key = attribute name.
 * For object/map attributes (like `tags`, `tags_all`): walks one level
 * deep and returns one row per changed nested key (e.g.,
 * `tags.Environment`).
 *
 * Arrays are not expanded — the whole array is shown as one row,
 * stringified. Good enough for v1; deep-tree diffing would belong in
 * its own component.
 */
export type LeafChange = {
  path: string; // e.g. "tags.Environment" or "instance_type"
  before: unknown;
  after: unknown;
};

export function expandChanges(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): LeafChange[] {
  const out: LeafChange[] = [];
  const a = before ?? {};
  const b = after ?? {};
  const topLevel = changedKeys(a, b);
  for (const k of topLevel) {
    const av = a[k];
    const bv = b[k];
    // Plain-object dive: one level only.
    if (isPlainObject(av) || isPlainObject(bv)) {
      const ao = (isPlainObject(av) ? av : {}) as Record<string, unknown>;
      const bo = (isPlainObject(bv) ? bv : {}) as Record<string, unknown>;
      const nestedKeys = changedKeys(ao, bo);
      for (const nk of nestedKeys) {
        out.push({ path: `${k}.${nk}`, before: ao[nk], after: bo[nk] });
      }
    } else {
      out.push({ path: k, before: av, after: bv });
    }
  }
  return out;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return (
    typeof x === "object" &&
    x !== null &&
    !Array.isArray(x) &&
    Object.getPrototypeOf(x) === Object.prototype
  );
}

export function fmtValue(v: unknown): string {
  // Match the OpenTofu/Terraform CLI plan output convention: both
  // undefined attributes (not present in the payload at all) and
  // null attributes render as `null` so users see the same string
  // here that they'd see in `tofu plan` output.
  if (v === undefined) return "null";
  if (v === null) return "null";
  if (typeof v === "string") return `"${v}"`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return String(v);
  }
}

/** Action-kind labels and chip colors, matching PlanDiff. */
export const ACTION_CHIP: Record<
  string,
  { label: string; glyph: string; classes: string }
> = {
  create: {
    label: "create",
    glyph: "+",
    classes:
      "text-emerald-800 bg-emerald-100 ring-emerald-200 dark:text-emerald-300 dark:bg-emerald-950 dark:ring-emerald-900",
  },
  update: {
    label: "update",
    glyph: "~",
    classes:
      "text-amber-800 bg-amber-100 ring-amber-200 dark:text-amber-300 dark:bg-amber-950 dark:ring-amber-900",
  },
  delete: {
    label: "destroy",
    glyph: "-",
    classes:
      "text-red-800 bg-red-100 ring-red-200 dark:text-red-300 dark:bg-red-950 dark:ring-red-900",
  },
  replace: {
    label: "replace",
    glyph: "±",
    classes:
      "text-orange-800 bg-orange-100 ring-orange-200 dark:text-orange-300 dark:bg-orange-950 dark:ring-orange-900",
  },
  import: {
    label: "import",
    glyph: "→",
    classes:
      "text-sky-800 bg-sky-100 ring-sky-200 dark:text-sky-300 dark:bg-sky-950 dark:ring-sky-900",
  },
  import_update: {
    label: "import + update",
    glyph: "→~",
    classes:
      "text-sky-800 bg-sky-100 ring-sky-200 dark:text-sky-300 dark:bg-sky-950 dark:ring-sky-900",
  },
};
