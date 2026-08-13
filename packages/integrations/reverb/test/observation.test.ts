import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  mapListingToSnapshot,
  mapReverbListingState,
  observationStateHash,
  ReverbAdapterError,
  snapshotToObservation,
} from "../src/index.ts";
import { listingDraftResponse, listingResponse, listingSoldResponse } from "./fixtures.ts";

describe("mapReverbListingState", () => {
  it("maps live to active", () => {
    expect(mapReverbListingState("live")).toBe("active");
  });

  it("maps ended and sold to ended", () => {
    expect(mapReverbListingState("ended")).toBe("ended");
    expect(mapReverbListingState("sold")).toBe("ended");
  });

  it("passes draft through unchanged", () => {
    expect(mapReverbListingState("draft")).toBe("draft");
  });

  it("returns null for an unrecognized or non-string state", () => {
    expect(mapReverbListingState("something-new")).toBeNull();
    expect(mapReverbListingState(42)).toBeNull();
    expect(mapReverbListingState(undefined)).toBeNull();
  });
});

describe("mapListingToSnapshot", () => {
  const fetchedAt = new Date("2026-08-13T00:00:00.000Z");

  it("maps a live listing with a shop and web link", () => {
    const snapshot = mapListingToSnapshot(listingResponse, { fetchedAt });
    expect(snapshot).toMatchObject({
      externalItemId: "987654321",
      title: "1965 Fender Stratocaster",
      canonicalUrl: "https://reverb.com/item/987654321",
      price: { value: "2999.99", currency: "USD" },
      listingState: "active",
      shopExternalId: "55555",
      shopName: "Vintage Gear Co",
    });
  });

  it("maps a draft listing with no shop/link present", () => {
    const snapshot = mapListingToSnapshot(listingDraftResponse, { fetchedAt });
    expect(snapshot.listingState).toBe("draft");
    expect(snapshot.canonicalUrl).toBeNull();
    expect(snapshot.shopExternalId).toBeNull();
  });

  it("maps a sold listing to the ended state", () => {
    const snapshot = mapListingToSnapshot(listingSoldResponse, { fetchedAt });
    expect(snapshot.listingState).toBe("ended");
  });

  it("defaults an unrecognized state to active rather than throwing", () => {
    const snapshot = mapListingToSnapshot({ id: 1, state: "mystery" }, { fetchedAt });
    expect(snapshot.listingState).toBe("active");
  });

  it("throws provider_unavailable when id is missing", () => {
    expect(() => mapListingToSnapshot({ title: "no id" }, { fetchedAt })).toThrowError(
      ReverbAdapterError,
    );
  });

  it("retains the raw payload for audit/replay", () => {
    const snapshot = mapListingToSnapshot(listingResponse, { fetchedAt });
    expect(snapshot.raw).toBe(listingResponse);
  });
});

describe("observationStateHash", () => {
  it("is stable for identical inputs and changes when price/state changes", () => {
    const fetchedAt = new Date();
    const a = mapListingToSnapshot(listingResponse, { fetchedAt });
    const b = mapListingToSnapshot(listingResponse, { fetchedAt });
    expect(observationStateHash(a)).toBe(observationStateHash(b));

    const changed = mapListingToSnapshot(
      { ...listingResponse, price: { amount: "1.00", currency: "USD" } },
      { fetchedAt },
    );
    expect(observationStateHash(changed)).not.toBe(observationStateHash(a));
  });

  it("does not change when only title/url change (identity fields excluded)", () => {
    const fetchedAt = new Date();
    const a = mapListingToSnapshot(listingResponse, { fetchedAt });
    const renamed = mapListingToSnapshot({ ...listingResponse, title: "Renamed" }, { fetchedAt });
    expect(observationStateHash(a)).toBe(observationStateHash(renamed));
  });
});

describe("snapshotToObservation", () => {
  it("builds the market-facing observation and identity shapes", () => {
    const fetchedAt = new Date("2026-08-13T00:00:00.000Z");
    const snapshot = mapListingToSnapshot(listingResponse, { fetchedAt });
    const observationBatchId = randomUUID();
    const observedAt = new Date("2026-08-13T00:05:00.000Z");
    const connectionId = randomUUID();

    const result = snapshotToObservation(snapshot, {
      observationBatchId,
      observedAt,
      connectionId,
      source: "reverb:listing",
    });

    expect(result.item).toMatchObject({
      provider: "reverb",
      marketplace: "reverb",
      externalItemId: "987654321",
      currentState: "active",
      sellerExternalId: "55555",
      canonicalUrl: "https://reverb.com/item/987654321",
      title: "1965 Fender Stratocaster",
    });
    expect(result.observation).toMatchObject({
      currency: "USD",
      price: "2999.99",
      listingState: "active",
    });
    expect(result.observation.rawStateHash).toHaveLength(64);
    expect(result.observationBatchId).toBe(observationBatchId);
    expect(result.connectionId).toBe(connectionId);
  });

  it("throws invalid_request for a malformed context", () => {
    const snapshot = mapListingToSnapshot(listingResponse, { fetchedAt: new Date() });
    expect(() =>
      snapshotToObservation(snapshot, {
        observationBatchId: "not-a-uuid",
        observedAt: new Date(),
        source: "reverb:listing",
      }),
    ).toThrowError(ReverbAdapterError);
  });

  it("omits sellerExternalId/canonicalUrl when the listing has neither", () => {
    const snapshot = mapListingToSnapshot(listingDraftResponse, { fetchedAt: new Date() });
    const result = snapshotToObservation(snapshot, {
      observationBatchId: randomUUID(),
      observedAt: new Date(),
      source: "reverb:shop",
    });
    expect(result.item.sellerExternalId).toBeUndefined();
    expect(result.item.canonicalUrl).toBeUndefined();
  });
});
