/**
 * The inventory-item → draft-listing mapping (design 4b, loxep-dgf.6).
 *
 * A PURE function: it writes nothing and reads nothing on its own. Every
 * enrichment field Phase 4/M3 added to `inventory_items` has a destination
 * here, and every destination has a source — the design's own table,
 * reproduced field-for-field in {@link mapItemToDraftListing}'s doc below.
 * That is deliberate: it is the proof that section 3's enrichment fields are
 * the right fields, and it is what makes "what would this listing look like"
 * answerable in a preview without ever creating a `channel_listings` row.
 *
 * `@loxep/commerce` takes no dependency on `@loxep/inventory` (see
 * `flipping-lifecycle-design.md`'s package-ownership table — inventory
 * enrichment stays exclusively `@loxep/inventory`'s), so the input here is a
 * Loxep-owned STRUCTURAL shape the caller assembles from whatever it already
 * loaded (an `InventoryItemDetailDto`, a raw `inventory_items` row plus its
 * specifics/media reads — anything with these fields), the same pattern
 * `EbayOrderFactLike` and `EbayPurchaseFact` already use to cross a package
 * boundary without a type-level dependency.
 */
import { z } from "zod";
import { CommerceValidationError } from "./errors.ts";

/** The subset of `inventory_items` (plus its resolved location/lot facts) the mapping reads. */
export interface DraftListingSourceItem {
  id: string;
  itemCode: string;
  label: string;
  /** Resolved catalog item name, when one exists — preferred over `label` per the design's mapping table. */
  catalogItemName?: string | null;
  description: string | null;
  /** The operator's target resale price — NOT a valuation. */
  estimatedValueAmount: string | null;
  currency: string;
  /** Available-to-sell, read live (not the cached `quantity_on_hand`). */
  availableToSell: string;
  conditionCode: string;
  gradingAuthority: string | null;
  gradeLabel: string | null;
  gradeNumeric: string | null;
  certificateNumber: string | null;
  saleMode: string;
  packageWeightGrams: string | null;
  packageLengthMm: string | null;
  packageWidthMm: string | null;
  packageHeightMm: string | null;
}

/** One `inventory_item_specifics` row. */
export interface DraftListingSourceSpecific {
  name: string;
  value: string;
  unit: string | null;
  sortOrder: number;
}

/** One `media_links` gallery row over the item, already ordered by `sort_order`. */
export interface DraftListingSourceMedia {
  mediaObjectId: string;
  servingUrl: string;
  sortOrder: number | null;
}

export interface DraftListingSpecific {
  name: string;
  value: string;
  unit: string | null;
}

/**
 * The mapped preview. Field-for-field the design's table:
 *
 * ```text
 * draft listing field      <- source
 * -----------------------  ------------------------------------
 * listingTitle              inventory_items.label, or the resolved catalog
 *                            item name
 * description                inventory_items.description
 * price                      inventory_items.estimated_value_amount
 * currency                   inventory_items.currency
 * quantityAvailable           available-to-sell for the item
 * condition                  inventory_items.condition_code (mapped to the
 *                            channel's own vocabulary by an ADAPTER this
 *                            function does not own — out of scope here, per
 *                            4b: per-provider publish is a later milestone)
 * grading                    grading_authority / grade_label / grade_numeric /
 *                            certificate_number
 * images                      media_links(inventory_item, gallery) in
 *                            sort_order
 * specifics                  inventory_item_specifics
 * packageWeightGrams/Mm       package_weight_grams, package_*_mm
 * saleMode                   sale_mode (unit -> one listing; lot/set -> one
 *                            listing for the group; parted_out -> one
 *                            listing per child — this function maps ONE
 *                            item to ONE draft; a parted-out item's children
 *                            are separate `inventory_items` rows and each
 *                            gets its own call)
 * ```
 */
export interface DraftListing {
  inventoryItemId: string;
  channel: string;
  listingTitle: string;
  description: string | null;
  price: string | null;
  currency: string;
  quantityAvailable: number;
  conditionCode: string;
  grading: {
    authority: string | null;
    label: string | null;
    numeric: string | null;
    certificateNumber: string | null;
  } | null;
  saleMode: string;
  packageWeightGrams: string | null;
  packageLengthMm: string | null;
  packageWidthMm: string | null;
  packageHeightMm: string | null;
  specifics: DraftListingSpecific[];
  images: { mediaObjectId: string; servingUrl: string }[];
}

const inputSchema = z.strictObject({
  item: z.custom<DraftListingSourceItem>(
    (value) => typeof value === "object" && value !== null,
    "expected an inventory item",
  ),
  channel: z.string().trim().min(1),
  specifics: z.array(z.custom<DraftListingSourceSpecific>()).default([]),
  media: z.array(z.custom<DraftListingSourceMedia>()).default([]),
});

export type MapItemToDraftListingInput = z.input<typeof inputSchema>;

/**
 * The pure mapping. Never touches a database, never mints a code, never
 * resolves a catalog item — those are {@link CatalogService}'s job when the
 * operator actually creates the listing. This function only answers "what
 * would it look like".
 */
export function mapItemToDraftListing(
  input: MapItemToDraftListingInput,
): DraftListing {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CommerceValidationError(
      `invalid draft-listing mapping input: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
        .join("; ")}`,
    );
  }
  const { item, channel, specifics, media } = parsed.data;

  const hasGrading =
    item.gradingAuthority !== null ||
    item.gradeLabel !== null ||
    item.gradeNumeric !== null ||
    item.certificateNumber !== null;

  const sortedSpecifics = [...specifics].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  const sortedMedia = [...media].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
  );

  return {
    inventoryItemId: item.id,
    channel,
    listingTitle: item.catalogItemName?.trim() || item.label,
    description: item.description,
    price: item.estimatedValueAmount,
    currency: item.currency,
    quantityAvailable: Math.max(0, Math.trunc(Number(item.availableToSell))),
    conditionCode: item.conditionCode,
    grading: hasGrading
      ? {
          authority: item.gradingAuthority,
          label: item.gradeLabel,
          numeric: item.gradeNumeric,
          certificateNumber: item.certificateNumber,
        }
      : null,
    saleMode: item.saleMode,
    packageWeightGrams: item.packageWeightGrams,
    packageLengthMm: item.packageLengthMm,
    packageWidthMm: item.packageWidthMm,
    packageHeightMm: item.packageHeightMm,
    specifics: sortedSpecifics.map((specific) => ({
      name: specific.name,
      value: specific.value,
      unit: specific.unit,
    })),
    images: sortedMedia.map((entry) => ({
      mediaObjectId: entry.mediaObjectId,
      servingUrl: entry.servingUrl,
    })),
  };
}
