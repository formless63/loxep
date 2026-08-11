import { describe, expect, it } from "vitest";
import {
  MEDUSA_ERROR_KINDS,
  MedusaAdapterError,
  medusaErrorFromResponse,
  medusaKindFromStatus,
  normalizeMedusaError,
  readMedusaErrorBody,
} from "../src/index.ts";
import { medusaErrorBody } from "./fixtures.ts";

const CONTEXT = { operation: "orders.list", path: "/admin/orders" };

describe("readMedusaErrorBody", () => {
  it("extracts the {type, message, code} triple", () => {
    const body = medusaErrorBody("not_found", "Order was not found", "not_found");
    expect(readMedusaErrorBody(body)).toEqual({
      type: "not_found",
      message: "Order was not found",
      code: "not_found",
    });
  });

  it("tolerates a missing code (body-parser-level errors omit it)", () => {
    const body = medusaErrorBody("invalid_data", "Malformed JSON");
    expect(readMedusaErrorBody(body)).toEqual({
      type: "invalid_data",
      message: "Malformed JSON",
      code: null,
    });
  });

  it("returns all-null for a body that is not Medusa-error-shaped", () => {
    expect(readMedusaErrorBody(null)).toEqual({
      type: null,
      message: null,
      code: null,
    });
    expect(readMedusaErrorBody([1, 2, 3])).toEqual({
      type: null,
      message: null,
      code: null,
    });
    expect(readMedusaErrorBody("plain text")).toEqual({
      type: null,
      message: null,
      code: null,
    });
  });
});

describe("medusaKindFromStatus", () => {
  it("classifies auth from status or type", () => {
    expect(medusaKindFromStatus(401, null)).toBe("auth");
    expect(medusaKindFromStatus(403, null)).toBe("auth");
    expect(medusaKindFromStatus(500, "unauthorized")).toBe("auth");
    expect(medusaKindFromStatus(500, "forbidden")).toBe("auth");
  });

  it("classifies not_found from status or type", () => {
    expect(medusaKindFromStatus(404, null)).toBe("not_found");
    expect(medusaKindFromStatus(500, "not_found")).toBe("not_found");
  });

  it("classifies rate_limited from status only (no Medusa core type maps here)", () => {
    expect(medusaKindFromStatus(429, null)).toBe("rate_limited");
  });

  it("classifies invalid_request from known types and other 4xx", () => {
    expect(medusaKindFromStatus(400, "invalid_data")).toBe("invalid_request");
    expect(medusaKindFromStatus(409, "conflict")).toBe("invalid_request");
    expect(medusaKindFromStatus(422, "duplicate_error")).toBe("invalid_request");
    expect(medusaKindFromStatus(418, null)).toBe("invalid_request");
  });

  it("classifies provider_unavailable for 5xx and unclassifiable errors", () => {
    expect(medusaKindFromStatus(500, "api_error")).toBe("provider_unavailable");
    expect(medusaKindFromStatus(503, null)).toBe("provider_unavailable");
    expect(medusaKindFromStatus(undefined, null)).toBe("provider_unavailable");
  });

  it("every kind returned is in the exported taxonomy", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 503]) {
      expect(MEDUSA_ERROR_KINDS).toContain(medusaKindFromStatus(status, null));
    }
  });
});

describe("medusaErrorFromResponse", () => {
  it("builds a sanitized error carrying type/code/message plus status/path", () => {
    const body = medusaErrorBody(
      "not_found",
      "Order with id order_bogus was not found",
      "not_found",
    );
    const error = medusaErrorFromResponse(404, body, CONTEXT);
    expect(error).toBeInstanceOf(MedusaAdapterError);
    expect(error.kind).toBe("not_found");
    expect(error.detail).toEqual({
      httpStatus: 404,
      operation: "orders.list",
      path: "/admin/orders",
      providerType: "not_found",
      providerCode: "not_found",
      providerMessage: "Order with id order_bogus was not found",
    });
  });

  it("flags a body that is not Medusa-error-shaped", () => {
    const error = medusaErrorFromResponse(500, { unexpected: true }, CONTEXT);
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["providerBodyShape"]).toBe("not-a-medusa-error");
  });

  it("never puts headers, query strings, or the raw body in detail", () => {
    const error = medusaErrorFromResponse(
      401,
      medusaErrorBody("unauthorized", "Unauthorized"),
      CONTEXT,
    );
    const keys = Object.keys(error.detail);
    expect(keys).toEqual(
      expect.arrayContaining(["httpStatus", "operation", "path"]),
    );
    expect(keys).not.toContain("headers");
    expect(keys).not.toContain("query");
    expect(keys).not.toContain("body");
  });
});

describe("normalizeMedusaError", () => {
  it("passes an existing MedusaAdapterError through unchanged", () => {
    const original = new MedusaAdapterError("auth", "already normalized");
    expect(normalizeMedusaError(original, CONTEXT)).toBe(original);
  });

  it("classifies abort/timeout as provider_unavailable", () => {
    const abort = new DOMException("aborted", "AbortError");
    const error = normalizeMedusaError(abort, CONTEXT);
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["errorName"]).toBe("AbortError");
  });

  it("keeps the cause code from a fetch network failure without leaking the Request", () => {
    const cause = { code: "ENOTFOUND" };
    const networkError = Object.assign(new Error("fetch failed"), { cause });
    const error = normalizeMedusaError(networkError, CONTEXT);
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["causeCode"]).toBe("ENOTFOUND");
    expect(error.detail).not.toHaveProperty("request");
    expect(error.detail).not.toHaveProperty("cause");
  });

  it("reduces a non-Error throw to a safe base detail", () => {
    const error = normalizeMedusaError("boom", CONTEXT);
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail).toEqual({
      operation: "orders.list",
      path: "/admin/orders",
    });
  });
});
