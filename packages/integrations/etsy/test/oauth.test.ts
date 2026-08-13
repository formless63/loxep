import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildConsentState,
  buildConsentUrl,
  bundleFromCredential,
  consentScopesForTier,
  consentTierForScopes,
  credentialWriteForBundle,
  DEFAULT_ETSY_CONSENT_TIER,
  ETSY_AUTHORIZE_URL,
  ETSY_ORDER_SCOPES,
  ETSY_SHOP_SCOPES,
  ETSY_TOKEN_URL,
  EtsyAdapterError,
  exchangeConsentCode,
  generatePkcePair,
  isEtsyConsentTier,
  refreshTokenBundleIfNeeded,
  refreshUserToken,
  validateEtsyRedirectUri,
  verifyConsentState,
} from "../src/index.ts";
import { createFetchStub, rejection, TEST_KEYSTRING, TEST_SHARED_SECRET } from "./http.ts";
import { oauthRefreshResponse, oauthTokenResponse } from "./fixtures.ts";

describe("consent tiers", () => {
  it("resolves 'shop' to shops_r + listings_r, and defaults to it", () => {
    expect(consentScopesForTier("shop")).toEqual([...ETSY_SHOP_SCOPES]);
    expect(DEFAULT_ETSY_CONSENT_TIER).toBe("shop");
  });

  it("resolves 'orders' to shop scopes plus transactions_r", () => {
    expect(consentScopesForTier("orders")).toEqual([...ETSY_ORDER_SCOPES]);
    expect(ETSY_ORDER_SCOPES).toContain("transactions_r");
  });

  it("classifies granted scopes back into a tier, defaulting to the narrow one", () => {
    expect(consentTierForScopes(["shops_r", "listings_r", "transactions_r"])).toBe("orders");
    expect(consentTierForScopes(["shops_r", "listings_r"])).toBe("shop");
    expect(consentTierForScopes(null)).toBe("shop");
    expect(consentTierForScopes(undefined)).toBe("shop");
  });

  it("isEtsyConsentTier narrows untrusted input", () => {
    expect(isEtsyConsentTier("shop")).toBe(true);
    expect(isEtsyConsentTier("orders")).toBe(true);
    expect(isEtsyConsentTier("listing_write")).toBe(false);
    expect(isEtsyConsentTier(42)).toBe(false);
  });
});

describe("generatePkcePair", () => {
  it("derives code_challenge as base64url(sha256(code_verifier)), no padding", () => {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const expected = createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
    expect(codeChallenge).toBe(expected);
    expect(codeChallenge).not.toContain("=");
  });

  it("produces a verifier within RFC 7636's 43-128 character bound", () => {
    const { codeVerifier } = generatePkcePair();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates a fresh pair every call", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe("validateEtsyRedirectUri", () => {
  it("accepts https:", () => {
    expect(validateEtsyRedirectUri("https://loxep.example.com/api/integrations/etsy/callback")).toBe(
      "https://loxep.example.com/api/integrations/etsy/callback",
    );
  });

  it("accepts the documented http://127.0.0.1 loopback exception", () => {
    expect(validateEtsyRedirectUri("http://127.0.0.1:3020/api/integrations/etsy/callback")).toBe(
      "http://127.0.0.1:3020/api/integrations/etsy/callback",
    );
  });

  it("rejects http: against any other host", () => {
    expect(() =>
      validateEtsyRedirectUri("http://loxep.example.com/api/integrations/etsy/callback"),
    ).toThrowError(EtsyAdapterError);
    expect(() => validateEtsyRedirectUri("http://localhost:3020/callback")).toThrowError(
      EtsyAdapterError,
    );
  });

  it("rejects a malformed URL", () => {
    expect(() => validateEtsyRedirectUri("not-a-url")).toThrowError(EtsyAdapterError);
  });
});

describe("buildConsentUrl", () => {
  const base = {
    keystring: TEST_KEYSTRING,
    redirectUri: "https://loxep.example.com/api/integrations/etsy/callback",
    state: "abc.def",
    scopes: ["shops_r", "listings_r"],
    codeChallenge: "fake-challenge",
  };

  it("builds the authorize URL with every required PKCE parameter", () => {
    const consent = buildConsentUrl(base);
    const url = new URL(consent.url);
    expect(url.origin + url.pathname).toBe(ETSY_AUTHORIZE_URL);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(TEST_KEYSTRING);
    expect(url.searchParams.get("redirect_uri")).toBe(base.redirectUri);
    expect(url.searchParams.get("scope")).toBe("shops_r listings_r");
    expect(url.searchParams.get("state")).toBe("abc.def");
    expect(url.searchParams.get("code_challenge")).toBe("fake-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(consent.scopes).toEqual(["shops_r", "listings_r"]);
  });

  it("rejects an empty keystring, state, or scope list", () => {
    expect(() => buildConsentUrl({ ...base, keystring: "" })).toThrowError(EtsyAdapterError);
    expect(() => buildConsentUrl({ ...base, state: "" })).toThrowError(EtsyAdapterError);
    expect(() => buildConsentUrl({ ...base, scopes: [] })).toThrowError(EtsyAdapterError);
  });

  it("rejects an insecure redirect URI (propagates validateEtsyRedirectUri)", () => {
    expect(() =>
      buildConsentUrl({ ...base, redirectUri: "http://not-loopback.example.com/cb" }),
    ).toThrowError(EtsyAdapterError);
  });
});

describe("consent state (CSRF binding)", () => {
  it("round-trips: build then verify recovers the connection id", () => {
    const built = buildConsentState("11111111-1111-1111-1111-111111111111");
    const verified = verifyConsentState(built.state, built.nonce);
    expect(verified.connectionId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("rejects a tampered state, a wrong nonce, or a missing nonce", () => {
    const built = buildConsentState("11111111-1111-1111-1111-111111111111");
    expect(() => verifyConsentState(built.state, "wrong-nonce")).toThrowError(EtsyAdapterError);
    expect(() => verifyConsentState(built.state, undefined)).toThrowError(EtsyAdapterError);
    expect(() =>
      verifyConsentState(built.state.slice(0, -1) + "x", built.nonce),
    ).toThrowError(EtsyAdapterError);
  });

  it("rejects a connectionId containing '.'", () => {
    expect(() => buildConsentState("has.a.dot")).toThrowError(EtsyAdapterError);
  });
});

describe("exchangeConsentCode", () => {
  it("POSTs the authorization_code grant and returns a parsed bundle", async () => {
    const stub = createFetchStub([{ status: 200, body: oauthTokenResponse }]);
    const bundle = await exchangeConsentCode({
      keystring: TEST_KEYSTRING,
      sharedSecret: TEST_SHARED_SECRET,
      code: "the-auth-code",
      codeVerifier: "the-code-verifier",
      redirectUri: "https://loxep.example.com/api/integrations/etsy/callback",
      scopes: ["shops_r", "listings_r"],
      fetchImpl: stub.impl,
    });
    expect(bundle.etsyUserId).toBe("111222333");
    expect(bundle.accessToken).toBe("aVeryOpaqueEtsyAccessTokenValue");

    const call = stub.calls[0]!;
    expect(call.url).toBe(ETSY_TOKEN_URL);
    expect(call.method).toBe("POST");
    expect(call.headers["x-api-key"]).toBe(`${TEST_KEYSTRING}:${TEST_SHARED_SECRET}`);
    const body = new URLSearchParams(call.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-auth-code");
    expect(body.get("code_verifier")).toBe("the-code-verifier");
  });

  it("rejects an empty authorization code before any network call", async () => {
    const stub = createFetchStub([]);
    await expect(
      exchangeConsentCode({
        keystring: TEST_KEYSTRING,
        sharedSecret: TEST_SHARED_SECRET,
        code: "",
        codeVerifier: "v",
        redirectUri: "https://loxep.example.com/cb",
        scopes: ["shops_r"],
        fetchImpl: stub.impl,
      }),
    ).rejects.toThrowError(EtsyAdapterError);
    expect(stub.calls).toHaveLength(0);
  });

  it("surfaces an Etsy error envelope as a taxonomy-classified error", async () => {
    const stub = createFetchStub([{ status: 400, body: { error: "invalid_grant" } }]);
    const error = await rejection(
      exchangeConsentCode({
        keystring: TEST_KEYSTRING,
        sharedSecret: TEST_SHARED_SECRET,
        code: "bad-code",
        codeVerifier: "v",
        redirectUri: "https://loxep.example.com/cb",
        scopes: ["shops_r"],
        fetchImpl: stub.impl,
      }),
    );
    expect(error.kind).toBe("invalid_request");
    expect(error.detail["providerMessage"]).toBe("invalid_grant");
  });
});

describe("refreshUserToken", () => {
  it("POSTs the refresh_token grant and carries the refresh token forward if omitted", async () => {
    const stub = createFetchStub([
      {
        status: 200,
        body: { access_token: oauthRefreshResponse.access_token, expires_in: 3600 },
      },
    ]);
    const bundle = await refreshUserToken({
      keystring: TEST_KEYSTRING,
      sharedSecret: TEST_SHARED_SECRET,
      refreshToken: "the-refresh-token",
      scopes: ["shops_r"],
      fetchImpl: stub.impl,
    });
    expect(bundle.refreshToken).toBe("the-refresh-token");
    const call = stub.calls[0]!;
    expect(new URLSearchParams(call.body as string).get("grant_type")).toBe("refresh_token");
  });

  it("rejects an empty refresh token", async () => {
    const stub = createFetchStub([]);
    await expect(
      refreshUserToken({
        keystring: TEST_KEYSTRING,
        sharedSecret: TEST_SHARED_SECRET,
        refreshToken: "",
        scopes: ["shops_r"],
        fetchImpl: stub.impl,
      }),
    ).rejects.toThrowError(EtsyAdapterError);
  });
});

describe("refreshTokenBundleIfNeeded", () => {
  const freshBundle = {
    etsyUserId: "111",
    accessToken: "a",
    refreshToken: "r",
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshTokenExpiresAt: null,
    scopes: ["shops_r"],
  };

  it("returns the bundle unchanged when nowhere near expiry", async () => {
    const result = await refreshTokenBundleIfNeeded({
      bundle: freshBundle,
      keystring: TEST_KEYSTRING,
      sharedSecret: TEST_SHARED_SECRET,
    });
    expect(result.refreshed).toBe(false);
    expect(result.bundle).toBe(freshBundle);
  });

  it("refreshes when inside the skew window", async () => {
    const stub = createFetchStub([{ status: 200, body: oauthRefreshResponse }]);
    const aboutToExpire = {
      ...freshBundle,
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const result = await refreshTokenBundleIfNeeded({
      bundle: aboutToExpire,
      keystring: TEST_KEYSTRING,
      sharedSecret: TEST_SHARED_SECRET,
      fetchImpl: stub.impl,
    });
    expect(result.refreshed).toBe(true);
    expect(stub.calls).toHaveLength(1);
  });

  it("throws auth when the refresh token itself has expired", async () => {
    const dead = {
      ...freshBundle,
      accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    await expect(
      refreshTokenBundleIfNeeded({
        bundle: dead,
        keystring: TEST_KEYSTRING,
        sharedSecret: TEST_SHARED_SECRET,
      }),
    ).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("credentialWriteForBundle / bundleFromCredential", () => {
  const bundle = {
    etsyUserId: "111222333",
    accessToken: "opaque",
    refreshToken: "refresh",
    accessTokenExpiresAt: "2026-08-13T01:00:00.000Z",
    refreshTokenExpiresAt: "2027-01-01T00:00:00.000Z",
    scopes: ["shops_r", "listings_r"],
  };

  it("splits secret payload from non-secret connectionConfig", () => {
    const write = credentialWriteForBundle(bundle);
    expect(write.credentialType).toBe("oauth_tokens");
    expect(write.payload).toEqual({ accessToken: "opaque", refreshToken: "refresh" });
    expect(write.connectionConfig).toEqual({
      etsyUserId: "111222333",
      scopes: ["shops_r", "listings_r"],
      refreshTokenExpiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect(write.refreshAfter.getTime()).toBeLessThan(write.expiresAt.getTime());
  });

  it("round-trips through bundleFromCredential", () => {
    const write = credentialWriteForBundle(bundle);
    const rebuilt = bundleFromCredential({
      payload: write.payload,
      expiresAt: write.expiresAt,
      etsyUserId: write.connectionConfig.etsyUserId,
      scopes: write.connectionConfig.scopes,
      refreshTokenExpiresAt: write.connectionConfig.refreshTokenExpiresAt,
    });
    expect(rebuilt.accessToken).toBe(bundle.accessToken);
    expect(rebuilt.etsyUserId).toBe(bundle.etsyUserId);
    expect(rebuilt.scopes).toEqual(bundle.scopes);
  });

  it("throws auth when the stored credential has no refresh token", () => {
    expect(() =>
      bundleFromCredential({
        payload: { accessToken: "a" },
        expiresAt: new Date(),
        etsyUserId: "111",
      }),
    ).toThrowError(EtsyAdapterError);
  });

  it("throws invalid_request when etsyUserId is missing/blank", () => {
    expect(() =>
      bundleFromCredential({
        payload: { accessToken: "a", refreshToken: "r" },
        expiresAt: new Date(),
        etsyUserId: "",
      }),
    ).toThrowError(EtsyAdapterError);
  });
});
