import { describe, expect, it } from "vitest";
import { createMedusaAdapter, probeConnection } from "../src/index.ts";
import { TEST_BASE_URL, TEST_TOKEN, createFetchStub } from "./http.ts";
import { medusaErrorBody } from "./fixtures.ts";

function makeAdapter(stub: ReturnType<typeof createFetchStub>) {
  return createMedusaAdapter({
    baseUrl: TEST_BASE_URL,
    apiToken: TEST_TOKEN,
    fetchImpl: stub.impl,
  });
}

describe("probeConnection", () => {
  it("reports ok and the visible order count on a successful minimal call", async () => {
    const stub = createFetchStub([
      { body: { orders: [{ id: "order_1", status: "pending" }], count: 137, offset: 0, limit: 1 } },
    ]);
    const result = await probeConnection(makeAdapter(stub));
    expect(result.ok).toBe(true);
    expect(result.baseUrl).toBe(TEST_BASE_URL);
    expect(result.visibleOrderCount).toBe(137);
    expect(stub.pathOf(0)).toBe("/admin/orders");
    expect(stub.queryOf(0)["limit"]).toEqual(["1"]);
    expect(stub.queryOf(0)["fields"]).toEqual(["id,status"]);
  });

  it("returns ok: false with taxonomy 'auth' for a bogus secret key, never throwing", async () => {
    const stub = createFetchStub([
      { status: 401, body: medusaErrorBody("unauthorized", "Unauthorized") },
    ]);
    const result = await probeConnection(makeAdapter(stub));
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("auth");
    expect(result.visibleOrderCount).toBeNull();
  });

  it("returns ok: false with taxonomy 'provider_unavailable' for a 5xx", async () => {
    const stub = createFetchStub([
      { status: 500, body: medusaErrorBody("unknown_error", "boom") },
    ]);
    const result = await probeConnection(makeAdapter(stub));
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("provider_unavailable");
  });
});
