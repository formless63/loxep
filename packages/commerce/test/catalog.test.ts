/**
 * Catalog item and channel-listing integration tests against real PostgreSQL.
 */
import type { WooProductFact } from "@loxep/integration-woo";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCatalogService } from "../src/catalog.ts";
import type { CatalogService } from "../src/catalog.ts";
import {
  CommerceConflictError,
  CommerceNotFoundError,
  CommerceValidationError,
} from "../src/errors.ts";
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

  describe("listing_code (design 4a, migration 0019)", () => {
    it("mints a listing_code on a connector-synced insert and never touches it on re-sync", async () => {
      const item = await catalog.createCatalogItem({
        sku: "SKU-CODE-A",
        name: "Coded widget",
      });
      const first = await catalog.upsertChannelListing({
        catalogItemId: item.id,
        connectionId,
        provider: "woocommerce",
        channel: "woocommerce",
        externalListingId: "1000",
      });
      expect(first.listingCode).toMatch(/^LST-\d{4}-\d{4}$/);

      const second = await catalog.upsertChannelListing({
        catalogItemId: item.id,
        connectionId,
        provider: "woocommerce",
        channel: "woocommerce",
        externalListingId: "1000",
        status: "ended",
      });
      expect(second.listingCode).toBe(first.listingCode);
    });

    it("mints distinct codes for two connector listings", async () => {
      const item = await catalog.createCatalogItem({
        sku: "SKU-CODE-B",
        name: "Another coded widget",
      });
      const a = await catalog.upsertChannelListing({
        catalogItemId: item.id,
        connectionId,
        provider: "woocommerce",
        channel: "woocommerce",
        externalListingId: "1001",
      });
      const b = await catalog.upsertChannelListing({
        catalogItemId: item.id,
        connectionId,
        provider: "woocommerce",
        channel: "woocommerce",
        externalListingId: "1002",
      });
      expect(a.listingCode).not.toBe(b.listingCode);
    });
  });

  describe("manual listings (design 4a/4b, migration 0019)", () => {
    it("creates a manual listing with no connection and a minted listing_code", async () => {
      const item = await catalog.createCatalogItem({
        sku: "SKU-MANUAL-A",
        name: "Manually listed widget",
      });
      const listing = await catalog.createManualListing({
        catalogItemId: item.id,
        channel: "facebook_marketplace",
        listingTitle: "Vintage brass lamp",
        price: "45.00",
        currency: "usd",
        status: "active",
      });
      expect(listing.provider).toBe("manual");
      expect(listing.connectionId).toBeNull();
      expect(listing.externalListingId).toBeNull();
      expect(listing.listingCode).toMatch(/^LST-\d{4}-\d{4}$/);
      expect(listing.currency).toBe("USD");
      expect(listing.quantityAvailable).toBe(1);
      expect(listing.listedAt).not.toBeNull();
    });

    it("defaults to draft with no listedAt until the operator marks it active", async () => {
      const item = await catalog.createCatalogItem({
        sku: "SKU-MANUAL-B",
        name: "Draft widget",
      });
      const listing = await catalog.createManualListing({
        catalogItemId: item.id,
        channel: "craigslist",
      });
      expect(listing.status).toBe("draft");
      expect(listing.listedAt).toBeNull();
    });

    it("rejects an unknown catalog item", async () => {
      await expect(
        catalog.createManualListing({
          catalogItemId: "00000000-0000-0000-0000-000000000000",
          channel: "in_person",
        }),
      ).rejects.toBeInstanceOf(CommerceNotFoundError);
    });

    it("never collides with a connector-synced row: the partial unique index only covers rows with an external_listing_id", async () => {
      const item = await catalog.createCatalogItem({
        sku: "SKU-MANUAL-C",
        name: "Two manual listings, one item",
      });
      const first = await catalog.createManualListing({
        catalogItemId: item.id,
        channel: "offerup",
      });
      const second = await catalog.createManualListing({
        catalogItemId: item.id,
        channel: "offerup",
      });
      expect(second.id).not.toBe(first.id);
      expect(second.listingCode).not.toBe(first.listingCode);
    });
  });

  describe("findOrCreateCatalogItemBySku", () => {
    it("finds an existing catalog item rather than minting a duplicate", async () => {
      const existing = await catalog.createCatalogItem({
        sku: "SKU-FIND-A",
        name: "Already catalogued",
      });
      const resolved = await catalog.findOrCreateCatalogItemBySku({
        sku: "SKU-FIND-A",
        name: "Would-be duplicate name",
      });
      expect(resolved.id).toBe(existing.id);
      expect(resolved.name).toBe("Already catalogued");
    });

    it("mints a simple catalog item at listing time when none exists", async () => {
      const minted = await catalog.findOrCreateCatalogItemBySku({
        sku: "ITM-7Q3KX",
        name: "Brass lamp",
        economicEntityId: entityId,
      });
      expect(minted.kind).toBe("simple");
      expect(minted.status).toBe("active");
      expect(minted.economicEntityId).toBe(entityId);

      const again = await catalog.findOrCreateCatalogItemBySku({
        sku: "ITM-7Q3KX",
        name: "Brass lamp",
      });
      expect(again.id).toBe(minted.id);
    });
  });
});
