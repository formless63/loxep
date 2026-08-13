import { describe, expect, it } from "vitest";
import {
  INVOICENINJA_ERROR_KINDS,
  InvoiceNinjaAdapterError,
  invoiceNinjaErrorFromResponse,
  invoiceNinjaKindFromStatus,
  normalizeInvoiceNinjaError,
  readInvoiceNinjaErrorBody,
} from "../src/index.ts";
import { invalidTokenErrorBody, validationErrorBody } from "./fixtures.ts";

const CONTEXT = { operation: "clients.list", path: "/api/v1/clients" };

describe("readInvoiceNinjaErrorBody", () => {
  it("extracts the message from the auth-failure envelope", () => {
    expect(readInvoiceNinjaErrorBody(invalidTokenErrorBody())).toEqual({
      message: "Invalid token",
      errorFields: [],
    });
  });

  it("extracts message and field NAMES ONLY from a validation envelope, never the messages", () => {
    const body = validationErrorBody({
      client_id: ["The client id field is required."],
      "line_items.0.cost": ["The cost must be a number."],
    });
    const parsed = readInvoiceNinjaErrorBody(body);
    expect(parsed.message).toBe("The given data was invalid.");
    expect(parsed.errorFields.sort()).toEqual(
      ["client_id", "line_items.0.cost"].sort(),
    );
  });

  it("returns all-empty for a body that is not Invoice-Ninja-error-shaped", () => {
    expect(readInvoiceNinjaErrorBody(null)).toEqual({
      message: null,
      errorFields: [],
    });
    expect(readInvoiceNinjaErrorBody([1, 2, 3])).toEqual({
      message: null,
      errorFields: [],
    });
    expect(readInvoiceNinjaErrorBody("plain text")).toEqual({
      message: null,
      errorFields: [],
    });
  });
});

describe("invoiceNinjaKindFromStatus", () => {
  it("classifies auth from 401/403 — the live-verified TokenAuth failure shape", () => {
    expect(invoiceNinjaKindFromStatus(401)).toBe("auth");
    expect(invoiceNinjaKindFromStatus(403)).toBe("auth");
  });

  it("classifies not_found from 404", () => {
    expect(invoiceNinjaKindFromStatus(404)).toBe("not_found");
  });

  it("classifies rate_limited from 429 (throttle:api)", () => {
    expect(invoiceNinjaKindFromStatus(429)).toBe("rate_limited");
  });

  it("classifies invalid_request from other 4xx (422 validation failures included)", () => {
    expect(invoiceNinjaKindFromStatus(400)).toBe("invalid_request");
    expect(invoiceNinjaKindFromStatus(422)).toBe("invalid_request");
  });

  it("classifies provider_unavailable for 5xx and unclassifiable status", () => {
    expect(invoiceNinjaKindFromStatus(500)).toBe("provider_unavailable");
    expect(invoiceNinjaKindFromStatus(503)).toBe("provider_unavailable");
    expect(invoiceNinjaKindFromStatus(undefined)).toBe("provider_unavailable");
  });

  it("every kind returned is in the exported taxonomy", () => {
    for (const status of [400, 401, 403, 404, 422, 429, 500, 503]) {
      expect(INVOICENINJA_ERROR_KINDS).toContain(
        invoiceNinjaKindFromStatus(status),
      );
    }
  });
});

describe("invoiceNinjaErrorFromResponse", () => {
  it("builds a sanitized auth error carrying the provider message plus status/path", () => {
    const error = invoiceNinjaErrorFromResponse(
      403,
      invalidTokenErrorBody(),
      CONTEXT,
    );
    expect(error).toBeInstanceOf(InvoiceNinjaAdapterError);
    expect(error.kind).toBe("auth");
    expect(error.detail).toEqual({
      httpStatus: 403,
      operation: "clients.list",
      path: "/api/v1/clients",
      providerMessage: "Invalid token",
    });
  });

  it("carries validation field NAMES but never the message text in detail", () => {
    const body = validationErrorBody({
      client_id: ["The client id field is required."],
    });
    const error = invoiceNinjaErrorFromResponse(422, body, CONTEXT);
    expect(error.kind).toBe("invalid_request");
    expect(error.detail["providerErrorFields"]).toEqual(["client_id"]);
    const serialized = JSON.stringify(error.detail);
    expect(serialized).not.toContain("field is required");
  });

  it("flags a body that is not Invoice-Ninja-error-shaped", () => {
    const error = invoiceNinjaErrorFromResponse(500, { unexpected: true }, CONTEXT);
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["providerBodyShape"]).toBe("not-an-invoiceninja-error");
  });

  it("never puts headers, query strings, or the raw body in detail", () => {
    const error = invoiceNinjaErrorFromResponse(403, invalidTokenErrorBody(), CONTEXT);
    const keys = Object.keys(error.detail);
    expect(keys).toEqual(
      expect.arrayContaining(["httpStatus", "operation", "path"]),
    );
    expect(keys).not.toContain("headers");
    expect(keys).not.toContain("query");
    expect(keys).not.toContain("body");
  });
});

describe("normalizeInvoiceNinjaError", () => {
  it("passes an existing InvoiceNinjaAdapterError through unchanged", () => {
    const original = new InvoiceNinjaAdapterError("auth", "already normalized");
    expect(normalizeInvoiceNinjaError(original, CONTEXT)).toBe(original);
  });

  it("classifies abort/timeout as provider_unavailable", () => {
    const abort = new DOMException("aborted", "AbortError");
    const error = normalizeInvoiceNinjaError(abort, CONTEXT);
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["errorName"]).toBe("AbortError");
  });

  it("keeps the cause code from a fetch network failure without leaking the Request", () => {
    const cause = { code: "ENOTFOUND" };
    const networkError = Object.assign(new Error("fetch failed"), { cause });
    const error = normalizeInvoiceNinjaError(networkError, CONTEXT);
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["causeCode"]).toBe("ENOTFOUND");
    expect(error.detail).not.toHaveProperty("request");
    expect(error.detail).not.toHaveProperty("cause");
  });

  it("reduces a non-Error throw to a safe base detail", () => {
    const error = normalizeInvoiceNinjaError("boom", CONTEXT);
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail).toEqual({
      operation: "clients.list",
      path: "/api/v1/clients",
    });
  });
});
