import { describe, expect, it } from "vitest";
import { createWooAdapter, probeConnection } from "../src/index.ts";
import {
  TEST_BASE_URL,
  TEST_KEY,
  TEST_SECRET,
  createFailingFetchStub,
  createFetchStub,
  type FetchStub,
} from "./http.ts";
import { completedOrderFixture, wpErrorBody } from "./fixtures.ts";

function makeAdapter(stub: FetchStub) {
  return createWooAdapter({
    baseUrl: TEST_BASE_URL,
    consumerKey: TEST_KEY,
    consumerSecret: TEST_SECRET,
    fetchImpl: stub.impl,
  });
}

/** Shape observed live: `environment.version` is the WooCommerce version. */
const systemStatusBody = {
  environment: {
    home_url: "https://shop.example.invalid",
    version: "10.9.3",
    wp_version: "6.9.6",
  },
  database: {},
  active_plugins: [],
};

describe("probeConnection", () => {
  it("prefers system_status and extracts only the two versions", async () => {
    const stub = createFetchStub([{ body: systemStatusBody }]);
    const result = await probeConnection(makeAdapter(stub));
    expect(result).toEqual({
      ok: true,
      baseUrl: TEST_BASE_URL,
      namespace: "wc/v3",
      probe: "system_status",
      storeInfo: { wpVersion: "6.9.6", wcVersion: "10.9.3" },
      visibleOrderCount: null,
    });
    expect(stub.pathOf(0)).toBe("/wp-json/wc/v3/system_status");
    expect(stub.calls).toHaveLength(1);
  });

  it("accepts the older environment.wc_version spelling", async () => {
    const stub = createFetchStub([
      { body: { environment: { wc_version: "9.0.0", wp_version: "6.5" } } },
    ]);
    const result = await probeConnection(makeAdapter(stub));
    expect(result.storeInfo).toEqual({ wpVersion: "6.5", wcVersion: "9.0.0" });
  });

  it("degrades to the orders probe when the key lacks manage_woocommerce", async () => {
    const stub = createFetchStub([
      {
        status: 401,
        body: wpErrorBody(
          "woocommerce_rest_cannot_view",
          "Sorry, you cannot list resources.",
          401,
        ),
      },
      {
        body: [completedOrderFixture()],
        headers: { "x-wp-total": "562", "x-wp-totalpages": "562" },
      },
    ]);
    const result = await probeConnection(makeAdapter(stub));
    expect(result.ok).toBe(true);
    expect(result.probe).toBe("orders");
    expect(result.storeInfo).toEqual({ wpVersion: null, wcVersion: "10.9.3" });
    expect(result.visibleOrderCount).toBe(562);
    // The fallback asks for two harmless fields, so no PII crosses the wire.
    expect(stub.queryOf(1)["_fields"]).toEqual(["id,version"]);
    expect(stub.queryOf(1)["per_page"]).toEqual(["1"]);
  });

  it("degrades when system_status is not routed at all (404)", async () => {
    const stub = createFetchStub([
      { status: 404, body: wpErrorBody("rest_no_route", "No route", 404) },
      { body: [], headers: { "x-wp-total": "0", "x-wp-totalpages": "0" } },
    ]);
    const result = await probeConnection(makeAdapter(stub));
    expect(result.ok).toBe(true);
    expect(result.probe).toBe("orders");
    expect(result.visibleOrderCount).toBe(0);
    expect(result.storeInfo.wcVersion).toBeNull();
  });

  it("degrades when system_status answers 200 with an unexpected shape", async () => {
    const stub = createFetchStub([
      { body: { unexpected: true } },
      { body: [], headers: { "x-wp-total": "0" } },
    ]);
    expect((await probeConnection(makeAdapter(stub))).probe).toBe("orders");
  });

  it("reports ok:false with the auth kind for bogus credentials", async () => {
    const authFailure = {
      status: 401,
      body: wpErrorBody(
        "woocommerce_rest_cannot_view",
        "Sorry, you cannot list resources.",
        401,
      ),
    };
    const stub = createFetchStub([authFailure, authFailure]);
    const result = await probeConnection(makeAdapter(stub));
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("auth");
    expect(result.probe).toBeNull();
    expect(result.storeInfo).toEqual({ wpVersion: null, wcVersion: null });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TEST_KEY);
    expect(serialized).not.toContain(TEST_SECRET);
  });

  it("short-circuits on a transport failure instead of trying the fallback", async () => {
    const failure = new TypeError("fetch failed");
    (failure as { cause?: unknown }).cause = { code: "ENOTFOUND" };
    const stub = createFailingFetchStub(failure);
    const result = await probeConnection(makeAdapter(stub));
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("provider_unavailable");
    expect(stub.calls).toHaveLength(1);
  });
});
