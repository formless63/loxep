/**
 * Error-taxonomy mapping against library-shaped errors constructed exactly
 * as ebay-api@10.0.0 constructs them (dist/errors). All embedded
 * "credential" strings are FAKE sentinels used to prove sanitization.
 */
import { errors as ebayErrors } from "ebay-api";
import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { EbayAdapterError, normalizeEbayError } from "../src/index.ts";

const FAKE_SECRET = "FAKE-SENTINEL-cert-value-never-real";

function meta(
  status: number | undefined,
  extra: Record<string, unknown> = {},
): never {
  return {
    ...extra,
    res: {
      status,
      statusText: "status text",
      headers: { "x-fake": "1", authorization: `Bearer ${FAKE_SECRET}` },
      data: { leaked: FAKE_SECRET },
    },
    req: {
      url: "https://api.sandbox.ebay.com/x",
      method: "GET",
      headers: { Authorization: `Basic ${FAKE_SECRET}` },
      params: { q: "x" },
    },
  } as never;
}

function serialize(error: EbayAdapterError): string {
  return (
    JSON.stringify({
      message: error.message,
      kind: error.kind,
      detail: error.detail,
    }) + inspect(error, { depth: 10 })
  );
}

describe("normalizeEbayError taxonomy", () => {
  it("maps library auth error classes to auth", () => {
    const cases = [
      new ebayErrors.EBayAccessDenied("Access denied", "d", meta(403)),
      new ebayErrors.EBayInvalidGrant("invalid_grant", "d", meta(400)),
      new ebayErrors.EBayInvalidAccessToken("Invalid access token", "d", meta(401)),
      new ebayErrors.EBayInvalidScope("invalid_scope", "d", meta(400)),
      new ebayErrors.EBayIAFTokenExpired("expired", "d", meta(401), 21917053),
      new ebayErrors.EBayTokenRequired("token required", "d", meta(401), 930),
    ];
    for (const libraryError of cases) {
      const normalized = normalizeEbayError(libraryError);
      expect(normalized).toBeInstanceOf(EbayAdapterError);
      expect(normalized.kind).toBe("auth");
    }
  });

  it("maps HTTP 401/403 generic API errors to auth", () => {
    for (const status of [401, 403]) {
      const normalized = normalizeEbayError(
        new ebayErrors.EBayApiError("boom", "d", meta(status)),
      );
      expect(normalized.kind).toBe("auth");
    }
  });

  it("maps EBayNotFound, errorId 11001, and HTTP 404 to not_found", () => {
    expect(
      normalizeEbayError(
        new ebayErrors.EBayNotFound("gone", "d", meta(404), 11001),
      ).kind,
    ).toBe("not_found");
    expect(
      normalizeEbayError(
        new ebayErrors.EBayApiError("gone", "d", meta(400), 11001),
      ).kind,
    ).toBe("not_found");
    expect(
      normalizeEbayError(new ebayErrors.EBayApiError("gone", "d", meta(404))).kind,
    ).toBe("not_found");
  });

  it("maps HTTP 429 to rate_limited", () => {
    const normalized = normalizeEbayError(
      new ebayErrors.EBayApiError("too many", "d", meta(429), 2001),
    );
    expect(normalized.kind).toBe("rate_limited");
    expect(normalized.detail["httpStatus"]).toBe(429);
  });

  it("maps other 4xx to invalid_request and 5xx/unknown to provider_unavailable", () => {
    expect(
      normalizeEbayError(new ebayErrors.EBayApiError("bad", "d", meta(400))).kind,
    ).toBe("invalid_request");
    expect(
      normalizeEbayError(new ebayErrors.EBayApiError("boom", "d", meta(500))).kind,
    ).toBe("provider_unavailable");
    expect(
      normalizeEbayError(new ebayErrors.EBayApiError("boom", "d", meta(undefined)))
        .kind,
    ).toBe("provider_unavailable");
  });

  it("classifies raw transport errors carrying an HTTP status (library OAuth mint path rethrows raw)", () => {
    const oauthFailure = Object.assign(new Error("Request failed with status code 401"), {
      isAxiosError: true,
      config: { auth: { username: "FAKE-app", password: FAKE_SECRET } },
      response: {
        status: 401,
        headers: { authorization: FAKE_SECRET },
        data: { error: "invalid_client", error_description: "client authentication failed" },
      },
    });
    const normalized = normalizeEbayError(oauthFailure);
    expect(normalized.kind).toBe("auth");
    expect(normalized.detail["httpStatus"]).toBe(401);
    expect(normalized.detail["providerMessage"]).toBe("invalid_client");
    expect(serialize(normalized)).not.toContain(FAKE_SECRET);
  });

  it("maps transport errors (no provider response) to provider_unavailable, keeping name/message only", () => {
    const transportError = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
      config: { headers: { Authorization: `Bearer ${FAKE_SECRET}` } },
    });
    const normalized = normalizeEbayError(transportError);
    expect(normalized.kind).toBe("provider_unavailable");
    expect(normalized.detail["errorCode"]).toBe("ECONNRESET");
    expect(serialize(normalized)).not.toContain(FAKE_SECRET);
  });

  it("maps local library misuse (EBayError) to invalid_request", () => {
    expect(
      normalizeEbayError(new ebayErrors.EBayNoCallError()).kind,
    ).toBe("invalid_request");
  });

  it("passes EbayAdapterError through unchanged", () => {
    const original = new EbayAdapterError("rate_limited", "x", { a: 1 });
    expect(normalizeEbayError(original)).toBe(original);
  });

  it("retains provider evidence but never headers, request config, or response bodies", () => {
    const firstError = {
      errorId: 11001,
      domain: "API_BROWSE",
      category: "REQUEST",
      message: "The specified item Id was not found.",
      longMessage: "The specified item Id was not found.",
      severity: "ERROR",
      httpStatusCode: 404,
    };
    const normalized = normalizeEbayError(
      new ebayErrors.EBayApiError(
        "The specified item Id was not found.",
        "long",
        meta(404, firstError),
        11001,
        firstError as never,
      ),
    );
    expect(normalized.detail["providerErrorCode"]).toBe(11001);
    expect(normalized.detail["httpStatus"]).toBe(404);
    expect(normalized.detail["firstError"]).toEqual(firstError);
    expect(normalized.detail).not.toHaveProperty("req");
    expect(normalized.detail).not.toHaveProperty("res");
    expect(normalized.detail).not.toHaveProperty("meta");
    const text = serialize(normalized);
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).not.toContain("Authorization");
    expect(text).not.toContain("api.sandbox.ebay.com/x");
  });
});
