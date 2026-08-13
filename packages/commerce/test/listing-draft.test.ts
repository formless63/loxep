/**
 * `mapItemToDraftListing` — a pure function, so no database is needed
 * (design 4b, loxep-dgf.6).
 */
import { describe, expect, it } from "vitest";
import { mapItemToDraftListing } from "../src/listing-draft.ts";
import type { DraftListingSourceItem } from "../src/listing-draft.ts";

function baseItem(
  overrides: Partial<DraftListingSourceItem> = {},
): DraftListingSourceItem {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    itemCode: "ITM-8F2K4",
    label: "Brass table lamp",
    catalogItemName: null,
    description: "A vintage brass table lamp, works, no shade.",
    estimatedValueAmount: "45.000000",
    currency: "USD",
    availableToSell: "1",
    conditionCode: "very_good",
    gradingAuthority: null,
    gradeLabel: null,
    gradeNumeric: null,
    certificateNumber: null,
    saleMode: "unit",
    packageWeightGrams: "900.000000",
    packageLengthMm: "300.000000",
    packageWidthMm: "200.000000",
    packageHeightMm: "200.000000",
    ...overrides,
  };
}

describe("mapItemToDraftListing", () => {
  it("maps every enrichment field to its destination", () => {
    const draft = mapItemToDraftListing({
      item: baseItem(),
      channel: "facebook_marketplace",
      specifics: [
        { name: "Brand", value: "Stiffel", unit: null, sortOrder: 1 },
        { name: "Material", value: "Brass", unit: null, sortOrder: 0 },
      ],
      media: [
        { mediaObjectId: "media-2", servingUrl: "/api/media/inventory/media-2", sortOrder: 1 },
        { mediaObjectId: "media-1", servingUrl: "/api/media/inventory/media-1", sortOrder: 0 },
      ],
    });

    expect(draft.inventoryItemId).toBe("11111111-1111-1111-1111-111111111111");
    expect(draft.channel).toBe("facebook_marketplace");
    expect(draft.listingTitle).toBe("Brass table lamp");
    expect(draft.description).toBe("A vintage brass table lamp, works, no shade.");
    expect(draft.price).toBe("45.000000");
    expect(draft.currency).toBe("USD");
    expect(draft.quantityAvailable).toBe(1);
    expect(draft.conditionCode).toBe("very_good");
    expect(draft.grading).toBeNull();
    expect(draft.saleMode).toBe("unit");
    expect(draft.packageWeightGrams).toBe("900.000000");
    // specifics ordered by sort_order
    expect(draft.specifics.map((s) => s.name)).toEqual(["Material", "Brand"]);
    // images ordered by sort_order
    expect(draft.images.map((i) => i.mediaObjectId)).toEqual(["media-1", "media-2"]);
  });

  it("prefers the resolved catalog item name over the item's own label", () => {
    const draft = mapItemToDraftListing({
      item: baseItem({ catalogItemName: "Stiffel Brass Table Lamp" }),
      channel: "craigslist",
      specifics: [],
      media: [],
    });
    expect(draft.listingTitle).toBe("Stiffel Brass Table Lamp");
  });

  it("surfaces grading only when at least one grading field is present", () => {
    const draft = mapItemToDraftListing({
      item: baseItem({ gradingAuthority: "PSA", gradeLabel: "PSA 9", gradeNumeric: "9.0" }),
      channel: "offerup",
      specifics: [],
      media: [],
    });
    expect(draft.grading).toEqual({
      authority: "PSA",
      label: "PSA 9",
      numeric: "9.0",
      certificateNumber: null,
    });
  });

  it("writes nothing and reads nothing — pure in, pure out for the same input", () => {
    const item = baseItem();
    const first = mapItemToDraftListing({ item, channel: "in_person", specifics: [], media: [] });
    const second = mapItemToDraftListing({ item, channel: "in_person", specifics: [], media: [] });
    expect(first).toEqual(second);
  });

  it("clamps a fractional or negative available-to-sell to a whole non-negative count", () => {
    const draft = mapItemToDraftListing({
      item: baseItem({ availableToSell: "-0.5" }),
      channel: "other",
      specifics: [],
      media: [],
    });
    expect(draft.quantityAvailable).toBe(0);
  });
});
