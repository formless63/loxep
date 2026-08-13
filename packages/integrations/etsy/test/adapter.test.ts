import { describe, expect, it } from "vitest";
import {
  createEtsyAdapter,
  createRateBudget,
  EtsyAdapterError,
} from "../src/index.ts";
import { createFailingFetchStub, createFetchStub, rejection, TEST_KEYSTRING, TEST_SHARED_SECRET } from "./http.ts";
import {
  etsyErrorBody,
  listingResponse,
  pingResponse,
  shopActiveListingsResponse,
  shopListingsAllStatesResponse,
  shopResponse,
} from "./fixtures.ts";

function testAdapter(fetchImpl: ReturnType<typeof createFetchStub>["impl"]) {
  return createEtsyAdapter({
    keystring: TEST_KEYSTRING,
    sharedSecret: TEST_SHARED_SECRET,
    rateBudget: createRateBudget({ capacity: 100, refillPerSecond: 100 }),
    fetchImpl,
  });
}

describe("createEtsyAdapter — public auth", () => {
  it("sends x-api-key on every request and no Authorization header", async () => {
    const stub = createFetchStub([{ status: 200, body: pingResponse }]);
    const adapter = testAdapter(stub.impl);
    await adapter.ping();
    const call = stub.calls[0]!;
    expect(call.headers["x-api-key"]).toBe(`${TEST_KEYSTRING}:${TEST_SHARED_SECRET}`);
    expect(call.headers["authorization"]).toBeUndefined();
  });

  it("ping() reports the application id", async () => {
    const stub = createFetchStub([{ status: 200, body: pingResponse }]);
    const adapter = testAdapter(stub.impl);
    expect(await adapter.ping()).toEqual({ applicationId: 123456 });
    expect(stub.pathOf(0)).toBe("/v3/application/openapi-ping");
  });

  it("getListing() fetches one listing by id", async () => {
    const stub = createFetchStub([{ status: 200, body: listingResponse }]);
    const adapter = testAdapter(stub.impl);
    const listing = await adapter.getListing("987654321");
    expect(listing["listing_id"]).toBe(987654321);
    expect(stub.pathOf(0)).toBe("/v3/application/listings/987654321");
  });

  it("getListing() rejects an empty listingId before any network call", async () => {
    const stub = createFetchStub([]);
    const adapter = testAdapter(stub.impl);
    await expect(adapter.getListing("")).rejects.toThrowError(EtsyAdapterError);
    expect(stub.calls).toHaveLength(0);
  });

  it("getShop() fetches a shop profile", async () => {
    const stub = createFetchStub([{ status: 200, body: shopResponse }]);
    const adapter = testAdapter(stub.impl);
    const shop = await adapter.getShop("55555");
    expect(shop["shop_name"]).toBe("CeramicsByAlex");
    expect(stub.pathOf(0)).toBe("/v3/application/shops/55555");
  });

  it("getShopListingsActive() pages the shop's public listings", async () => {
    const stub = createFetchStub([{ status: 200, body: shopActiveListingsResponse }]);
    const adapter = testAdapter(stub.impl);
    const page = await adapter.getShopListingsActive({
      shopId: "55555",
      limit: 25,
      offset: 0,
    });
    expect(page.count).toBe(3);
    expect(page.results).toHaveLength(3);
    expect(stub.pathOf(0)).toBe("/v3/application/shops/55555/listings/active");
    expect(stub.queryOf(0)["limit"]).toEqual(["25"]);
    expect(stub.queryOf(0)["offset"]).toEqual(["0"]);
  });

  it("acquires from the injected rate budget before every request", async () => {
    const budget = createRateBudget({ capacity: 1, refillPerSecond: 1000 });
    const stub = createFetchStub([
      { status: 200, body: pingResponse },
      { status: 200, body: pingResponse },
    ]);
    const adapter = createEtsyAdapter({
      keystring: TEST_KEYSTRING,
      sharedSecret: TEST_SHARED_SECRET,
      rateBudget: budget,
      fetchImpl: stub.impl,
    });
    await adapter.ping();
    expect(budget.stats().acquired).toBe(1);
    await adapter.ping();
    expect(budget.stats().acquired).toBe(2);
  });
});

describe("createEtsyAdapter — private auth (withUserToken)", () => {
  const bundle = {
    etsyUserId: "111222333",
    accessToken: "opaque-access-token",
    refreshToken: "refresh",
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshTokenExpiresAt: null,
    scopes: ["shops_r", "listings_r"],
  };

  it("adds Authorization: Bearer <userId>.<accessToken> alongside x-api-key", async () => {
    const stub = createFetchStub([{ status: 200, body: shopListingsAllStatesResponse }]);
    const adapter = testAdapter(stub.impl);
    const user = adapter.withUserToken(bundle);
    await user.getShopListings({ shopId: "55555" });
    const call = stub.calls[0]!;
    expect(call.headers["x-api-key"]).toBe(`${TEST_KEYSTRING}:${TEST_SHARED_SECRET}`);
    expect(call.headers["authorization"]).toBe("Bearer 111222333.opaque-access-token");
  });

  it("getShopListings() can narrow by state and sees non-active listings", async () => {
    const stub = createFetchStub([{ status: 200, body: shopListingsAllStatesResponse }]);
    const adapter = testAdapter(stub.impl);
    const user = adapter.withUserToken(bundle);
    const page = await user.getShopListings({ shopId: "55555", state: "draft" });
    expect(page.count).toBe(4);
    expect(stub.queryOf(0)["state"]).toEqual(["draft"]);
  });

  it("the private adapter can still make public-auth calls", async () => {
    const stub = createFetchStub([{ status: 200, body: pingResponse }]);
    const adapter = testAdapter(stub.impl);
    const user = adapter.withUserToken(bundle);
    await user.ping();
    expect(stub.calls[0]!.headers["authorization"]).toBe(
      "Bearer 111222333.opaque-access-token",
    );
  });
});

describe("createEtsyAdapter — error taxonomy end to end", () => {
  it("maps a 403 {error} body to kind auth", async () => {
    const stub = createFetchStub([{ status: 403, body: etsyErrorBody("insufficient_scope") }]);
    const adapter = testAdapter(stub.impl);
    const error = await rejection(adapter.getShop("55555"));
    expect(error.kind).toBe("auth");
  });

  it("maps a 404 to not_found", async () => {
    const stub = createFetchStub([{ status: 404, body: etsyErrorBody("listing not found") }]);
    const adapter = testAdapter(stub.impl);
    const error = await rejection(adapter.getListing("999"));
    expect(error.kind).toBe("not_found");
  });

  it("maps a 429 with retry-after to rate_limited with retryAfterSeconds", async () => {
    const stub = createFetchStub([
      { status: 429, body: etsyErrorBody("too many requests"), headers: { "retry-after": "5" } },
    ]);
    const adapter = testAdapter(stub.impl);
    const error = await rejection(adapter.getShop("55555"));
    expect(error.kind).toBe("rate_limited");
    expect(error.detail["retryAfterSeconds"]).toBe(5);
  });

  it("maps a 5xx to provider_unavailable", async () => {
    const stub = createFetchStub([{ status: 502, body: etsyErrorBody("upstream error") }]);
    const adapter = testAdapter(stub.impl);
    const error = await rejection(adapter.getShop("55555"));
    expect(error.kind).toBe("provider_unavailable");
  });

  it("maps a network failure to provider_unavailable without leaking request material", async () => {
    const stub = createFailingFetchStub(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));
    const adapter = testAdapter(stub.impl);
    const error = await rejection(adapter.getShop("55555"));
    expect(error.kind).toBe("provider_unavailable");
    expect(JSON.stringify(error.detail)).not.toContain(TEST_SHARED_SECRET);
  });

  it("credential material is never present in a thrown error's detail", async () => {
    const stub = createFetchStub([{ status: 401, body: etsyErrorBody("bad key") }]);
    const adapter = testAdapter(stub.impl);
    const error = await rejection(adapter.getShop("55555"));
    expect(JSON.stringify(error.detail)).not.toContain(TEST_SHARED_SECRET);
    expect(JSON.stringify(error.detail)).not.toContain(TEST_KEYSTRING);
  });
});

describe("createEtsyAdapter — stats", () => {
  it("reports rate budget stats and a running request count", async () => {
    const stub = createFetchStub([{ status: 200, body: pingResponse }]);
    const adapter = testAdapter(stub.impl);
    expect(adapter.stats().requests).toBe(0);
    await adapter.ping();
    expect(adapter.stats().requests).toBe(1);
  });
});
