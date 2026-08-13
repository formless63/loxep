import { describe, expect, it } from "vitest";
import {
  INVOICENINJA_MAX_PER_PAGE,
  createInvoiceNinjaAdapter,
  createRateBudget,
} from "../src/index.ts";
import {
  TEST_BASE_URL,
  TEST_TOKEN,
  createFailingFetchStub,
  createFetchStub,
  rejection,
} from "./http.ts";
import {
  clientFixture,
  invalidTokenErrorBody,
  ninjaItemEnvelope,
  ninjaListEnvelope,
} from "./fixtures.ts";

function makeAdapter(
  stub: ReturnType<typeof createFetchStub>,
  overrides: Record<string, unknown> = {},
) {
  return createInvoiceNinjaAdapter({
    baseUrl: TEST_BASE_URL,
    apiToken: TEST_TOKEN,
    fetchImpl: stub.impl,
    ...overrides,
  });
}

describe("createInvoiceNinjaAdapter — request construction", () => {
  it("sends the token as a raw 'X-API-TOKEN' header — no Authorization wrapping", async () => {
    const stub = createFetchStub([{ body: ninjaListEnvelope([]) }]);
    const adapter = makeAdapter(stub);
    await adapter.list("/clients");
    expect(stub.calls[0]?.headers["x-api-token"]).toBe(TEST_TOKEN);
    expect(stub.calls[0]?.headers["authorization"]).toBeUndefined();
  });

  it("builds the request against <baseUrl>/api/v1<path>", async () => {
    const stub = createFetchStub([{ body: ninjaListEnvelope([]) }]);
    const adapter = makeAdapter(stub);
    await adapter.list("/clients");
    expect(stub.pathOf(0)).toBe("/api/v1/clients");
  });

  it("rejects a path that does not start with '/'", async () => {
    const stub = createFetchStub([]);
    const adapter = makeAdapter(stub);
    const error = await rejection(adapter.get("clients"));
    expect(error.kind).toBe("invalid_request");
    expect(stub.calls).toHaveLength(0);
  });

  it("computes sourceAccountKey as invoiceninja:<baseUrl>", () => {
    const stub = createFetchStub([]);
    expect(makeAdapter(stub).sourceAccountKey).toBe(`invoiceninja:${TEST_BASE_URL}`);
  });
});

describe("createInvoiceNinjaAdapter — get()", () => {
  it("unwraps the {data: {...}} envelope", async () => {
    const stub = createFetchStub([{ body: ninjaItemEnvelope(clientFixture()) }]);
    const response = await makeAdapter(stub).get("/clients/FIXTURECLIENT01");
    expect(response.data["id"]).toBe("FIXTURECLIENT01");
  });

  it("throws provider_unavailable when the body has no {data} object", async () => {
    const stub = createFetchStub([{ body: { unexpected: true } }]);
    const error = await rejection(makeAdapter(stub).get("/clients/x"));
    expect(error.kind).toBe("provider_unavailable");
  });

  it("throws provider_unavailable for a non-JSON successful response", async () => {
    const stub = createFetchStub([{ text: "<html>nope</html>", status: 200 }]);
    const error = await rejection(makeAdapter(stub).get("/clients/x"));
    expect(error.kind).toBe("provider_unavailable");
  });
});

describe("createInvoiceNinjaAdapter — list()", () => {
  it("extracts items from data[] and reads pagination from meta.pagination", async () => {
    const stub = createFetchStub([
      {
        body: ninjaListEnvelope([clientFixture(), clientFixture({ id: "FIXTURECLIENT02" })], {
          total: 20,
          count: 2,
          perPage: 2,
          currentPage: 1,
          totalPages: 10,
          hasNext: true,
        }),
      },
    ]);
    const result = await makeAdapter(stub).list("/clients", { per_page: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.page).toEqual({
      total: 20,
      count: 2,
      perPage: 2,
      currentPage: 1,
      totalPages: 10,
      hasNextPage: true,
    });
  });

  it("throws provider_unavailable when data is not an array", async () => {
    const stub = createFetchStub([{ body: { data: { not: "an array" } } }]);
    const error = await rejection(makeAdapter(stub).list("/clients"));
    expect(error.kind).toBe("provider_unavailable");
  });

  it("drops non-object entries from the array", async () => {
    const stub = createFetchStub([
      { body: ninjaListEnvelope([clientFixture(), "not-an-object" as never, null as never]) },
    ]);
    const result = await makeAdapter(stub).list("/clients");
    expect(result.items).toHaveLength(1);
  });

  it("computes hasNextPage from links.next presence", async () => {
    const stub = createFetchStub([
      { body: ninjaListEnvelope([clientFixture()], { hasNext: false }) },
    ]);
    const result = await makeAdapter(stub).list("/clients");
    expect(result.page.hasNextPage).toBe(false);
  });

  it("falls back to a full-page heuristic when meta.pagination is absent", async () => {
    const stub = createFetchStub([{ body: { data: [clientFixture(), clientFixture()] } }]);
    const result = await makeAdapter(stub).list("/clients", { per_page: 2 });
    expect(result.page.total).toBeNull();
    expect(result.page.hasNextPage).toBe(true);
  });
});

describe("createInvoiceNinjaAdapter — post() / put()", () => {
  it("post() sends a JSON body with content-type and returns the unwrapped item", async () => {
    const stub = createFetchStub([{ body: ninjaItemEnvelope(clientFixture()) }]);
    const adapter = makeAdapter(stub);
    const response = await adapter.post("/clients", { name: "Fixture Roofing Co" });
    expect(stub.calls[0]?.method).toBe("POST");
    expect(stub.calls[0]?.headers["content-type"]).toBe("application/json");
    expect(stub.calls[0]?.body).toEqual({ name: "Fixture Roofing Co" });
    expect(response.data["id"]).toBe("FIXTURECLIENT01");
  });

  it("put() sends PUT with a JSON body", async () => {
    const stub = createFetchStub([{ body: ninjaItemEnvelope(clientFixture()) }]);
    const adapter = makeAdapter(stub);
    await adapter.put("/clients/FIXTURECLIENT01", { name: "Renamed Co" });
    expect(stub.calls[0]?.method).toBe("PUT");
    expect(stub.calls[0]?.body).toEqual({ name: "Renamed Co" });
  });
});

describe("createInvoiceNinjaAdapter — paginate()", () => {
  it("walks by page += 1 and stops when hasNextPage is false", async () => {
    const stub = createFetchStub((index) => ({
      body: ninjaListEnvelope([clientFixture({ id: `c${index}` })], {
        currentPage: index + 1,
        totalPages: 3,
        hasNext: index < 2,
      }),
    }));
    const adapter = makeAdapter(stub);
    const ids: string[] = [];
    for await (const page of adapter.paginate("/clients", { perPage: 1 })) {
      ids.push(...page.items.map((item) => item["id"] as string));
    }
    expect(ids).toEqual(["c0", "c1", "c2"]);
    expect(stub.calls).toHaveLength(3);
  });

  it("stops immediately on an empty first page", async () => {
    const stub = createFetchStub([{ body: ninjaListEnvelope([]) }]);
    const adapter = makeAdapter(stub);
    const pages = [];
    for await (const page of adapter.paginate("/clients")) {
      pages.push(page);
    }
    expect(pages).toHaveLength(1);
    expect(stub.calls).toHaveLength(1);
  });

  it("respects maxPages as a safety backstop", async () => {
    const stub = createFetchStub(() => ({
      // No meta at all → the full-page heuristic always says "more".
      body: { data: [clientFixture()] },
    }));
    const adapter = makeAdapter(stub);
    let pages = 0;
    for await (const _page of adapter.paginate("/clients", {
      perPage: 1,
      maxPages: 3,
    })) {
      pages += 1;
    }
    expect(pages).toBe(3);
  });

  it("clamps perPage to INVOICENINJA_MAX_PER_PAGE", async () => {
    const stub = createFetchStub([{ body: ninjaListEnvelope([]) }]);
    const adapter = makeAdapter(stub);
    for await (const _page of adapter.paginate("/clients", { perPage: 100_000 })) {
      // drain
    }
    expect(stub.queryOf(0)["per_page"]).toEqual([String(INVOICENINJA_MAX_PER_PAGE)]);
  });
});

describe("createInvoiceNinjaAdapter — error taxonomy end-to-end", () => {
  it("classifies a 403 'Invalid token' as auth without leaking the token", async () => {
    const stub = createFetchStub([{ status: 403, body: invalidTokenErrorBody() }]);
    const error = await rejection(makeAdapter(stub).get("/clients/x"));
    expect(error.kind).toBe("auth");
    const serialized = JSON.stringify({ message: error.message, detail: error.detail });
    expect(serialized).not.toContain(TEST_TOKEN);
  });

  it("classifies a 404 as not_found", async () => {
    const stub = createFetchStub([
      { status: 404, body: { message: "No query results for model [App\\Models\\Client]." } },
    ]);
    const error = await rejection(makeAdapter(stub).get("/clients/bogus"));
    expect(error.kind).toBe("not_found");
  });

  it("classifies a network failure as provider_unavailable", async () => {
    const stub = createFailingFetchStub(
      Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    );
    const adapter = makeAdapter(stub);
    const error = await rejection(adapter.get("/clients/x"));
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["causeCode"]).toBe("ECONNREFUSED");
  });

  it("classifies the local rate budget's own rejection as rate_limited", async () => {
    const stub = createFetchStub([{ body: ninjaItemEnvelope(clientFixture()) }]);
    const budget = createRateBudget({ capacity: 1, refillPerSecond: 0.001 });
    const adapter = makeAdapter(stub, { rateBudget: budget });
    await adapter.get("/clients/x"); // consumes the one token
    const error = await rejection(adapter.get("/clients/x", undefined, { operation: "second" }));
    expect(error.kind).toBe("rate_limited");
    expect(error.detail["source"]).toBe("local_rate_budget");
  });
});

describe("createInvoiceNinjaAdapter — stats()", () => {
  it("reports baseUrl, sourceAccountKey, rate budget stats, and request count", async () => {
    const stub = createFetchStub([
      { body: ninjaItemEnvelope(clientFixture()) },
      { body: ninjaItemEnvelope(clientFixture()) },
    ]);
    const adapter = makeAdapter(stub);
    await adapter.get("/clients/x");
    await adapter.get("/clients/x");
    const stats = adapter.stats();
    expect(stats.baseUrl).toBe(TEST_BASE_URL);
    expect(stats.sourceAccountKey).toBe(`invoiceninja:${TEST_BASE_URL}`);
    expect(stats.requests).toBe(2);
    expect(stats.rateBudget.acquired).toBeGreaterThanOrEqual(2);
  });
});
