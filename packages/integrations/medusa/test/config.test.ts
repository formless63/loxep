import { describe, expect, it } from "vitest";
import {
  MedusaAdapterError,
  medusaSourceAccountKey,
  normalizeMedusaBaseUrl,
  parseMedusaAdapterConfig,
} from "../src/index.ts";
import { TEST_BASE_URL, TEST_TOKEN } from "./http.ts";

describe("normalizeMedusaBaseUrl", () => {
  it("keeps a plain https origin as-is", () => {
    expect(normalizeMedusaBaseUrl("https://commerce.example.invalid")).toBe(
      "https://commerce.example.invalid",
    );
  });

  it("strips a trailing slash and a pasted /admin suffix", () => {
    expect(normalizeMedusaBaseUrl("https://commerce.example.invalid/")).toBe(
      "https://commerce.example.invalid",
    );
    expect(
      normalizeMedusaBaseUrl("https://commerce.example.invalid/admin"),
    ).toBe("https://commerce.example.invalid");
    expect(
      normalizeMedusaBaseUrl("https://commerce.example.invalid/admin/"),
    ).toBe("https://commerce.example.invalid");
  });

  it("rejects http:", () => {
    expect(() =>
      normalizeMedusaBaseUrl("http://commerce.example.invalid"),
    ).toThrowError(MedusaAdapterError);
  });

  it("rejects embedded credentials", () => {
    expect(() =>
      normalizeMedusaBaseUrl("https://user:pass@commerce.example.invalid"),
    ).toThrowError(MedusaAdapterError);
  });

  it("rejects a query string or fragment", () => {
    expect(() =>
      normalizeMedusaBaseUrl("https://commerce.example.invalid?x=1"),
    ).toThrowError(MedusaAdapterError);
    expect(() =>
      normalizeMedusaBaseUrl("https://commerce.example.invalid#frag"),
    ).toThrowError(MedusaAdapterError);
  });

  it("rejects a malformed URL", () => {
    expect(() => normalizeMedusaBaseUrl("not a url")).toThrowError(
      MedusaAdapterError,
    );
  });
});

describe("parseMedusaAdapterConfig", () => {
  it("accepts a minimal valid config and applies the timeout default", () => {
    const config = parseMedusaAdapterConfig({
      baseUrl: TEST_BASE_URL,
      apiToken: TEST_TOKEN,
    });
    expect(config.baseUrl).toBe(TEST_BASE_URL);
    expect(config.apiToken).toBe(TEST_TOKEN);
    expect(config.timeoutMs).toBe(30_000);
  });

  it("requires the apiToken to start with sk_", () => {
    expect(() =>
      parseMedusaAdapterConfig({
        baseUrl: TEST_BASE_URL,
        apiToken: "not-a-secret-key",
      }),
    ).toThrowError(MedusaAdapterError);
  });

  it("rejects an empty apiToken", () => {
    expect(() =>
      parseMedusaAdapterConfig({ baseUrl: TEST_BASE_URL, apiToken: "" }),
    ).toThrowError(MedusaAdapterError);
  });

  it("reports zod issues as invalid_request with paths and codes only", () => {
    try {
      parseMedusaAdapterConfig({ baseUrl: "", apiToken: "" });
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MedusaAdapterError);
      const adapterError = error as MedusaAdapterError;
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
      parseMedusaAdapterConfig({
        baseUrl: TEST_BASE_URL,
        apiToken: TEST_TOKEN,
        extra: "nope",
      } as never),
    ).toThrowError(MedusaAdapterError);
  });
});

describe("medusaSourceAccountKey", () => {
  it("is deterministic from baseUrl alone, matching the design's source_account_key contract", () => {
    expect(medusaSourceAccountKey(TEST_BASE_URL)).toBe(
      `medusa:${TEST_BASE_URL}`,
    );
    expect(medusaSourceAccountKey(`${TEST_BASE_URL}/`)).toBe(
      `medusa:${TEST_BASE_URL}`,
    );
    expect(medusaSourceAccountKey(`${TEST_BASE_URL}/admin`)).toBe(
      `medusa:${TEST_BASE_URL}`,
    );
  });
});
