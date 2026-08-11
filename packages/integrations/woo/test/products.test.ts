import { describe, expect, it } from "vitest";
import {
  DECIMAL_STRING,
  WooAdapterError,
  buildWooProductsQuery,
  createWooAdapter,
  fetchProducts,
  fetchProductsPage,
  iterateWooProducts,
  mapWooProduct,
} from "../src/index.ts";
import {
  TEST_BASE_URL,
  TEST_KEY,
  TEST_SECRET,
  createFetchStub,
  type FetchStub,
} from "./http.ts";
import { productFixture } from "./fixtures.ts";

function makeAdapter(stub: FetchStub) {
  return createWooAdapter({
    baseUrl: TEST_BASE_URL,
    consumerKey: TEST_KEY,
    consumerSecret: TEST_SECRET,
    fetchImpl: stub.impl,
  });
}

describe("mapWooProduct", () => {
  it("maps the minimal channel-listing identity fields", () => {
    const fact = mapWooProduct(productFixture());
    expect(fact).toMatchObject({
      externalProductId: "900",
      sku: "FIX-WIDGET-01",
      name: "Fixture Widget",
      status: "publish",
      price: "22.50",
      type: "simple",
      permalink: "https://shop.example.invalid/product/fixture-widget/",
      updatedAt: "2026-06-02T14:00:00.000Z",
    });
    expect(fact.price).toMatch(DECIMAL_STRING);
  });

  it("keeps the full payload for provenance", () => {
    expect(mapWooProduct(productFixture()).raw["stock_quantity"]).toBe(12);
  });

  it("maps an empty SKU and an empty price to null", () => {
    const fact = mapWooProduct(productFixture({ sku: "", price: "" }));
    expect(fact.sku).toBeNull();
    expect(fact.price).toBeNull();
  });

  it("carries an unknown, plugin-registered status through unchanged", () => {
    expect(mapWooProduct(productFixture({ status: "wc-custom" })).status).toBe(
      "wc-custom",
    );
  });

  it("refuses a payload with no id", () => {
    expect(() => mapWooProduct(productFixture({ id: null }))).toThrowError(
      WooAdapterError,
    );
  });
});

describe("buildWooProductsQuery", () => {
  it("defaults to every status, newest first", () => {
    expect(buildWooProductsQuery()).toEqual({
      page: 1,
      per_page: 20,
      status: "any",
      orderby: "date",
      order: "desc",
    });
  });

  it("supports the exact-SKU lookup and the modified watermark", () => {
    const query = buildWooProductsQuery({
      sku: "FIX-WIDGET-01",
      modifiedAfter: "2026-06-01T00:00:00Z",
    });
    expect(query["sku"]).toBe("FIX-WIDGET-01");
    expect(query["modified_after"]).toBe("2026-06-01T00:00:00.000Z");
    expect(query["dates_are_gmt"]).toBe("true");
  });

  it("clamps per_page", () => {
    expect(buildWooProductsQuery({ perPage: 500 })["per_page"]).toBe(100);
  });

  it("rejects an unparseable date filter", () => {
    expect(() => buildWooProductsQuery({ modifiedAfter: "nope" })).toThrowError(
      WooAdapterError,
    );
  });
});

describe("fetchProducts / fetchProductsPage / iterateWooProducts", () => {
  it("fetches and maps one page", async () => {
    const stub = createFetchStub([
      {
        body: [productFixture(), productFixture({ id: 901, sku: "B" })],
        headers: { "x-wp-total": "17", "x-wp-totalpages": "9" },
      },
    ]);
    const products = await fetchProducts(makeAdapter(stub), { perPage: 2 });
    expect(products.map((p) => p.externalProductId)).toEqual(["900", "901"]);
    expect(stub.pathOf(0)).toBe("/wp-json/wc/v3/products");
  });

  it("returns pagination headers", async () => {
    const stub = createFetchStub([
      {
        body: [productFixture()],
        headers: { "x-wp-total": "17", "x-wp-totalpages": "9" },
      },
    ]);
    const result = await fetchProductsPage(makeAdapter(stub), { perPage: 2 });
    expect(result.page).toMatchObject({ total: 17, totalPages: 9, hasNextPage: true });
  });

  it("iterates pages", async () => {
    const stub = createFetchStub((index) => ({
      body: [productFixture({ id: 900 + index })],
      headers: { "x-wp-total": "2", "x-wp-totalpages": "2" },
    }));
    const ids: string[] = [];
    for await (const page of iterateWooProducts(makeAdapter(stub), { perPage: 1 })) {
      ids.push(...page.products.map((p) => p.externalProductId));
    }
    expect(ids).toEqual(["900", "901"]);
  });
});
