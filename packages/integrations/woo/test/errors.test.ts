import { describe, expect, it } from "vitest";
import {
  WOO_ERROR_KINDS,
  WooAdapterError,
  isPageOutOfRangeCode,
  normalizeWooError,
  readWooErrorBody,
  wooErrorFromResponse,
  wooKindFromStatus,
} from "../src/index.ts";
import { wpErrorBody } from "./fixtures.ts";

const ctx = { operation: "orders.list", path: "/wp-json/wc/v3/orders" };

describe("taxonomy shape", () => {
  it("matches the eBay adapter's kind vocabulary exactly", () => {
    expect([...WOO_ERROR_KINDS]).toEqual([
      "auth",
      "rate_limited",
      "not_found",
      "invalid_request",
      "provider_unavailable",
    ]);
  });
});

describe("wooKindFromStatus", () => {
  it.each([
    [401, null, "auth"],
    [403, null, "auth"],
    [404, null, "not_found"],
    [429, null, "rate_limited"],
    [400, null, "invalid_request"],
    [422, null, "invalid_request"],
    [500, null, "provider_unavailable"],
    [502, null, "provider_unavailable"],
    [undefined, null, "provider_unavailable"],
  ])("status %s → %s", (status, code, expected) => {
    expect(wooKindFromStatus(status as number | undefined, code)).toBe(expected);
  });

  it("widens on WordPress/WooCommerce capability codes regardless of status", () => {
    expect(wooKindFromStatus(200, "woocommerce_rest_cannot_view")).toBe("auth");
    expect(wooKindFromStatus(400, "woocommerce_rest_authentication_error")).toBe(
      "auth",
    );
    expect(wooKindFromStatus(400, "rest_forbidden")).toBe("auth");
  });

  it("treats *_invalid_id as not_found", () => {
    expect(wooKindFromStatus(400, "woocommerce_rest_shop_order_invalid_id")).toBe(
      "not_found",
    );
  });
});

describe("wooErrorFromResponse — captured WooCommerce error shapes", () => {
  it("401 woocommerce_rest_cannot_view (observed for a bad key pair) → auth", () => {
    const error = wooErrorFromResponse(
      401,
      wpErrorBody(
        "woocommerce_rest_cannot_view",
        "Sorry, you cannot list resources.",
        401,
      ),
      ctx,
    );
    expect(error.kind).toBe("auth");
    expect(error.detail).toEqual({
      httpStatus: 401,
      operation: "orders.list",
      path: "/wp-json/wc/v3/orders",
      providerCode: "woocommerce_rest_cannot_view",
      providerMessage: "Sorry, you cannot list resources.",
    });
  });

  it("404 woocommerce_rest_shop_order_invalid_id → not_found", () => {
    const error = wooErrorFromResponse(
      404,
      wpErrorBody("woocommerce_rest_shop_order_invalid_id", "Invalid ID.", 404),
      ctx,
    );
    expect(error.kind).toBe("not_found");
    expect(error.detail["providerCode"]).toBe(
      "woocommerce_rest_shop_order_invalid_id",
    );
  });

  it("400 rest_invalid_param → invalid_request, param NAMES only", () => {
    const error = wooErrorFromResponse(
      400,
      wpErrorBody(
        "rest_invalid_param",
        "Invalid parameter(s): per_page",
        400,
        {
          params: { per_page: "per_page must be between 1 and 100" },
          details: { per_page: { code: "rest_out_of_bounds" } },
        },
      ),
      ctx,
    );
    expect(error.kind).toBe("invalid_request");
    expect(error.detail["invalidParams"]).toEqual(["per_page"]);
    // `data.params` VALUES echo caller input back and are deliberately dropped.
    const serialized = JSON.stringify(error.detail);
    expect(serialized).not.toContain("must be between");
    expect(serialized).not.toContain("rest_out_of_bounds");
  });

  it("429 → rate_limited", () => {
    expect(
      wooErrorFromResponse(429, wpErrorBody("too_many_requests", "Slow down", 429), ctx)
        .kind,
    ).toBe("rate_limited");
  });

  it("503 → provider_unavailable", () => {
    expect(wooErrorFromResponse(503, null, ctx).kind).toBe(
      "provider_unavailable",
    );
  });

  it("flags a body that is not a WP REST error at all", () => {
    const error = wooErrorFromResponse(500, { unexpected: true }, ctx);
    expect(error.detail["providerBodyShape"]).toBe("not-a-wp-rest-error");
    expect(error.detail["providerMessage"]).toBeUndefined();
  });

  it("records a provider status that disagrees with the HTTP status", () => {
    const error = wooErrorFromResponse(
      200,
      wpErrorBody("woocommerce_rest_cannot_view", "nope", 401),
      ctx,
    );
    expect(error.kind).toBe("auth");
    expect(error.detail["providerStatus"]).toBe(401);
  });
});

describe("readWooErrorBody", () => {
  it("returns all-null for non-error bodies", () => {
    for (const body of [null, undefined, 3, "x", [], { data: 1 }]) {
      expect(readWooErrorBody(body)).toEqual({
        code: null,
        message: null,
        status: null,
        invalidParams: [],
      });
    }
  });
});

describe("normalizeWooError", () => {
  it("passes an existing WooAdapterError through untouched", () => {
    const original = new WooAdapterError("auth", "already normalized");
    expect(normalizeWooError(original, ctx)).toBe(original);
  });

  it("maps AbortError/TimeoutError to provider_unavailable", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const normalized = normalizeWooError(abort, ctx);
    expect(normalized.kind).toBe("provider_unavailable");
    expect(normalized.detail["errorName"]).toBe("AbortError");
  });

  it("keeps the fetch failure cause code and drops everything else", () => {
    const failure = new TypeError("fetch failed");
    (failure as { cause?: unknown }).cause = {
      code: "ENOTFOUND",
      // A `fetch` rejection can carry the Request — with the Authorization
      // header on it. Nothing but `cause.code` may survive normalization.
      request: { headers: { authorization: "Basic SECRET_MATERIAL" } },
    };
    const normalized = normalizeWooError(failure, ctx);
    expect(normalized.kind).toBe("provider_unavailable");
    expect(normalized.detail["causeCode"]).toBe("ENOTFOUND");
    expect(JSON.stringify(normalized.detail)).not.toContain("SECRET_MATERIAL");
  });

  it("handles non-Error throwables", () => {
    const normalized = normalizeWooError("boom", ctx);
    expect(normalized.kind).toBe("provider_unavailable");
    expect(normalized.detail).toEqual(ctx);
  });
});

describe("isPageOutOfRangeCode", () => {
  it("recognizes the WordPress page-past-the-end codes", () => {
    expect(isPageOutOfRangeCode("rest_post_invalid_page_number")).toBe(true);
    expect(isPageOutOfRangeCode("rest_invalid_param")).toBe(false);
    expect(isPageOutOfRangeCode(null)).toBe(false);
  });
});
