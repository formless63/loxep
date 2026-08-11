/**
 * Typed secret-bundle validation (ADR-0019). Pure — no database. The rule
 * under test that matters most: validation failures report issue PATHS and
 * CODES, never the offending values, because those values are credentials.
 */
import { describe, expect, it } from "vitest";
import {
  BundleValidationError,
  UnknownPurposeError,
  isSecretPurpose,
  secretPurposes,
  validateBundle,
} from "../src/index.ts";

const FAKE_CERT = "SBX-fakefakefake-abcd-1234-5678-9abc";

describe("secret bundle registry", () => {
  it("registers every purpose Loxep persists today", () => {
    expect([...secretPurposes].sort()).toEqual([
      "ebay_keyset",
      "oauth_tokens",
      "s3_credentials",
      "smtp_password",
      "token",
      "woo_credentials",
    ]);
    expect(isSecretPurpose("ebay_keyset")).toBe(true);
    expect(isSecretPurpose("ebay_oauth")).toBe(false);
  });

  it("rejects unregistered purposes", () => {
    expect(() => validateBundle("nope" as "token", { token: "t" })).toThrowError(
      UnknownPurposeError,
    );
  });
});

describe("ebay_keyset bundle", () => {
  const keyset = {
    appId: "FakeApp-fakefake-SBX-0123456789ab-cdef0123",
    certId: FAKE_CERT,
    devId: "01234567-89ab-cdef-0123-456789abcdef",
    environment: "sandbox",
  } as const;

  it("accepts a keyset with and without a RuName", () => {
    expect(validateBundle("ebay_keyset", keyset)).toEqual(keyset);
    const withRuName = { ...keyset, ruName: "Fake_Loxep-FakeApp-abcdef" };
    expect(validateBundle("ebay_keyset", withRuName)).toEqual(withRuName);
  });

  it("requires the environment to be explicit and known", () => {
    expect(() =>
      validateBundle("ebay_keyset", { ...keyset, environment: "staging" }),
    ).toThrowError(BundleValidationError);
    const { environment: _dropped, ...withoutEnvironment } = keyset;
    expect(() =>
      validateBundle("ebay_keyset", withoutEnvironment),
    ).toThrowError(BundleValidationError);
  });

  it("rejects empty parts and unknown keys (strict bundle)", () => {
    expect(() =>
      validateBundle("ebay_keyset", { ...keyset, certId: "" }),
    ).toThrowError(BundleValidationError);
    expect(() =>
      validateBundle("ebay_keyset", { ...keyset, oops: "x" }),
    ).toThrowError(BundleValidationError);
  });

  it("never echoes credential values in the validation message", () => {
    try {
      validateBundle("ebay_keyset", {
        ...keyset,
        environment: "staging",
        stray: FAKE_CERT,
      });
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BundleValidationError);
      const message = (error as Error).message;
      expect(message).toContain("environment");
      expect(message).not.toContain(FAKE_CERT);
      expect(message).not.toContain(keyset.appId);
    }
  });
});

describe("oauth_tokens bundle (the eBay user-token slot)", () => {
  it("accepts the access/refresh pair Loxep stores for a connection", () => {
    const payload = {
      accessToken: "FAKE-ACCESS",
      refreshToken: "FAKE-REFRESH",
    };
    expect(validateBundle("oauth_tokens", payload)).toEqual(payload);
  });

  it("rejects extra fields — expiries/scopes are metadata, not secrets", () => {
    expect(() =>
      validateBundle("oauth_tokens", {
        accessToken: "FAKE-ACCESS",
        refreshToken: "FAKE-REFRESH",
        accessTokenExpiresAt: "2026-08-11T12:00:00.000Z",
      }),
    ).toThrowError(BundleValidationError);
  });
});

describe("woo_credentials bundle (the WooCommerce REST key pair)", () => {
  const pair = {
    consumerKey: "ck_fakefakefakefakefakefakefakefakefakefake",
    consumerSecret: "cs_fakefakefakefakefakefakefakefakefakefake",
  };

  it("accepts the consumer key/secret pair atomically", () => {
    expect(validateBundle("woo_credentials", pair)).toEqual(pair);
  });

  it("rejects a half-configured pair", () => {
    const { consumerSecret: _dropped, ...keyOnly } = pair;
    expect(() => validateBundle("woo_credentials", keyOnly)).toThrowError(
      BundleValidationError,
    );
    expect(() =>
      validateBundle("woo_credentials", { ...pair, consumerSecret: "" }),
    ).toThrowError(BundleValidationError);
  });

  it("rejects the store URL — baseUrl is non-secret connection config", () => {
    expect(() =>
      validateBundle("woo_credentials", {
        ...pair,
        baseUrl: "https://shop.example.invalid",
      }),
    ).toThrowError(BundleValidationError);
  });

  it("reports issue paths and codes, never the secret itself", () => {
    try {
      validateBundle("woo_credentials", { ...pair, consumerSecret: 42 });
      throw new Error("expected a BundleValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(BundleValidationError);
      const message = (error as Error).message;
      expect(message).toContain("consumerSecret");
      expect(message).not.toContain(pair.consumerKey);
    }
  });
});
