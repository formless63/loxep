/**
 * Snapshot mapping + snapshot→observation matrix. The fixture mirrors a
 * real Browse getItem payload structurally, with entirely FAKE values.
 */
import { describe, expect, it } from "vitest";
import {
  EbayAdapterError,
  mapItemToSnapshot,
  observationStateHash,
  snapshotToObservation,
} from "../src/index.ts";

const FETCHED_AT = new Date("2026-08-11T12:00:00.000Z");
const BATCH_ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONNECTION_ID = "9f1b7f3e-1111-4222-8333-444455556666";
const OBSERVED_AT = new Date("2026-08-11T12:00:01.000Z");

const RAW_ITEM: Record<string, unknown> = {
  itemId: "v1|110587777777|0",
  legacyItemId: "110587777777",
  title: "Fake Widget Pro 3000",
  listingMarketplaceId: "EBAY_US",
  itemWebUrl: "https://sandbox.ebay.com/itm/110587777777",
  conditionId: "1000",
  condition: "New",
  categoryId: "9355",
  buyingOptions: ["FIXED_PRICE", "BEST_OFFER"],
  price: { value: "19.99", currency: "USD" },
  shippingOptions: [
    { shippingCostType: "FIXED", shippingCost: { value: "4.50", currency: "USD" } },
  ],
  estimatedAvailabilities: [
    {
      estimatedAvailabilityStatus: "IN_STOCK",
      estimatedAvailableQuantity: 7,
      estimatedSoldQuantity: 12,
    },
  ],
  seller: {
    username: "fake_seller",
    feedbackScore: 1234,
    feedbackPercentage: "99.7",
  },
  watchCount: 3,
  itemEndDate: "2026-09-01T00:00:00.000Z",
};

function snapshotOf(raw: Record<string, unknown>) {
  return mapItemToSnapshot(raw, {
    fetchedAt: FETCHED_AT,
    fallbackMarketplace: "EBAY_US",
  });
}

const context = {
  observationBatchId: BATCH_ID,
  observedAt: OBSERVED_AT,
  connectionId: CONNECTION_ID,
  source: "ebay:test",
};

describe("mapItemToSnapshot", () => {
  it("maps the full payload into the Loxep-owned snapshot", () => {
    const snapshot = snapshotOf(RAW_ITEM);
    expect(snapshot).toMatchObject({
      externalItemId: "v1|110587777777|0",
      marketplace: "EBAY_US",
      title: "Fake Widget Pro 3000",
      sellerExternalId: "fake_seller",
      canonicalUrl: "https://sandbox.ebay.com/itm/110587777777",
      conditionCode: "1000",
      categoryExternalId: "9355",
      listingType: "best_offer+fixed_price",
      price: { value: "19.99", currency: "USD" },
      shippingPrice: { value: "4.50", currency: "USD" },
      quantityAvailable: 7,
      quantitySold: 12,
      availability: "in_stock",
      listingState: "active",
      watchCount: 3,
      sellerFeedbackScore: 1234,
      sellerFeedbackPct: "99.7",
    });
    expect(snapshot.listingEndsAt).toEqual(new Date("2026-09-01T00:00:00.000Z"));
    expect(snapshot.raw).toBe(RAW_ITEM);
    expect(snapshot.fetchedAt).toBe(FETCHED_AT);
  });

  it("keeps money as verbatim decimal strings (never floats)", () => {
    const snapshot = snapshotOf({
      ...RAW_ITEM,
      price: { value: "0.10", currency: "USD" },
    });
    expect(snapshot.price?.value).toBe("0.10"); // "0.1" would betray a float
  });

  it("preserves absence as null — never 0", () => {
    const snapshot = snapshotOf({ itemId: "v1|1|0" });
    expect(snapshot.title).toBeNull();
    expect(snapshot.price).toBeNull();
    expect(snapshot.shippingPrice).toBeNull();
    expect(snapshot.quantityAvailable).toBeNull();
    expect(snapshot.quantitySold).toBeNull();
    expect(snapshot.availability).toBeNull();
    expect(snapshot.watchCount).toBeNull();
    expect(snapshot.sellerFeedbackScore).toBeNull();
    expect(snapshot.sellerFeedbackPct).toBeNull();
    expect(snapshot.listingEndsAt).toBeNull();
    expect(snapshot.listingState).toBe("active");
  });

  it("derives listingState ended when itemEndDate has passed", () => {
    const snapshot = snapshotOf({
      itemId: "v1|1|0",
      itemEndDate: "2026-08-11T11:59:59.000Z",
    });
    expect(snapshot.listingState).toBe("ended");
  });

  it("refuses payloads without itemId", () => {
    expect(() => snapshotOf({ title: "no id" })).toThrowError(EbayAdapterError);
  });
});

describe("snapshotToObservation", () => {
  it("passes batch identity through untouched and never mints ids", () => {
    const observation = snapshotToObservation(snapshotOf(RAW_ITEM), context);
    expect(observation.observationBatchId).toBe(BATCH_ID);
    expect(observation.observedAt).toBe(OBSERVED_AT);
    expect(observation.connectionId).toBe(CONNECTION_ID);
    expect(observation.source).toBe("ebay:test");
    expect(observation.item.seenAt).toBe(OBSERVED_AT);
  });

  it("emits the market observation item shape with decimal-string money", () => {
    const { observation } = snapshotToObservation(snapshotOf(RAW_ITEM), context);
    expect(observation).toEqual({
      currency: "USD",
      price: "19.99",
      shippingPrice: "4.50",
      quantityAvailable: 7,
      quantitySold: 12,
      availability: "in_stock",
      listingState: "active",
      watchCount: 3,
      sellerFeedbackScore: 1234,
      sellerFeedbackPct: "99.7",
      listingEndsAt: new Date("2026-09-01T00:00:00.000Z"),
      rawStateHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // Contract mirror of @loxep/market observationItemSchema: decimal
    // strings, ISO currency, integer quantities.
    expect(observation.price).toMatch(/^-?\d+(\.\d+)?$/);
    expect(observation.sellerFeedbackPct).toMatch(/^-?\d+(\.\d+)?$/);
    expect(Number.isSafeInteger(observation.quantityAvailable)).toBe(true);
  });

  it("omits absent facts entirely (NULL preservation, never 0)", () => {
    const { observation, item } = snapshotToObservation(
      snapshotOf({ itemId: "v1|1|0" }),
      context,
    );
    expect(Object.keys(observation).sort()).toEqual([
      "listingState",
      "rawStateHash",
    ]);
    expect(Object.keys(item).sort()).toEqual([
      "currentState",
      "externalItemId",
      "marketplace",
      "provider",
      "seenAt",
    ]);
    expect(item.provider).toBe("ebay");
  });

  it("hash is stable across identical states and raw-payload noise", () => {
    const a = observationStateHash(snapshotOf(RAW_ITEM));
    const b = observationStateHash(
      snapshotOf({ ...RAW_ITEM, description: "noise", watchers: "extra" }),
    );
    expect(a).toBe(b);
    // Identity/batch facts do not participate either.
    const c = observationStateHash(
      snapshotOf({ ...RAW_ITEM, title: "Renamed", itemWebUrl: "https://x" }),
    );
    expect(a).toBe(c);
  });

  it("hash changes when any observed metric changes", () => {
    const base = observationStateHash(snapshotOf(RAW_ITEM));
    const changed: Array<Record<string, unknown>> = [
      { ...RAW_ITEM, price: { value: "19.98", currency: "USD" } },
      { ...RAW_ITEM, watchCount: 4 },
      {
        ...RAW_ITEM,
        estimatedAvailabilities: [
          {
            estimatedAvailabilityStatus: "OUT_OF_STOCK",
            estimatedAvailableQuantity: 0,
            estimatedSoldQuantity: 12,
          },
        ],
      },
    ];
    for (const raw of changed) {
      expect(observationStateHash(snapshotOf(raw))).not.toBe(base);
    }
  });

  it("rejects contexts without valid caller-minted batch identity", () => {
    const snapshot = snapshotOf(RAW_ITEM);
    expect(() =>
      snapshotToObservation(snapshot, { ...context, observationBatchId: "nope" }),
    ).toThrowError(EbayAdapterError);
    expect(() =>
      snapshotToObservation(snapshot, { ...context, source: "" }),
    ).toThrowError(EbayAdapterError);
  });
});
