import { describe, expect, it } from "vitest";
import {
  MEDUSA_MAX_LIMIT,
  MedusaAdapterError,
  createMedusaAdapter,
  createRateBudget,
} from "../src/index.ts";
import {
  TEST_BASE_URL,
  TEST_TOKEN,
  createFailingFetchStub,
  createFetchStub,
  rejection,
} from "./http.ts";
import { medusaErrorBody } from "./fixtures.ts";

function makeAdapter(
  stub: ReturnType<typeof createFetchStub>,
  overrides: Record<string, unknown> = {},
) {
  return createMedusaAdapter({
    baseUrl: TEST_BASE_URL,
    apiToken: TEST_TOKEN,
    fetchImpl: stub.impl,
    ...overrides,
  });
}

describe("createMedusaAdapter — request construction", () => {
  it("sends the token as a raw 'Authorization: Basic <token>' header — NOT base64 of user:pass", async () => {
    const stub = createFetchStub([{ body: { orders: [], count: 0, offset: 0, limit: 1 } }]);
    const adapter = makeAdapter(stub);
    await adapter.list("/orders", "orders", { limit: 1 });
    expect(stub.calls[0]?.headers["authorization"]).toBe(`Basic ${TEST_TOKEN}`);
  });

  it("builds the request against <baseUrl>/admin<path>", async () => {
    const stub = createFetchStub([{ body: { orders: [], count: 0, offset: 0, limit: 1 } }]);
    const adapter = makeAdapter(stub);
    await adapter.list("/orders", "orders");
    expect(stub.pathOf(0)).toBe("/admin/orders");
  });

  it("rejects a path that does not start with '/'", async () => {
    const stub = createFetchStub([]);
    const adapter = makeAdapter(stub);
    const error = await rejection(adapter.get("orders"));
    expect(error.kind).toBe("invalid_request");
    expect(stub.calls).toHaveLength(0);
  });

  it("computes sourceAccountKey as medusa:<baseUrl>", () => {
    const stub = createFetchStub([]);
    expect(makeAdapter(stub).sourceAccountKey).toBe(`medusa:${TEST_BASE_URL}`);
  });
});

describe("createMedusaAdapter — get()", () => {
  it("returns the parsed body as data", async () => {
    const stub = createFetchStub([{ body: { hello: "world" } }]);
    const response = await makeAdapter(stub).get("/anything");
    expect(response.data).toEqual({ hello: "world" });
  });

  it("throws provider_unavailable when the body is not a JSON object", async () => {
    const stub = createFetchStub([{ body: [1, 2, 3] }]);
    const error = await rejection(makeAdapter(stub).get("/anything"));
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["receivedType"]).toBe("object");
  });

  it("throws provider_unavailable for a non-JSON successful response", async () => {
    const stub = createFetchStub([{ text: "<html>nope</html>", status: 200 }]);
    const error = await rejection(makeAdapter(stub).get("/anything"));
    expect(error.kind).toBe("provider_unavailable");
  });
});

describe("createMedusaAdapter — list()", () => {
  it("extracts items from the named resultKey and reads count/offset/limit from the body", async () => {
    const stub = createFetchStub([
      { body: { products: [{ id: "p1" }, { id: "p2" }], count: 20, offset: 0, limit: 2 } },
    ]);
    const result = await makeAdapter(stub).list("/products", "products", {
      limit: 2,
    });
    expect(result.items).toEqual([{ id: "p1" }, { id: "p2" }]);
    expect(result.page).toEqual({
      offset: 0,
      limit: 2,
      count: 20,
      hasNextPage: true,
    });
  });

  it("throws provider_unavailable when resultKey is not an array", async () => {
    const stub = createFetchStub([{ body: { products: { not: "an array" } } }]);
    const error = await rejection(
      makeAdapter(stub).list("/products", "products"),
    );
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["resultKey"]).toBe("products");
  });

  it("drops non-object entries from the array", async () => {
    const stub = createFetchStub([
      { body: { products: [{ id: "p1" }, "not-an-object", null, 42], count: 1, offset: 0, limit: 10 } },
    ]);
    const result = await makeAdapter(stub).list("/products", "products");
    expect(result.items).toEqual([{ id: "p1" }]);
  });

  it("computes hasNextPage false when offset + items.length >= count", async () => {
    const stub = createFetchStub([
      { body: { products: [{ id: "p1" }], count: 1, offset: 0, limit: 10 } },
    ]);
    const result = await makeAdapter(stub).list("/products", "products");
    expect(result.page.hasNextPage).toBe(false);
  });

  it("falls back to a full-page heuristic when the body omits count", async () => {
    const stub = createFetchStub([
      { body: { products: [{ id: "p1" }, { id: "p2" }], offset: 0, limit: 2 } },
    ]);
    const result = await makeAdapter(stub).list("/products", "products", {
      limit: 2,
    });
    expect(result.page.count).toBeNull();
    expect(result.page.hasNextPage).toBe(true);
  });
});

describe("createMedusaAdapter — paginate()", () => {
  it("walks by offset += limit and stops when hasNextPage is false", async () => {
    const stub = createFetchStub((index) => ({
      body: {
        orders: [{ id: `o${index}` }],
        count: 3,
        offset: index,
        limit: 1,
      },
    }));
    const adapter = makeAdapter(stub);
    const ids: string[] = [];
    for await (const page of adapter.paginate("/orders", "orders", {
      limit: 1,
    })) {
      ids.push(...page.items.map((item) => item["id"] as string));
    }
    expect(ids).toEqual(["o0", "o1", "o2"]);
    expect(stub.calls).toHaveLength(3);
  });

  it("stops immediately on an empty first page", async () => {
    const stub = createFetchStub([
      { body: { orders: [], count: 0, offset: 0, limit: 10 } },
    ]);
    const adapter = makeAdapter(stub);
    const pages = [];
    for await (const page of adapter.paginate("/orders", "orders")) {
      pages.push(page);
    }
    expect(pages).toHaveLength(1);
    expect(stub.calls).toHaveLength(1);
  });

  it("respects maxPages as a safety backstop", async () => {
    const stub = createFetchStub(() => ({
      body: { orders: [{ id: "x" }], offset: 0, limit: 1 }, // no count → always "more"
    }));
    const adapter = makeAdapter(stub);
    let pages = 0;
    for await (const _page of adapter.paginate("/orders", "orders", {
      limit: 1,
      maxPages: 3,
    })) {
      pages += 1;
    }
    expect(pages).toBe(3);
  });

  it("clamps limit to MEDUSA_MAX_LIMIT", async () => {
    const stub = createFetchStub([
      { body: { orders: [], count: 0, offset: 0, limit: MEDUSA_MAX_LIMIT } },
    ]);
    const adapter = makeAdapter(stub);
    for await (const _page of adapter.paginate("/orders", "orders", {
      limit: 100_000,
    })) {
      // drain
    }
    expect(stub.queryOf(0)["limit"]).toEqual([String(MEDUSA_MAX_LIMIT)]);
  });
});

describe("createMedusaAdapter — error taxonomy end-to-end", () => {
  it("classifies a 401 as auth without leaking the token", async () => {
    const stub = createFetchStub([
      { status: 401, body: medusaErrorBody("unauthorized", "Unauthorized") },
    ]);
    const error = await rejection(makeAdapter(stub).get("/orders"));
    expect(error.kind).toBe("auth");
    const serialized = JSON.stringify({ message: error.message, detail: error.detail });
    expect(serialized).not.toContain(TEST_TOKEN);
    expect(serialized).not.toContain("Basic ");
  });

  it("classifies a 404 as not_found", async () => {
    const stub = createFetchStub([
      { status: 404, body: medusaErrorBody("not_found", "Order not found", "not_found") },
    ]);
    const error = await rejection(makeAdapter(stub).get("/orders/order_bogus"));
    expect(error.kind).toBe("not_found");
  });

  it("classifies a network failure as provider_unavailable", async () => {
    const stub = createFailingFetchStub(
      Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    );
    const adapter = makeAdapter(stub);
    const error = await rejection(adapter.get("/orders"));
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["causeCode"]).toBe("ECONNREFUSED");
  });

  it("classifies the local rate budget's own rejection as rate_limited", async () => {
    const stub = createFetchStub([{ body: { orders: [], count: 0, offset: 0, limit: 1 } }]);
    const budget = createRateBudget({ capacity: 1, refillPerSecond: 0.001 });
    const adapter = makeAdapter(stub, { rateBudget: budget });
    await adapter.get("/orders"); // consumes the one token
    const error = await rejection(adapter.get("/orders", undefined, { operation: "second" }));
    expect(error.kind).toBe("rate_limited");
    expect(error.detail["source"]).toBe("local_rate_budget");
  });
});

describe("createMedusaAdapter — stats()", () => {
  it("reports baseUrl, sourceAccountKey, rate budget stats, and request count", async () => {
    const stub = createFetchStub([
      { body: { orders: [], count: 0, offset: 0, limit: 1 } },
      { body: { orders: [], count: 0, offset: 0, limit: 1 } },
    ]);
    const adapter = makeAdapter(stub);
    await adapter.get("/orders");
    await adapter.get("/orders");
    const stats = adapter.stats();
    expect(stats.baseUrl).toBe(TEST_BASE_URL);
    expect(stats.sourceAccountKey).toBe(`medusa:${TEST_BASE_URL}`);
    expect(stats.requests).toBe(2);
    expect(stats.rateBudget.acquired).toBeGreaterThanOrEqual(2);
  });
});
