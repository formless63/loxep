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
      "cloudflare_credentials",
      "ebay_keyset",
      "etsy_keyset",
      "invoiceninja_credentials",
      "mailbox_password",
      "medusa_credentials",
      "oauth_tokens",
      "purelymail_credentials",
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

describe("medusa_credentials bundle (the Medusa v2 Admin API secret key)", () => {
  const FAKE_TOKEN = "sk_fakefakefakefakefakefakefakefakefakefake";

  it("accepts the single secret token", () => {
    expect(validateBundle("medusa_credentials", { apiToken: FAKE_TOKEN })).toEqual(
      { apiToken: FAKE_TOKEN },
    );
  });

  it("rejects an empty token", () => {
    expect(() =>
      validateBundle("medusa_credentials", { apiToken: "" }),
    ).toThrowError(BundleValidationError);
  });

  it("rejects a missing token", () => {
    expect(() => validateBundle("medusa_credentials", {})).toThrowError(
      BundleValidationError,
    );
  });

  it("rejects the backend URL — baseUrl is non-secret connection config", () => {
    expect(() =>
      validateBundle("medusa_credentials", {
        apiToken: FAKE_TOKEN,
        baseUrl: "https://commerce.example.invalid",
      }),
    ).toThrowError(BundleValidationError);
  });

  it("reports issue paths and codes, never the secret itself", () => {
    try {
      validateBundle("medusa_credentials", { apiToken: 42 });
      throw new Error("expected a BundleValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(BundleValidationError);
      const message = (error as Error).message;
      expect(message).toContain("apiToken");
      expect(message).not.toContain(FAKE_TOKEN);
    }
  });
});

describe("etsy_keyset bundle (the Etsy Developer Portal application keyset)", () => {
  const keyset = {
    keystring: "fake-etsy-keystring-0123456789",
    sharedSecret: "fake-etsy-shared-secret-0123456789",
  };

  it("accepts the keystring/sharedSecret pair atomically", () => {
    expect(validateBundle("etsy_keyset", keyset)).toEqual(keyset);
  });

  it("rejects a half-configured pair", () => {
    const { sharedSecret: _dropped, ...keystringOnly } = keyset;
    expect(() => validateBundle("etsy_keyset", keystringOnly)).toThrowError(
      BundleValidationError,
    );
    expect(() =>
      validateBundle("etsy_keyset", { ...keyset, sharedSecret: "" }),
    ).toThrowError(BundleValidationError);
  });

  it("rejects an environment or ruName — Etsy has no sandbox and no redirect-name indirection", () => {
    expect(() =>
      validateBundle("etsy_keyset", { ...keyset, environment: "sandbox" }),
    ).toThrowError(BundleValidationError);
    expect(() =>
      validateBundle("etsy_keyset", { ...keyset, ruName: "not-an-etsy-concept" }),
    ).toThrowError(BundleValidationError);
  });

  it("reports issue paths and codes, never the secret itself", () => {
    try {
      validateBundle("etsy_keyset", { ...keyset, sharedSecret: 42 });
      throw new Error("expected a BundleValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(BundleValidationError);
      const message = (error as Error).message;
      expect(message).toContain("sharedSecret");
      expect(message).not.toContain(keyset.keystring);
    }
  });
});

describe("invoiceninja_credentials bundle (the Invoice Ninja v5 company API token)", () => {
  const FAKE_TOKEN = "fakefakefakefakefakefakefakefakefakefakefakefakefake01";

  it("accepts the single API token", () => {
    expect(validateBundle("invoiceninja_credentials", { apiToken: FAKE_TOKEN })).toEqual(
      { apiToken: FAKE_TOKEN },
    );
  });

  it("rejects an empty token", () => {
    expect(() =>
      validateBundle("invoiceninja_credentials", { apiToken: "" }),
    ).toThrowError(BundleValidationError);
  });

  it("rejects a missing token", () => {
    expect(() => validateBundle("invoiceninja_credentials", {})).toThrowError(
      BundleValidationError,
    );
  });

  it("rejects the instance URL — baseUrl is non-secret connection config", () => {
    expect(() =>
      validateBundle("invoiceninja_credentials", {
        apiToken: FAKE_TOKEN,
        baseUrl: "https://billing.example.invalid",
      }),
    ).toThrowError(BundleValidationError);
  });

  it("reports issue paths and codes, never the secret itself", () => {
    try {
      validateBundle("invoiceninja_credentials", { apiToken: 42 });
      throw new Error("expected a BundleValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(BundleValidationError);
      const message = (error as Error).message;
      expect(message).toContain("apiToken");
      expect(message).not.toContain(FAKE_TOKEN);
    }
  });
});

describe("cloudflare_credentials bundle (the Cloudflare API token)", () => {
  const FAKE_CF_TOKEN = "fake-cloudflare-api-token-000000000000000000";

  it("accepts a lone API token", () => {
    expect(
      validateBundle("cloudflare_credentials", { apiToken: FAKE_CF_TOKEN }),
    ).toEqual({ apiToken: FAKE_CF_TOKEN });
  });

  it("rejects an empty or missing token", () => {
    expect(() => validateBundle("cloudflare_credentials", {})).toThrowError(
      BundleValidationError,
    );
    expect(() =>
      validateBundle("cloudflare_credentials", { apiToken: "" }),
    ).toThrowError(BundleValidationError);
  });

  it("rejects the LEGACY global-key pair, which Loxep deliberately never accepts", () => {
    // The global API key carries every permission on the account and cannot be
    // scoped. A control plane that edits DNS has no business holding one, so
    // the bundle has no shape that could store it.
    expect(() =>
      validateBundle("cloudflare_credentials", {
        email: "operator@example.invalid",
        apiKey: FAKE_CF_TOKEN,
      }),
    ).toThrowError(BundleValidationError);
  });

  it("rejects the account id — non-secret identity belongs on the connection", () => {
    // Same rule `woo_credentials` applies to a store URL and
    // `medusa_credentials` to a backend URL: the account identifier must stay
    // readable without a decryption round-trip.
    expect(() =>
      validateBundle("cloudflare_credentials", {
        apiToken: FAKE_CF_TOKEN,
        accountId: "acct_1",
      }),
    ).toThrowError(BundleValidationError);
  });

  it("reports issue paths and codes, never the secret itself", () => {
    try {
      validateBundle("cloudflare_credentials", { apiToken: 42 });
      throw new Error("expected a BundleValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(BundleValidationError);
      const message = (error as Error).message;
      expect(message).toContain("apiToken");
      expect(message).not.toContain(FAKE_CF_TOKEN);
    }
  });
});

describe("purelymail_credentials bundle (the Purelymail API token)", () => {
  const FAKE_PM_TOKEN = "fake-purelymail-api-token-00000000000000000";

  it("accepts a lone API token", () => {
    expect(
      validateBundle("purelymail_credentials", { apiToken: FAKE_PM_TOKEN }),
    ).toEqual({ apiToken: FAKE_PM_TOKEN });
  });

  it("rejects an empty or missing token", () => {
    expect(() => validateBundle("purelymail_credentials", {})).toThrowError(
      BundleValidationError,
    );
    expect(() =>
      validateBundle("purelymail_credentials", { apiToken: "" }),
    ).toThrowError(BundleValidationError);
  });

  it("rejects a base URL — non-secret configuration belongs on the connection", () => {
    expect(() =>
      validateBundle("purelymail_credentials", {
        apiToken: FAKE_PM_TOKEN,
        baseUrl: "https://purelymail.com",
      }),
    ).toThrowError(BundleValidationError);
  });

  it("reports issue paths and codes, never the secret itself", () => {
    try {
      validateBundle("purelymail_credentials", { apiToken: 42 });
      throw new Error("expected a BundleValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(BundleValidationError);
      const message = (error as Error).message;
      expect(message).toContain("apiToken");
      expect(message).not.toContain(FAKE_PM_TOKEN);
    }
  });
});

describe("mailbox_password bundle (a credential Loxep MINTS)", () => {
  const FAKE_PASSWORD = "fake-minted-mailbox-password-0000000000";

  it("accepts a lone password", () => {
    expect(
      validateBundle("mailbox_password", { password: FAKE_PASSWORD }),
    ).toEqual({ password: FAKE_PASSWORD });
  });

  it("rejects an empty or missing password", () => {
    expect(() => validateBundle("mailbox_password", {})).toThrowError(
      BundleValidationError,
    );
    expect(() =>
      validateBundle("mailbox_password", { password: "" }),
    ).toThrowError(BundleValidationError);
  });

  it("carries no address, mailbox id, or provider identity", () => {
    // The bundle is the SECRET and nothing else. Identity lives on the
    // `mailboxes` row and in the secret key `infrastructure.mailbox.<id>`;
    // duplicating it inside the ciphertext would mean two places to keep
    // consistent and one of them undiscoverable without decryption.
    expect(() =>
      validateBundle("mailbox_password", {
        password: FAKE_PASSWORD,
        address: "postmaster@example.test",
      }),
    ).toThrowError(BundleValidationError);
  });

  it("is a SEPARATE purpose from smtp_password, which Loxep consumes", () => {
    // Same shape, deliberately not shared: `smtp_password` is a credential
    // Loxep USES to send mail through someone else's server, and a future
    // operator-reveal exception for minted secrets must not widen to it by
    // accident.
    expect(secretPurposes).toContain("mailbox_password");
    expect(secretPurposes).toContain("smtp_password");
  });

  it("reports issue paths and codes, never the secret itself", () => {
    try {
      validateBundle("mailbox_password", { password: 42 });
      throw new Error("expected a BundleValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(BundleValidationError);
      const message = (error as Error).message;
      expect(message).toContain("password");
      expect(message).not.toContain(FAKE_PASSWORD);
    }
  });
});
