import { describe, expect, it } from "vitest";
import {
  EtsyAdapterError,
  etsyErrorFromResponse,
  etsyKindFromStatus,
  normalizeEtsyError,
  parseRetryAfterSeconds,
  readEtsyErrorBody,
} from "../src/index.ts";
import { etsyErrorBody } from "./fixtures.ts";

describe("etsyKindFromStatus — HTTP-status-first classification", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
    [429, "rate_limited"],
    [400, "invalid_request"],
    [409, "invalid_request"],
    [499, "invalid_request"],
    [500, "provider_unavailable"],
    [503, "provider_unavailable"],
    [undefined, "provider_unavailable"],
  ] as const)("HTTP %s -> %s", (status, kind) => {
    expect(etsyKindFromStatus(status)).toBe(kind);
  });
});

describe("readEtsyErrorBody", () => {
  it("reads Etsy's one-field {error} envelope", () => {
    expect(readEtsyErrorBody(etsyErrorBody("invalid listing_id"))).toEqual({
      message: "invalid listing_id",
    });
  });

  it("returns null for anything not shaped like Etsy's envelope", () => {
    expect(readEtsyErrorBody(null)).toEqual({ message: null });
    expect(readEtsyErrorBody("plain text")).toEqual({ message: null });
    expect(readEtsyErrorBody({ message: "wrong field" })).toEqual({ message: null });
  });
});

describe("parseRetryAfterSeconds", () => {
  it("parses a whole-seconds value", () => {
    expect(parseRetryAfterSeconds("30")).toBe(30);
  });

  it("rounds a fractional value up", () => {
    expect(parseRetryAfterSeconds("1.2")).toBe(2);
  });

  it("returns null for absent/empty/garbage values", () => {
    expect(parseRetryAfterSeconds(null)).toBeNull();
    expect(parseRetryAfterSeconds("")).toBeNull();
    expect(parseRetryAfterSeconds("not-a-number-or-date")).toBeNull();
  });
});

describe("etsyErrorFromResponse", () => {
  const context = { operation: "listings.get", path: "/v3/application/listings/1" };

  it("builds a credential-free auth error from 401/403", () => {
    const error = etsyErrorFromResponse(403, etsyErrorBody("insufficient_scope"), context);
    expect(error).toBeInstanceOf(EtsyAdapterError);
    expect(error.kind).toBe("auth");
    expect(error.detail).toEqual({
      httpStatus: 403,
      operation: context.operation,
      path: context.path,
      providerMessage: "insufficient_scope",
    });
  });

  it("attaches retryAfterSeconds only for rate_limited", () => {
    const error = etsyErrorFromResponse(
      429,
      etsyErrorBody("too many requests"),
      context,
      "12",
    );
    expect(error.kind).toBe("rate_limited");
    expect(error.detail["retryAfterSeconds"]).toBe(12);

    const withoutHeader = etsyErrorFromResponse(429, etsyErrorBody("too many"), context, null);
    expect(withoutHeader.detail["retryAfterSeconds"]).toBeUndefined();

    const notRateLimited = etsyErrorFromResponse(400, etsyErrorBody("bad"), context, "12");
    expect(notRateLimited.detail["retryAfterSeconds"]).toBeUndefined();
  });

  it("flags a body that is not Etsy's error shape without inventing a message", () => {
    const error = etsyErrorFromResponse(500, { unexpected: true }, context);
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["providerMessage"]).toBeUndefined();
    expect(error.detail["providerBodyShape"]).toBe("not-an-etsy-error");
  });

  it("never copies headers or request material into detail", () => {
    const error = etsyErrorFromResponse(404, etsyErrorBody("not found"), context);
    const keys = Object.keys(error.detail).sort();
    expect(keys).toEqual(["httpStatus", "operation", "path", "providerMessage"].sort());
  });
});

describe("normalizeEtsyError", () => {
  const context = { operation: "shops.get", path: "/v3/application/shops/1" };

  it("passes an EtsyAdapterError through unchanged", () => {
    const original = new EtsyAdapterError("auth", "already normalized");
    expect(normalizeEtsyError(original, context)).toBe(original);
  });

  it("classifies AbortError/TimeoutError as provider_unavailable", () => {
    const abort = new DOMException("aborted", "AbortError");
    const normalized = normalizeEtsyError(abort, context);
    expect(normalized.kind).toBe("provider_unavailable");
    expect(normalized.detail["errorName"]).toBe("AbortError");
  });

  it("reduces an arbitrary Error to name/message/code, dropping other properties", () => {
    const error = Object.assign(new Error("ECONNRESET"), {
      code: "ECONNRESET",
      // Anything else on the error (e.g. a captured Request with headers)
      // must never survive normalization.
      request: { headers: { "x-api-key": "leaked-secret" } },
    });
    const normalized = normalizeEtsyError(error, context);
    expect(normalized.kind).toBe("provider_unavailable");
    expect(normalized.detail["errorCode"]).toBe("ECONNRESET");
    expect(JSON.stringify(normalized.detail)).not.toContain("leaked-secret");
  });

  it("normalizes a non-Error thrown value without throwing itself", () => {
    const normalized = normalizeEtsyError("a string was thrown", context);
    expect(normalized.kind).toBe("provider_unavailable");
  });
});
