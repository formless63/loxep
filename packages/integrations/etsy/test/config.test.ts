import { describe, expect, it } from "vitest";
import {
  EtsyAdapterError,
  ETSY_API_BASE_URL,
  etsySourceAccountKey,
  parseEtsyAdapterConfig,
} from "../src/index.ts";

describe("parseEtsyAdapterConfig", () => {
  it("accepts a keystring/sharedSecret pair with the default timeout", () => {
    const config = parseEtsyAdapterConfig({
      keystring: "fake-keystring",
      sharedSecret: "fake-shared-secret",
    });
    expect(config).toEqual({
      keystring: "fake-keystring",
      sharedSecret: "fake-shared-secret",
      timeoutMs: 30_000,
    });
  });

  it("accepts an explicit timeout override", () => {
    const config = parseEtsyAdapterConfig({
      keystring: "fake-keystring",
      sharedSecret: "fake-shared-secret",
      timeoutMs: 5_000,
    });
    expect(config.timeoutMs).toBe(5_000);
  });

  it("rejects an empty keystring or shared secret", () => {
    expect(() =>
      parseEtsyAdapterConfig({ keystring: "", sharedSecret: "x" }),
    ).toThrowError(EtsyAdapterError);
    expect(() =>
      parseEtsyAdapterConfig({ keystring: "x", sharedSecret: "" }),
    ).toThrowError(EtsyAdapterError);
  });

  it("rejects unknown keys (strict config)", () => {
    expect(() =>
      parseEtsyAdapterConfig({
        keystring: "x",
        sharedSecret: "y",
        baseUrl: "https://example.invalid",
      } as never),
    ).toThrowError(EtsyAdapterError);
  });

  it("reports issue paths and codes, never received values", () => {
    try {
      parseEtsyAdapterConfig({ keystring: "", sharedSecret: "super-secret-value" });
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EtsyAdapterError);
      const detail = (error as EtsyAdapterError).detail;
      expect(JSON.stringify(detail)).not.toContain("super-secret-value");
      expect(JSON.stringify(detail)).toContain("keystring");
    }
  });
});

describe("ETSY_API_BASE_URL", () => {
  it("is the fixed, non-configurable Etsy Open API v3 host", () => {
    expect(ETSY_API_BASE_URL).toBe("https://api.etsy.com/v3/application");
  });
});

describe("etsySourceAccountKey", () => {
  it("builds a per-shop identity", () => {
    expect(etsySourceAccountKey("55555")).toBe("etsy:55555");
  });

  it("trims whitespace", () => {
    expect(etsySourceAccountKey("  55555  ")).toBe("etsy:55555");
  });

  it("rejects an empty shop id", () => {
    expect(() => etsySourceAccountKey("  ")).toThrowError(EtsyAdapterError);
  });
});
