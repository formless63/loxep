import { describe, expect, it } from "vitest";
import {
  DECIMAL_STRING,
  MEDUSA_PRODUCT_STATUSES,
  MedusaAdapterError,
  buildMedusaProductsQuery,
  createMedusaAdapter,
  fetchProducts,
  fetchProductsPage,
  iterateMedusaProducts,
  mapMedusaProduct,
} from "../src/index.ts";
import {
  TEST_BASE_URL,
  TEST_TOKEN,
  createFetchStub,
  type FetchStub,
} from "./http.ts";
import { multiVariantProductFixture, productFixture } from "./fixtures.ts";

function makeAdapter(stub: FetchStub) {
  return createMedusaAdapter({
    baseUrl: TEST_BASE_URL,
    apiToken: TEST_TOKEN,
    fetchImpl: stub.impl,
  });
}

describe("mapMedusaProduct", () => {
  it("maps the ordinary single-variant product", () => {
    const fact = mapMedusaProduct(productFixture());
    expect(fact.externalProductId).toBe("prod_01FIXTURE0001");
    expect(fact.title).toBe("Fixture Widget");
    expect(fact.status).toBe("published");
    expect(fact.handle).toBe("fixture-widget");
    expect(MEDUSA_PRODUCT_STATUSES).toContain(fact.status);
    expect(fact.updatedAt).toBe("2026-06-02T14:00:00.000Z");
  });

  it("reports variants[] with per-variant sku and prices — no forced single top-level price", () => {
    const fact = mapMedusaProduct(productFixture());
    expect(fact.variants).toEqual([
      {
        externalVariantId: "variant_01FIXTURE0001",
        sku: "FIX-WIDGET-01",
        title: "Default",
        prices: [
          { currencyCode: "USD", amount: "22.5" },
          { currencyCode: "EUR", amount: "20.99" },
        ],
      },
    ]);
  });

  it("reports multiple variants faithfully — a real Medusa shape, unlike a WooCommerce simple product", () => {
    const fact = mapMedusaProduct(multiVariantProductFixture());
    expect(fact.variants).toHaveLength(2);
    expect(fact.variants.map((v) => v.sku)).toEqual([
      "FIX-SHIRT-S-BLUE",
      "FIX-SHIRT-L-BLUE",
    ]);
  });

  it("maps a null variant sku to null", () => {
    const fact = mapMedusaProduct(
      productFixture({
        variants: [
          {
            id: "variant_x",
            title: "Default",
            sku: null,
            prices: [],
          },
        ],
      }),
    );
    expect(fact.variants[0]?.sku).toBeNull();
  });

  it("tolerates a missing variants array", () => {
    expect(mapMedusaProduct(productFixture({ variants: undefined })).variants).toEqual(
      [],
    );
  });

  it("refuses to build a fact without an id", () => {
    expect(() => mapMedusaProduct(productFixture({ id: null }))).toThrowError(
      MedusaAdapterError,
    );
  });

  it("emits decimal strings for every variant price", () => {
    for (const fixture of [productFixture(), multiVariantProductFixture()]) {
      const fact = mapMedusaProduct(fixture);
      for (const variant of fact.variants) {
        for (const price of variant.prices) {
          expect(price.amount).toMatch(DECIMAL_STRING);
          expect(price.currencyCode).toMatch(/^[A-Z]{3}$/);
        }
      }
    }
  });

  it("has no personal data to redact, unlike an order — raw is safe to keep", () => {
    const fact = mapMedusaProduct(productFixture());
    expect(fact.raw).toEqual(productFixture());
  });
});

describe("buildMedusaProductsQuery", () => {
  it("defaults offset 0, does not force a fields override (unlike orders)", () => {
    const query = buildMedusaProductsQuery();
    expect(query["offset"]).toBe(0);
    expect(query["fields"]).toBeUndefined();
  });

  it("clamps limit to Loxep's own bounds", () => {
    expect(buildMedusaProductsQuery({ limit: 100_000 })["limit"]).toBeLessThanOrEqual(
      200,
    );
    expect(buildMedusaProductsQuery({ limit: -3 })["limit"]).toBe(1);
  });

  it("adds the updated_at[$gte] filter for a watermark", () => {
    const query = buildMedusaProductsQuery({
      updatedAfter: "2026-01-01T00:00:00Z",
    });
    expect(query["updated_at[$gte]"]).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("fetchProducts / fetchProductsPage / iterateMedusaProducts", () => {
  it("fetches and maps one page from the body envelope", async () => {
    const stub = createFetchStub([
      {
        body: {
          products: [productFixture(), multiVariantProductFixture()],
          count: 2,
          offset: 0,
          limit: 2,
        },
      },
    ]);
    const products = await fetchProducts(makeAdapter(stub), { limit: 2 });
    expect(products.map((p) => p.externalProductId)).toEqual([
      "prod_01FIXTURE0001",
      "prod_01FIXTURE0002",
    ]);
    expect(stub.pathOf(0)).toBe("/admin/products");
  });

  it("returns pagination info alongside the facts", async () => {
    const stub = createFetchStub([
      { body: { products: [productFixture()], count: 40, offset: 0, limit: 2 } },
    ]);
    const result = await fetchProductsPage(makeAdapter(stub), { limit: 2 });
    expect(result.page.count).toBe(40);
    expect(result.page.hasNextPage).toBe(true);
  });

  it("iterates every page by offset", async () => {
    const stub = createFetchStub((index) => ({
      body: {
        products: [productFixture({ id: `prod_${3000 + index}` })],
        count: 3,
        offset: index,
        limit: 1,
      },
    }));
    const ids: string[] = [];
    for await (const page of iterateMedusaProducts(makeAdapter(stub), {
      limit: 1,
    })) {
      ids.push(...page.products.map((p) => p.externalProductId));
    }
    expect(ids).toEqual(["prod_3000", "prod_3001", "prod_3002"]);
  });
});
