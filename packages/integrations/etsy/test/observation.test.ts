import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EtsyAdapterError,
  ETSY_MARKETPLACE,
  mapEtsyListingState,
  mapListingToSnapshot,
  observationStateHash,
  snapshotToObservation,
} from "../src/index.ts";
import {
  draftListingResponse,
  expiredListingResponse,
  jpyListingResponse,
  listingResponse,
  soldOutListingResponse,
} from "./fixtures.ts";

const fetchedAt = new Date("2026-08-13T00:00:00.000Z");

describe("mapEtsyListingState", () => {
  it("passes 'active' through unchanged", () => {
    expect(mapEtsyListingState("active")).toBe("active");
  });

  it("maps 'expired' to Loxep's 'ended' vocabulary", () => {
    expect(mapEtsyListingState("expired")).toBe("ended");
  });

  it("keeps sold_out/inactive/draft distinct rather than folding into 'ended'", () => {
    expect(mapEtsyListingState("sold_out")).toBe("sold_out");
    expect(mapEtsyListingState("inactive")).toBe("inactive");
    expect(mapEtsyListingState("draft")).toBe("draft");
  });

  it("returns null for an unrecognized value", () => {
    expect(mapEtsyListingState("something_new")).toBeNull();
    expect(mapEtsyListingState(undefined)).toBeNull();
  });
});

describe("mapListingToSnapshot", () => {
  it("maps every documented field from a full listing payload", () => {
    const snapshot = mapListingToSnapshot(listingResponse, { fetchedAt });
    expect(snapshot).toMatchObject({
      externalItemId: "987654321",
      shopExternalId: "55555",
      title: "Hand-thrown ceramic mug",
      canonicalUrl: "https://www.etsy.com/listing/987654321/hand-thrown-ceramic-mug",
      price: { value: "29.99", currency: "USD" },
      quantityAvailable: 4,
      categoryExternalId: "1234",
      listingType: "physical",
      listingState: "active",
      favorersCount: 42,
    });
    expect(snapshot.raw).toBe(listingResponse);
    expect(snapshot.fetchedAt).toBe(fetchedAt);
  });

  it("maps a JPY (divisor 1) listing's price without a decimal point", () => {
    const snapshot = mapListingToSnapshot(jpyListingResponse, { fetchedAt });
    expect(snapshot.price).toEqual({ value: "3200", currency: "JPY" });
  });

  it("maps expired -> ended and sold_out -> sold_out", () => {
    expect(mapListingToSnapshot(expiredListingResponse, { fetchedAt }).listingState).toBe(
      "ended",
    );
    expect(mapListingToSnapshot(soldOutListingResponse, { fetchedAt }).listingState).toBe(
      "sold_out",
    );
    expect(mapListingToSnapshot(draftListingResponse, { fetchedAt }).listingState).toBe(
      "draft",
    );
  });

  it("throws provider_unavailable when listing_id is absent", () => {
    expect(() => mapListingToSnapshot({}, { fetchedAt })).toThrowError(EtsyAdapterError);
  });

  it("defaults to 'active' when state is unrecognized rather than throwing", () => {
    const snapshot = mapListingToSnapshot(
      { listing_id: 1, state: "some_future_state" },
      { fetchedAt },
    );
    expect(snapshot.listingState).toBe("active");
  });
});

describe("observationStateHash", () => {
  it("is stable across two identical snapshots", () => {
    const a = mapListingToSnapshot(listingResponse, { fetchedAt });
    const b = mapListingToSnapshot({ ...listingResponse }, { fetchedAt });
    expect(observationStateHash(a)).toBe(observationStateHash(b));
  });

  it("changes when price, state, quantity, or favorersCount changes", () => {
    const base = mapListingToSnapshot(listingResponse, { fetchedAt });
    const baseHash = observationStateHash(base);
    for (const patched of [
      mapListingToSnapshot({ ...listingResponse, price: { amount: 3500, divisor: 100, currency_code: "USD" } }, { fetchedAt }),
      mapListingToSnapshot({ ...listingResponse, state: "sold_out" }, { fetchedAt }),
      mapListingToSnapshot({ ...listingResponse, quantity: 0 }, { fetchedAt }),
      mapListingToSnapshot({ ...listingResponse, num_favorers: 43 }, { fetchedAt }),
    ]) {
      expect(observationStateHash(patched)).not.toBe(baseHash);
    }
  });

  it("does not change when identity/descriptive fields change (title, url)", () => {
    const base = mapListingToSnapshot(listingResponse, { fetchedAt });
    const retitled = mapListingToSnapshot({ ...listingResponse, title: "New title" }, { fetchedAt });
    expect(observationStateHash(retitled)).toBe(observationStateHash(base));
  });
});

describe("snapshotToObservation", () => {
  const context = {
    observationBatchId: randomUUID(),
    observedAt: fetchedAt,
    source: "etsy:listing",
  };

  it("builds the market-package-compatible observation + identity pair", () => {
    const snapshot = mapListingToSnapshot(listingResponse, { fetchedAt });
    const observation = snapshotToObservation(snapshot, context);
    expect(observation.item).toMatchObject({
      provider: "etsy",
      marketplace: ETSY_MARKETPLACE,
      externalItemId: "987654321",
      currentState: "active",
      sellerExternalId: "55555",
      canonicalUrl: listingResponse.url,
      title: listingResponse.title,
      categoryExternalId: "1234",
      listingType: "physical",
    });
    expect(observation.observation).toMatchObject({
      currency: "USD",
      price: "29.99",
      quantityAvailable: 4,
      listingState: "active",
      watchCount: 42,
    });
    expect(observation.observation.rawStateHash).toBe(observationStateHash(snapshot));
    expect(observation.observationBatchId).toBe(context.observationBatchId);
  });

  it("omits absent optional facts rather than coercing them to 0/empty", () => {
    const snapshot = mapListingToSnapshot(
      { listing_id: 42, state: "active" },
      { fetchedAt },
    );
    const observation = snapshotToObservation(snapshot, context);
    expect(observation.observation.price).toBeUndefined();
    expect(observation.observation.currency).toBeUndefined();
    expect(observation.observation.quantityAvailable).toBeUndefined();
    expect(observation.observation.watchCount).toBeUndefined();
    expect(observation.item.sellerExternalId).toBeUndefined();
    // listingState is always present.
    expect(observation.observation.listingState).toBe("active");
  });

  it("throws invalid_request on a malformed context", () => {
    const snapshot = mapListingToSnapshot(listingResponse, { fetchedAt });
    expect(() =>
      snapshotToObservation(snapshot, { ...context, observationBatchId: "not-a-uuid" }),
    ).toThrowError(EtsyAdapterError);
  });
});
