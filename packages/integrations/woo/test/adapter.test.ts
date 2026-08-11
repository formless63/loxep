import { describe, expect, it } from "vitest";
import {
  WooAdapterError,
  createRateBudget,
  createWooAdapter,
  linkHeaderHasNext,
} from "../src/index.ts";
import type { WooAdapter } from "../src/index.ts";
import {
  TEST_BASE_URL,
  TEST_KEY,
  TEST_SECRET,
  createFailingFetchStub,
  createFetchStub,
  rejection,
  type FetchStub,
} from "./http.ts";
import { wpErrorBody } from "./fixtures.ts";

function makeAdapter(stub: FetchStub, overrides: Record<string, unknown> = {}) {
  return createWooAdapter({
    baseUrl: TEST_BASE_URL,
    consumerKey: TEST_KEY,
    consumerSecret: TEST_SECRET,
    fetchImpl: stub.impl,
    ...overrides,
  });
}

/** Page headers WordPress sends on a collection response. */
function pageHeaders(total: number, totalPages: number, next: boolean) {
  return {
    "x-wp-total": String(total),
    "x-wp-totalpages": String(totalPages),
    ...(next
      ? { link: '<https://shop.example.invalid/wp-json/wc/v3/orders?page=2>; rel="next"' }
      : {}),
  };
}

describe("request construction", () => {
  it("builds <base>/wp-json/wc/v3<path> and sends Basic auth in a header", async () => {
    const stub = createFetchStub([{ body: { ok: true } }]);
    await makeAdapter(stub).get("/orders/1");

    const call = stub.calls[0];
    expect(call?.url).toBe(
      "https://shop.example.invalid/wp-json/wc/v3/orders/1",
    );
    expect(call?.method).toBe("GET");

    const expected =
      "Basic " + Buffer.from(`${TEST_KEY}:${TEST_SECRET}`).toString("base64");
    expect(call?.headers["authorization"]).toBe(expected);
    expect(call?.headers["accept"]).toBe("application/json");
  });

  it("never places credentials in the URL or query string", async () => {
    const stub = createFetchStub([{ body: [] }]);
    await makeAdapter(stub).list("/orders", { per_page: 2 });
    const url = stub.calls[0]?.url ?? "";
    expect(url).not.toContain(TEST_KEY);
    expect(url).not.toContain(TEST_SECRET);
    expect(url).not.toContain("consumer_key");
    expect(url).not.toContain("consumer_secret");
  });

  it("serializes scalars and repeats array parameters WordPress-style", async () => {
    const stub = createFetchStub([{ body: [] }]);
    await makeAdapter(stub).list("/orders", {
      per_page: 2,
      dates_are_gmt: true,
      status: ["completed", "processing"],
      skipped: undefined,
      alsoSkipped: null,
    });
    const query = stub.queryOf(0);
    expect(query["per_page"]).toEqual(["2"]);
    expect(query["dates_are_gmt"]).toEqual(["true"]);
    expect(query["status[]"]).toEqual(["completed", "processing"]);
    expect(query["skipped"]).toBeUndefined();
    expect(query["alsoSkipped"]).toBeUndefined();
  });

  it("rejects a path that does not start with '/'", async () => {
    const stub = createFetchStub([]);
    await expect(makeAdapter(stub).get("orders")).rejects.toMatchObject({
      kind: "invalid_request",
    });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("rate budget", () => {
  it("acquires once per request before touching the network", async () => {
    const budget = createRateBudget({ capacity: 5, refillPerSecond: 100 });
    const stub = createFetchStub([{ body: [] }, { body: [] }]);
    const adapter = makeAdapter(stub, { rateBudget: budget });
    await adapter.list("/orders");
    await adapter.list("/products");
    expect(budget.stats().acquired).toBe(2);
    expect(adapter.stats().rateBudget.acquired).toBe(2);
    expect(adapter.stats().requests).toBe(2);
  });

  it("surfaces local exhaustion as rate_limited without a network call", async () => {
    const budget = createRateBudget({
      capacity: 1,
      refillPerSecond: 0.01,
      maxWaitMs: 1,
    });
    const stub = createFetchStub([{ body: [] }]);
    const adapter = makeAdapter(stub, { rateBudget: budget });
    await adapter.list("/orders");
    const error = await rejection(adapter.list("/orders"));
    expect(error).toBeInstanceOf(WooAdapterError);
    expect(error.kind).toBe("rate_limited");
    expect(error.detail["source"]).toBe("local_rate_budget");
    expect(stub.calls).toHaveLength(1);
  });
});

describe("response handling", () => {
  it("reads X-WP-Total / X-WP-TotalPages / Link into page info", async () => {
    const stub = createFetchStub([
      { body: [{ id: 1 }, { id: 2 }], headers: pageHeaders(562, 281, true) },
    ]);
    const result = await makeAdapter(stub).list("/orders", {
      per_page: 2,
      page: 1,
    });
    expect(result.page).toEqual({
      page: 1,
      perPage: 2,
      total: 562,
      totalPages: 281,
      hasNextPage: true,
    });
    expect(result.items).toHaveLength(2);
  });

  it("infers hasNextPage from totals when no Link header is sent", async () => {
    const stub = createFetchStub([
      { body: [{ id: 1 }], headers: { "x-wp-total": "3", "x-wp-totalpages": "3" } },
    ]);
    const result = await makeAdapter(stub).list("/orders", {
      per_page: 1,
      page: 2,
    });
    expect(result.page.hasNextPage).toBe(true);
    expect(result.page.total).toBe(3);
  });

  it("reports null totals when the endpoint sends no pagination headers", async () => {
    const stub = createFetchStub([{ body: [] }]);
    const result = await makeAdapter(stub).list("/orders");
    expect(result.page.total).toBeNull();
    expect(result.page.totalPages).toBeNull();
    expect(result.page.hasNextPage).toBe(false);
  });

  it("drops non-object entries from a collection", async () => {
    const stub = createFetchStub([{ body: [{ id: 1 }, "junk", null, 7] }]);
    const result = await makeAdapter(stub).list("/orders");
    expect(result.items).toEqual([{ id: 1 }]);
  });

  it("fails loudly when a collection endpoint returns a non-array", async () => {
    const stub = createFetchStub([{ body: { id: 1 } }]);
    await expect(makeAdapter(stub).list("/orders")).rejects.toMatchObject({
      kind: "provider_unavailable",
    });
  });

  it("treats a 200 with an HTML body as provider_unavailable and retains no HTML", async () => {
    const stub = createFetchStub([
      { text: "<html><body>WordPress fatal: secretish</body></html>" },
    ]);
    const error = await rejection(makeAdapter(stub).list("/orders"));
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["contentType"]).toBe("text/html");
    expect(JSON.stringify(error.detail)).not.toContain("secretish");
  });

  it("normalizes a transport failure without copying request material", async () => {
    const failure = new TypeError("fetch failed");
    (failure as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
    const stub = createFailingFetchStub(failure);
    const error = await rejection(makeAdapter(stub).get("/orders"));
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["causeCode"]).toBe("ECONNREFUSED");
    expect(error.detail["path"]).toBe("/wp-json/wc/v3/orders");
  });

  it("normalizes a WooCommerce error body to the taxonomy", async () => {
    const stub = createFetchStub([
      {
        status: 401,
        body: wpErrorBody(
          "woocommerce_rest_cannot_view",
          "Sorry, you cannot list resources.",
          401,
        ),
      },
    ]);
    const error = await rejection(makeAdapter(stub).list("/orders"));
    expect(error.kind).toBe("auth");
    expect(error.detail["operation"]).toBe("list/orders");
    // Nothing credential-shaped survives into the error.
    const serialized = JSON.stringify({ ...error.detail, m: error.message });
    expect(serialized).not.toContain(TEST_KEY);
    expect(serialized).not.toContain(TEST_SECRET);
    expect(serialized).not.toContain("Basic ");
  });
});

describe("pagination iterator", () => {
  async function collect(adapter: WooAdapter, options?: Parameters<WooAdapter["paginate"]>[1]) {
    const pages: Array<{ ids: unknown[]; page: number }> = [];
    for await (const page of adapter.paginate("/orders", options)) {
      pages.push({
        ids: page.items.map((item) => item["id"]),
        page: page.page.page,
      });
    }
    return pages;
  }

  it("walks pages using the header totals and stops at the last one", async () => {
    const stub = createFetchStub((index) => ({
      body: [{ id: index * 2 + 1 }, { id: index * 2 + 2 }],
      headers: pageHeaders(6, 3, index < 2),
    }));
    const pages = await collect(makeAdapter(stub), { perPage: 2 });
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(pages.flatMap((p) => p.ids)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stub.calls).toHaveLength(3);
    expect(stub.queryOf(2)["page"]).toEqual(["3"]);
    expect(stub.queryOf(2)["per_page"]).toEqual(["2"]);
  });

  it("stops on an empty page even when the headers claim more", async () => {
    const stub = createFetchStub([
      { body: [{ id: 1 }], headers: pageHeaders(99, 99, true) },
      { body: [], headers: pageHeaders(99, 99, true) },
    ]);
    const pages = await collect(makeAdapter(stub), { perPage: 1 });
    expect(pages).toHaveLength(2);
    expect(stub.calls).toHaveLength(2);
  });

  it("stops on a single page with no next link", async () => {
    const stub = createFetchStub([
      { body: [{ id: 1 }], headers: pageHeaders(1, 1, false) },
    ]);
    expect(await collect(makeAdapter(stub))).toHaveLength(1);
  });

  it("honours maxPages as a safety bound", async () => {
    const stub = createFetchStub(() => ({
      body: [{ id: 1 }],
      headers: pageHeaders(1000, 1000, true),
    }));
    const pages = await collect(makeAdapter(stub), { perPage: 1, maxPages: 4 });
    expect(pages).toHaveLength(4);
    expect(stub.calls).toHaveLength(4);
  });

  it("clamps per_page to WooCommerce's 1..100 range", async () => {
    const stub = createFetchStub([{ body: [] }]);
    await collect(makeAdapter(stub), { perPage: 5000 });
    expect(stub.queryOf(0)["per_page"]).toEqual(["100"]);

    const stub2 = createFetchStub([{ body: [] }]);
    await collect(makeAdapter(stub2), { perPage: 0 });
    expect(stub2.queryOf(0)["per_page"]).toEqual(["1"]);
  });

  it("starts at startPage and carries the caller's query on every page", async () => {
    const stub = createFetchStub((index) => ({
      body: [{ id: index }],
      headers: pageHeaders(10, 10, index < 1),
    }));
    await collect(makeAdapter(stub), {
      perPage: 1,
      startPage: 4,
      query: { status: "any" },
    });
    expect(stub.queryOf(0)["page"]).toEqual(["4"]);
    expect(stub.queryOf(1)["page"]).toEqual(["5"]);
    expect(stub.queryOf(1)["status"]).toEqual(["any"]);
  });

  it("ends gracefully when WordPress answers a past-the-end page with 400", async () => {
    const stub = createFetchStub([
      { body: [{ id: 1 }], headers: pageHeaders(2, 2, true) },
      {
        status: 400,
        body: wpErrorBody(
          "rest_post_invalid_page_number",
          "The page number requested is larger than the number of pages available.",
          400,
        ),
      },
    ]);
    const pages = await collect(makeAdapter(stub), { perPage: 1 });
    expect(pages).toHaveLength(1);
    expect(stub.calls).toHaveLength(2);
  });

  it("re-throws any other error instead of ending the walk silently", async () => {
    const stub = createFetchStub([
      { body: [{ id: 1 }], headers: pageHeaders(2, 2, true) },
      { status: 500, body: null },
    ]);
    await expect(collect(makeAdapter(stub), { perPage: 1 })).rejects.toMatchObject({
      kind: "provider_unavailable",
    });
  });
});

describe("linkHeaderHasNext", () => {
  it.each([
    ['<https://x/?page=2>; rel="next"', true],
    ['<https://x/?page=1>; rel="prev", <https://x/?page=3>; rel="next"', true],
    ["<https://x/?page=1>; rel=next", true],
    ['<https://x/?page=1>; rel="prev"', false],
    ['<https://x/?page=1>; rel="last"', false],
    [null, false],
  ])("%s → %s", (header, expected) => {
    expect(linkHeaderHasNext(header)).toBe(expected);
  });
});

describe("adapter identity", () => {
  it("exposes the design's source_account_key and never the credentials", () => {
    const stub = createFetchStub([]);
    const adapter = makeAdapter(stub);
    expect(adapter.sourceAccountKey).toBe(
      "woocommerce:https://shop.example.invalid",
    );
    const serialized = JSON.stringify({
      keys: Object.keys(adapter),
      stats: adapter.stats(),
    });
    expect(serialized).not.toContain(TEST_KEY);
    expect(serialized).not.toContain(TEST_SECRET);
    expect(Object.keys(adapter)).not.toContain("consumerKey");
    expect(Object.keys(adapter)).not.toContain("consumerSecret");
  });
});
