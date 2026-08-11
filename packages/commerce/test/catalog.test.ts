/**
 * Catalog item and channel-listing integration tests against real PostgreSQL.
 */
import type { WooProductFact } from "@loxep/integration-woo";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCatalogService } from "../src/catalog.ts";
import type { CatalogService } from "../src/catalog.ts";
import { CommerceConflictError, CommerceValidationError } from "../src/errors.ts";
import { createMigratedScratchDb, seedConnection, seedEntity } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

function wooProduct(
  overrides: Partial<WooProductFact> & { externalProductId: string },
): WooProductFact {
  return {
    sku: null,
    name: "Product",
    status: "publish",
    price: "10.00",
    type: "simple",
    permalink: null,
    updatedAt: null,
    raw: {},
    ...overrides,
  };
}

describe("catalog and channel listings", () => {
  let scratch: ScratchDb;
  let catalog: CatalogService;
  let connectionId: string;
  let entityId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_commerce_catalog");
    catalog = createCatalogService({ db: scratch.handle.db });
    entityId = await seedEntity(scratch, "Syracuse Synergy LLC");
    connectionId = await seedConnection(scratch, {
      name: "store",
      economicEntityId: entityId,
    });
  });

  afterAll(async () => {
    await scratch.close();
  });

  it("creates a catalog item and finds it by SKU", async () => {
    const item = await catalog.createCatalogItem({
      sku: "SKU-ALPHA",
      name: "Alpha widget",
      economicEntityId: entityId,
      defaultCurrency: "usd",
      defaultPrice: "24.99",
    });
    expect(item.kind).toBe("simple");
    expect(item.status).toBe("active");
    // Currency is normalized; price stays an exact decimal string.
    expect(item.defaultCurrency).toBe("USD");
    expect(item.defaultPrice).toBe("24.990000");

    const found = await catalog.findCatalogItemBySku("SKU-ALPHA");
    expect(found?.id).toBe(item.id);
  });

  it("enforces SKU uniqueness INSTALLATION-WIDE, across entities", async () => {
    const otherEntityId = await seedEntity(scratch, "Other identity", "individual");
    await expect(
      catalog.createCatalogItem({
        sku: "SKU-ALPHA",
        name: "A different product with the same SKU",
        economicEntityId: otherEntityId,
      }),
    ).rejects.toBeInstanceOf(CommerceConflictError);
  });

  it("requires a parent for a variant and rejects one for a simple item", async () => {
    const group = await catalog.createCatalogItem({
      sku: "SKU-GROUP",
      name: "Widget (all sizes)",
      kind: "variant_group",
    });
    const variant = await catalog.createCatalogItem({
      sku: "SKU-GROUP-L",
      name: "Widget (large)",
      kind: "variant",
      parentCatalogItemId: group.id,
      variantLabel: "Large",
    });
    expect(variant.parentCatalogItemId).toBe(group.id);

    await expect(
      catalog.createCatalogItem({
        sku: "SKU-BROKEN",
        name: "Broken",
        kind: "variant",
      }),
    ).rejects.toBeInstanceOf(CommerceValidationError);
  });

  it("upserts a channel listing without duplicating the null-variation row", async () => {
    const item = await catalog.createCatalogItem({
      sku: "SKU-LISTED",
      name: "Listed widget",
    });
    const first = await catalog.upsertChannelListing({
      catalogItemId: item.id,
      connectionId,
      provider: "woocommerce",
      channel: "woocommerce",
      externalListingId: "700",
      status: "active",
      price: "24.99",
      currency: "USD",
      quantityAvailable: 3,
    });
    const second = await catalog.upsertChannelListing({
      catalogItemId: item.id,
      connectionId,
      provider: "woocommerce",
      channel: "woocommerce",
      externalListingId: "700",
      status: "sold_out",
      quantityAvailable: 0,
    });

    // NULLS NOT DISTINCT is what makes this converge instead of duplicating.
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("sold_out");
    expect(second.quantityAvailable).toBe(0);
    expect(second.firstIngestedAt.getTime()).toBe(
      first.firstIngestedAt.getTime(),
    );

    const listings = await catalog.listChannelListings({ connectionId });
    expect(listings.filter((row) => row.externalListingId === "700")).toHaveLength(
      1,
    );
  });

  it("keeps variations distinct from the base listing", async () => {
    const item = await catalog.createCatalogItem({
      sku: "SKU-VARIED",
      name: "Varied widget",
    });
    const base = await catalog.upsertChannelListing({
      catalogItemId: item.id,
      connectionId,
      provider: "woocommerce",
      channel: "woocommerce",
      externalListingId: "800",
    });
    const variation = await catalog.upsertChannelListing({
      catalogItemId: item.id,
      connectionId,
      provider: "woocommerce",
      channel: "woocommerce",
      externalListingId: "800",
      externalVariationId: "801",
    });
    expect(variation.id).not.toBe(base.id);
  });

  describe("suggestChannelLinks", () => {
    it("matches channel SKUs to catalog SKUs and writes nothing", async () => {
      const item = await catalog.createCatalogItem({
        sku: "SKU-MATCH",
        name: "Matchable widget",
      });
      const before = await catalog.listChannelListings({ connectionId });

      const suggestions = await catalog.suggestWooChannelLinks({
        connectionId,
        products: [
          wooProduct({ externalProductId: "900", sku: "SKU-MATCH", name: "M" }),
          wooProduct({ externalProductId: "901", sku: "sku-match", name: "m" }),
          wooProduct({ externalProductId: "902", sku: "SKU-NOPE", name: "n" }),
          wooProduct({ externalProductId: "903", sku: null, name: "no sku" }),
        ],
      });

      expect(suggestions).toHaveLength(2);
      const exact = suggestions.find((s) => s.externalListingId === "900");
      const folded = suggestions.find((s) => s.externalListingId === "901");
      expect(exact?.matchReason).toBe("exact_sku");
      expect(exact?.catalogItemId).toBe(item.id);
      expect(folded?.matchReason).toBe("normalized_sku");
      expect(exact?.alreadyLinked).toBe(false);

      // Read-only: no listing was created.
      const after = await catalog.listChannelListings({ connectionId });
      expect(after).toHaveLength(before.length);
    });

    it("reports an existing link instead of proposing a second one", async () => {
      const item = await catalog.createCatalogItem({
        sku: "SKU-LINKED",
        name: "Already linked",
      });
      await catalog.upsertChannelListing({
        catalogItemId: item.id,
        connectionId,
        provider: "woocommerce",
        channel: "woocommerce",
        externalListingId: "910",
      });
      const suggestions = await catalog.suggestWooChannelLinks({
        connectionId,
        products: [
          wooProduct({ externalProductId: "910", sku: "SKU-LINKED", name: "L" }),
        ],
      });
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.alreadyLinked).toBe(true);
    });

    it("never proposes an archived item or a variant group", async () => {
      const archived = await catalog.createCatalogItem({
        sku: "SKU-ARCHIVED",
        name: "Archived",
      });
      await catalog.archiveCatalogItem(archived.id);
      await catalog.createCatalogItem({
        sku: "SKU-GROUP-ONLY",
        name: "Group only",
        kind: "variant_group",
      });

      const suggestions = await catalog.suggestWooChannelLinks({
        connectionId,
        products: [
          wooProduct({ externalProductId: "920", sku: "SKU-ARCHIVED" }),
          wooProduct({ externalProductId: "921", sku: "SKU-GROUP-ONLY" }),
        ],
      });
      expect(suggestions).toHaveLength(0);
    });
  });
});
