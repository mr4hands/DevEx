/**
 * Maps an AWS resource type (e.g. `aws_vpc`, `aws_security_group`) to a
 * family color + 2-letter monogram. Used by ResourceList's group header
 * (the colored chip + vertical rail under each row).
 *
 * Families are coarse on purpose — they group "things that mean the
 * same thing to a reader scanning the list." Security overlaps with IAM
 * less than with KMS, etc. When a new resource type lands, prefer
 * adding it to an existing family before introducing a new one.
 */

export type ResourceFamily =
  | "network"
  | "security"
  | "iam"
  | "compute"
  | "storage"
  | "data"
  | "default";

export type FamilyMeta = {
  family: ResourceFamily;
  monogram: string; // 2 chars, lowercase, no styling
};

export function familyOf(type: string): FamilyMeta {
  // Network
  if (type === "aws_vpc") return { family: "network", monogram: "vp" };
  if (type === "aws_subnet") return { family: "network", monogram: "sn" };
  if (type === "aws_internet_gateway") return { family: "network", monogram: "ig" };
  if (type === "aws_nat_gateway") return { family: "network", monogram: "ng" };
  if (type === "aws_eip") return { family: "network", monogram: "ip" };
  if (type === "aws_route_table" || type === "aws_route_table_association")
    return { family: "network", monogram: "rt" };
  if (type === "aws_route") return { family: "network", monogram: "ro" };

  // Security
  if (type === "aws_security_group" || type === "aws_default_security_group")
    return { family: "security", monogram: "sg" };
  if (type.startsWith("aws_kms_")) return { family: "security", monogram: "km" };

  // IAM
  if (type.startsWith("aws_iam_role")) return { family: "iam", monogram: "ir" };
  if (type.startsWith("aws_iam_policy") || type.startsWith("aws_iam_user_policy"))
    return { family: "iam", monogram: "ip" };
  if (type.startsWith("aws_iam_")) return { family: "iam", monogram: "ia" };

  // Compute
  if (type === "aws_instance") return { family: "compute", monogram: "ec" };
  if (type.startsWith("aws_ecs_")) return { family: "compute", monogram: "cs" };
  if (type.startsWith("aws_lambda_")) return { family: "compute", monogram: "la" };
  if (type === "aws_autoscaling_group" || type === "aws_launch_template")
    return { family: "compute", monogram: "as" };
  if (type === "aws_ami") return { family: "compute", monogram: "ai" };

  // Storage
  if (type.startsWith("aws_s3_")) return { family: "storage", monogram: "s3" };
  if (type === "aws_ebs_volume") return { family: "storage", monogram: "eb" };

  // Data
  if (type.startsWith("aws_rds_") || type.startsWith("aws_db_"))
    return { family: "data", monogram: "db" };
  if (type.startsWith("aws_dynamodb_")) return { family: "data", monogram: "dy" };
  if (type.startsWith("aws_elasticache_")) return { family: "data", monogram: "ec" };

  // Default — derive a 2-letter monogram from the type's first word.
  const tail = type.replace(/^aws_/, "").split("_");
  const monogram = (tail[0]?.slice(0, 2) ?? "??").toLowerCase();
  return { family: "default", monogram };
}

/**
 * Tailwind class strings for each family. Status colors live outside the
 * theme (per DESIGN.md), and the same rule applies here — these are
 * direct Tailwind utilities, not theme tokens.
 */
export const FAMILY_CLASSES: Record<
  ResourceFamily,
  { chip: string; rail: string }
> = {
  network: {
    chip:
      "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-900",
    rail: "bg-sky-300 dark:bg-sky-700",
  },
  security: {
    chip:
      "bg-red-50 text-red-700 ring-red-200 dark:bg-red-950 dark:text-red-300 dark:ring-red-900",
    rail: "bg-red-300 dark:bg-red-700",
  },
  iam: {
    chip:
      "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900",
    rail: "bg-amber-300 dark:bg-amber-700",
  },
  compute: {
    chip:
      "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900",
    rail: "bg-emerald-300 dark:bg-emerald-700",
  },
  storage: {
    chip:
      "bg-stone-50 text-stone-600 ring-stone-200 dark:bg-stone-900 dark:text-stone-400 dark:ring-stone-800",
    rail: "bg-stone-300 dark:bg-stone-700",
  },
  data: {
    chip:
      "bg-stone-50 text-stone-600 ring-stone-200 dark:bg-stone-900 dark:text-stone-400 dark:ring-stone-800",
    rail: "bg-stone-300 dark:bg-stone-700",
  },
  default: {
    chip: "bg-muted text-muted-foreground ring-border",
    rail: "bg-border",
  },
};

/** Returns just the leaf segment of an address.
 *  `module.network.aws_subnet.public[0]` → `public[0]`. */
export function leafOf(address: string): string {
  // The resource label may contain `[...]` for for_each keys; split on dots
  // but keep brackets intact.
  const parts = address.split(".");
  return parts[parts.length - 1] ?? address;
}
