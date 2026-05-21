/**
 * Static palette config for the Blueprint canvas.
 *
 * Each entry corresponds to a resource type the `/api/schemas`
 * endpoint advertises (see `app/backend/.../routes/blueprint.py
 * SUPPORTED_TYPES`). The palette tile shows the family-colored
 * monogram (matching `lib/resourceFamilies.ts`) and a short label;
 * dragging the tile onto the canvas creates a placeholder node of
 * that resource type.
 *
 * Adding a new resource type requires changes on both ends:
 *   1. Backend `SUPPORTED_TYPES` in routes/blueprint.py
 *   2. Frontend entry below
 */

import { familyOf, type ResourceFamily } from "./resourceFamilies";

export type PaletteItem = {
  /** AWS resource type, e.g. `aws_s3_bucket`. Used as the canvas
   *  node's resourceType discriminator. */
  type: string;
  /** Friendly name shown on the palette tile, e.g. "S3 bucket". */
  label: string;
  /** Family color/monogram derived from `familyOf(type)`. */
  family: ResourceFamily;
  monogram: string;
};

const TYPES = [
  "aws_s3_bucket",
  "aws_instance",
  "aws_vpc",
  "aws_subnet",
  "aws_iam_role",
] as const;

const LABELS: Record<(typeof TYPES)[number], string> = {
  aws_s3_bucket: "S3 bucket",
  aws_instance: "EC2 instance",
  aws_vpc: "VPC",
  aws_subnet: "Subnet",
  aws_iam_role: "IAM role",
};

export const PALETTE: PaletteItem[] = TYPES.map((type) => {
  const meta = familyOf(type);
  return {
    type,
    label: LABELS[type],
    family: meta.family,
    monogram: meta.monogram,
  };
});

/** MIME type used for HTML5 drag-and-drop on the palette tiles. */
export const PALETTE_DRAG_TYPE = "application/devex.blueprint.type";

/** MIME type for dragging an existing (discovered/unmanaged) resource from
 *  the unified tree onto the canvas to adopt it. The canvas's onDrop reads
 *  this; the payload is `{ type, name, import_id, summary_attributes }`. */
export const EXISTING_DRAG_TYPE = "application/devex-existing";
