import { describe, expect, it } from "vitest";
import {
  WOO_DEFAULT_NAMESPACE,
  WooAdapterError,
  normalizeWooBaseUrl,
  parseWooAdapterConfig,
  wooSourceAccountKey,
} from "../src/index.ts";
import { TEST_KEY, TEST_SECRET } from "./http.ts";

const valid = {
  baseUrl: "https://shop.example.invalid",
  consumerKey: TEST_KEY,
  consumerSecret: TEST_SECRET,
};

describe("parseWooAdapterConfig", () => {
  it("applies documented defaults", () => {
    const config = parseWooAdapterConfig(valid);
    expect(config.namespace).toBe(WOO_DEFAULT_NAMESPACE);
    expect(config.restRoot).toBe("/wp-json");
    expect(config.timeoutMs).toBe(30_000);
    expect(config.baseUrl).toBe("https://shop.example.invalid");
  });

  it("rejects unknown keys (strict object)", () => {
    expect(() =>
      parseWooAdapterConfig({ ...valid, oauth: true } as never),
    ).toThrowError(WooAdapterError);
  });

  it.each([
    ["missing consumerKey", { ...valid, consumerKey: "" }],
    ["missing consumerSecret", { ...valid, consumerSecret: "" }],
    ["bad namespace", { ...valid, namespace: "wp/v2" }],
    ["bad restRoot", { ...valid, restRoot: "wp-json" }],
    ["zero timeout", { ...valid, timeoutMs: 0 }],
  ])("rejects %s", (_label, input) => {
    expect(() => parseWooAdapterConfig(input as never)).toThrowError(
      WooAdapterError,
    );
  });

  it("reports zod issues as path+code only, never the received value", () => {
    const secret = "cs_super_secret_value_that_must_not_leak";
    let thrown: WooAdapterError | undefined;
    try {
      // `namespace` fails; the secret is present but valid, so it must not be
      // echoed anywhere in the resulting error.
      parseWooAdapterConfig({
        ...valid,
        consumerSecret: secret,
        namespace: "nope",
      });
    } catch (error) {
      thrown = error as WooAdapterError;
    }
    expect(thrown).toBeInstanceOf(WooAdapterError);
    expect(thrown?.kind).toBe("invalid_request");
    expect(thrown?.detail["issues"]).toEqual([
      { path: "namespace", code: "invalid_format" },
    ]);
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect(JSON.stringify({ ...thrown, message: thrown?.message })).not.toContain(
      TEST_KEY,
    );
  });
});

describe("normalizeWooBaseUrl", () => {
  it("strips trailing slashes and an accidental /wp-json suffix", () => {
    expect(normalizeWooBaseUrl("https://shop.example.invalid/")).toBe(
      "https://shop.example.invalid",
    );
    expect(normalizeWooBaseUrl("https://shop.example.invalid/wp-json")).toBe(
      "https://shop.example.invalid",
    );
    expect(normalizeWooBaseUrl("https://shop.example.invalid/wp-json/")).toBe(
      "https://shop.example.invalid",
    );
  });

  it("preserves a subdirectory install path", () => {
    expect(normalizeWooBaseUrl("https://example.invalid/shop/")).toBe(
      "https://example.invalid/shop",
    );
    expect(normalizeWooBaseUrl("https://example.invalid/shop/wp-json")).toBe(
      "https://example.invalid/shop",
    );
  });

  it("rejects http — Loxep does not implement the OAuth 1.0a fallback", () => {
    const error = (() => {
      try {
        normalizeWooBaseUrl("http://shop.example.invalid");
        return null;
      } catch (e) {
        return e as WooAdapterError;
      }
    })();
    expect(error).toBeInstanceOf(WooAdapterError);
    expect(error?.kind).toBe("invalid_request");
    expect(error?.detail["protocol"]).toBe("http:");
  });

  it("rejects credentials smuggled into the URL", () => {
    expect(() =>
      normalizeWooBaseUrl("https://ck_key:cs_secret@shop.example.invalid"),
    ).toThrowError(WooAdapterError);
  });

  it("rejects a query string, a fragment, and a non-URL", () => {
    expect(() =>
      normalizeWooBaseUrl("https://shop.example.invalid?a=1"),
    ).toThrowError(WooAdapterError);
    expect(() =>
      normalizeWooBaseUrl("https://shop.example.invalid#x"),
    ).toThrowError(WooAdapterError);
    expect(() => normalizeWooBaseUrl("shop.example.invalid")).toThrowError(
      WooAdapterError,
    );
  });
});

describe("wooSourceAccountKey", () => {
  it("is the design's woocommerce:<siteUrl> and is normalization-stable", () => {
    expect(wooSourceAccountKey("https://shop.example.invalid/")).toBe(
      "woocommerce:https://shop.example.invalid",
    );
    expect(wooSourceAccountKey("https://shop.example.invalid/wp-json")).toBe(
      wooSourceAccountKey("https://shop.example.invalid"),
    );
  });
});
