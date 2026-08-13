import { describe, expect, it } from "vitest";
import {
  InvoiceNinjaAdapterError,
  invoiceNinjaSourceAccountKey,
  normalizeInvoiceNinjaBaseUrl,
  parseInvoiceNinjaAdapterConfig,
} from "../src/index.ts";
import { TEST_BASE_URL, TEST_TOKEN } from "./http.ts";

describe("normalizeInvoiceNinjaBaseUrl", () => {
  it("keeps a plain https origin as-is", () => {
    expect(normalizeInvoiceNinjaBaseUrl("https://billing.example.invalid")).toBe(
      "https://billing.example.invalid",
    );
  });

  it("strips a trailing slash and a pasted /api/v1 suffix", () => {
    expect(normalizeInvoiceNinjaBaseUrl("https://billing.example.invalid/")).toBe(
      "https://billing.example.invalid",
    );
    expect(
      normalizeInvoiceNinjaBaseUrl("https://billing.example.invalid/api/v1"),
    ).toBe("https://billing.example.invalid");
    expect(
      normalizeInvoiceNinjaBaseUrl("https://billing.example.invalid/api/v1/"),
    ).toBe("https://billing.example.invalid");
  });

  it("rejects http:", () => {
    expect(() =>
      normalizeInvoiceNinjaBaseUrl("http://billing.example.invalid"),
    ).toThrowError(InvoiceNinjaAdapterError);
  });

  it("rejects embedded credentials", () => {
    expect(() =>
      normalizeInvoiceNinjaBaseUrl("https://user:pass@billing.example.invalid"),
    ).toThrowError(InvoiceNinjaAdapterError);
  });

  it("rejects a query string or fragment", () => {
    expect(() =>
      normalizeInvoiceNinjaBaseUrl("https://billing.example.invalid?x=1"),
    ).toThrowError(InvoiceNinjaAdapterError);
    expect(() =>
      normalizeInvoiceNinjaBaseUrl("https://billing.example.invalid#frag"),
    ).toThrowError(InvoiceNinjaAdapterError);
  });

  it("rejects a malformed URL", () => {
    expect(() => normalizeInvoiceNinjaBaseUrl("not a url")).toThrowError(
      InvoiceNinjaAdapterError,
    );
  });
});

describe("parseInvoiceNinjaAdapterConfig", () => {
  it("accepts a minimal valid config and applies the timeout default", () => {
    const config = parseInvoiceNinjaAdapterConfig({
      baseUrl: TEST_BASE_URL,
      apiToken: TEST_TOKEN,
    });
    expect(config.baseUrl).toBe(TEST_BASE_URL);
    expect(config.apiToken).toBe(TEST_TOKEN);
    expect(config.timeoutMs).toBe(30_000);
  });

  it("rejects an empty apiToken", () => {
    expect(() =>
      parseInvoiceNinjaAdapterConfig({ baseUrl: TEST_BASE_URL, apiToken: "" }),
    ).toThrowError(InvoiceNinjaAdapterError);
  });

  it("reports zod issues as invalid_request with paths and codes only", () => {
    try {
      parseInvoiceNinjaAdapterConfig({ baseUrl: "", apiToken: "" });
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvoiceNinjaAdapterError);
      const adapterError = error as InvoiceNinjaAdapterError;
      expect(adapterError.kind).toBe("invalid_request");
      const issues = adapterError.detail["issues"] as Array<{
        path: string;
        code: string;
      }>;
      expect(issues.some((issue) => issue.path === "baseUrl")).toBe(true);
      expect(issues.some((issue) => issue.path === "apiToken")).toBe(true);
      expect(JSON.stringify(adapterError.detail)).not.toContain(TEST_TOKEN);
    }
  });

  it("rejects an unknown key (strict object)", () => {
    expect(() =>
      parseInvoiceNinjaAdapterConfig({
        baseUrl: TEST_BASE_URL,
        apiToken: TEST_TOKEN,
        extra: "nope",
      } as never),
    ).toThrowError(InvoiceNinjaAdapterError);
  });
});

describe("invoiceNinjaSourceAccountKey", () => {
  it("is deterministic from baseUrl alone", () => {
    expect(invoiceNinjaSourceAccountKey(TEST_BASE_URL)).toBe(
      `invoiceninja:${TEST_BASE_URL}`,
    );
    expect(invoiceNinjaSourceAccountKey(`${TEST_BASE_URL}/`)).toBe(
      `invoiceninja:${TEST_BASE_URL}`,
    );
    expect(invoiceNinjaSourceAccountKey(`${TEST_BASE_URL}/api/v1`)).toBe(
      `invoiceninja:${TEST_BASE_URL}`,
    );
  });
});
