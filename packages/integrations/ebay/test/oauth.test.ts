/**
 * OAuth consent + token lifecycle unit tests (loxep-62y.1.2). Pure: no
 * network. The one provider seam that is stubbed is the library's
 * `OAuth2.getToken`, reached through the boundary-internal adapter handle.
 *
 * ABSOLUTE RULE honored here: every credential/token value in this file is
 * fake, and leak checks are programmatic containment comparisons.
 */
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { adapterInternals } from "../src/adapter.ts";
import type { EbayAdapter, EbayUserAdapter } from "../src/adapter.ts";
import {
  DEFAULT_EBAY_CONSENT_TIER,
  DEFAULT_REFRESH_SKEW_SECONDS,
  EBAY_BASE_SCOPE,
  EBAY_CONSENT_TIER_SCOPES,
  EBAY_DEFAULT_CONSENT_SCOPES,
  EBAY_ORDER_CONSENT_SCOPES,
  EBAY_SELL_FULFILLMENT_READONLY_SCOPE,
  EbayAdapterError,
  accessTokenNeedsRefresh,
  buildConsentState,
  buildConsentUrl,
  bundleFromCredential,
  bundleFromProviderToken,
  consentScopesForTier,
  consentTierForScopes,
  credentialWriteForBundle,
  createEbayAdapter,
  createRateBudget,
  exchangeConsentCode,
  isEbayConsentTier,
  parseEbayUserTokenBundle,
  providerTokenFromBundle,
  refreshTokenBundleIfNeeded,
  refreshTokenExpired,
  refreshUserToken,
  tokenRefreshAfter,
  verifyConsentState,
} from "../src/index.ts";
import type { EbayUserTokenBundle } from "../src/index.ts";

// FAKE values only — never real keyset or token material.
const FAKE = {
  appId: "FakeApp-fakefake-SBX-0123456789ab-cdef0123",
  certId: "SBX-fakefakefake-abcd-1234-5678-9abc",
  devId: "01234567-89ab-cdef-0123-456789abcdef",
  ruName: "Fake_Loxep-FakeApp-fakefa-abcdefghi",
  environment: "sandbox",
} as const;

const FAKE_ACCESS_TOKEN = "v^1.1#i^1#FAKE-ACCESS-TOKEN-0000";
const FAKE_REFRESH_TOKEN = "v^1.1#i^1#FAKE-REFRESH-TOKEN-0000";

function makeAdapter(overrides: Partial<typeof FAKE> = {}): EbayAdapter {
  return createEbayAdapter({
    ...FAKE,
    ...overrides,
    rateBudget: createRateBudget({ capacity: 50, refillPerSecond: 50 }),
  });
}

function bundle(
  overrides: Partial<EbayUserTokenBundle> = {},
): EbayUserTokenBundle {
  return {
    accessToken: FAKE_ACCESS_TOKEN,
    refreshToken: FAKE_REFRESH_TOKEN,
    accessTokenExpiresAt: new Date("2026-08-11T12:00:00.000Z").toISOString(),
    refreshTokenExpiresAt: new Date("2028-01-01T00:00:00.000Z").toISOString(),
    scopes: [EBAY_BASE_SCOPE],
    ...overrides,
  };
}

describe("buildConsentUrl", () => {
  it("builds the sandbox authorize URL with RuName, scopes, and state", () => {
    const adapter = makeAdapter();
    const { url, scopes, state } = buildConsentUrl(adapter, {
      state: "opaque-state-value",
    });
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe(
      "https://auth.sandbox.ebay.com/oauth2/authorize",
    );
    expect(parsed.searchParams.get("client_id")).toBe(FAKE.appId);
    // redirect_uri is the RuName, NOT the callback URL — eBay resolves it.
    expect(parsed.searchParams.get("redirect_uri")).toBe(FAKE.ruName);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("state")).toBe("opaque-state-value");
    expect(parsed.searchParams.get("scope")).toBe(EBAY_BASE_SCOPE);
    expect(scopes).toEqual([EBAY_BASE_SCOPE]);
    expect(state).toBe("opaque-state-value");
    // No network, so no rate-budget spend.
    expect(adapter.stats().rateBudget.acquired).toBe(0);
  });

  it("passes custom scopes through space-separated", () => {
    const extra = "https://api.ebay.com/oauth/api_scope/buy.order.readonly";
    const { url, scopes } = buildConsentUrl(makeAdapter(), {
      state: "s",
      scopes: [EBAY_BASE_SCOPE, extra],
    });
    expect(new URL(url).searchParams.get("scope")).toBe(
      `${EBAY_BASE_SCOPE} ${extra}`,
    );
    expect(scopes).toEqual([EBAY_BASE_SCOPE, extra]);
  });

  it("uses the production authorize host outside sandbox", () => {
    const adapter = createEbayAdapter({ ...FAKE, environment: "production" });
    const { url } = buildConsentUrl(adapter, { state: "s" });
    expect(new URL(url).origin).toBe("https://auth.ebay.com");
  });

  it("refuses without a RuName, without a state, and with empty scopes", () => {
    const noRuName = createEbayAdapter({
      appId: FAKE.appId,
      certId: FAKE.certId,
      devId: FAKE.devId,
      environment: "sandbox",
    });
    expect(() => buildConsentUrl(noRuName, { state: "s" })).toThrowError(
      EbayAdapterError,
    );
    expect(() => buildConsentUrl(makeAdapter(), { state: "" })).toThrowError(
      EbayAdapterError,
    );
    expect(() =>
      buildConsentUrl(makeAdapter(), { state: "s", scopes: [] }),
    ).toThrowError(EbayAdapterError);
  });

  it("rejects values that are not adapters", () => {
    expect(() =>
      buildConsentUrl({} as unknown as EbayAdapter, { state: "s" }),
    ).toThrowError(EbayAdapterError);
  });
});

describe("consent tiers (loxep-ld0)", () => {
  it("resolves each tier to its documented scope set", () => {
    expect(consentScopesForTier("watchlist")).toEqual([
      ...EBAY_DEFAULT_CONSENT_SCOPES,
    ]);
    expect(consentScopesForTier("orders")).toEqual([
      ...EBAY_ORDER_CONSENT_SCOPES,
    ]);
    // The narrow tier is the default: it is the one every keyset can grant.
    expect(DEFAULT_EBAY_CONSENT_TIER).toBe("watchlist");
    expect(consentScopesForTier(DEFAULT_EBAY_CONSENT_TIER)).toEqual([
      EBAY_BASE_SCOPE,
    ]);
  });

  it("returns a fresh mutable copy, so a caller cannot edit the constants", () => {
    const scopes = consentScopesForTier("orders");
    scopes.push("https://api.ebay.com/oauth/api_scope/sell.account");
    expect(consentScopesForTier("orders")).toEqual([
      ...EBAY_ORDER_CONSENT_SCOPES,
    ]);
    expect(EBAY_CONSENT_TIER_SCOPES.orders).toEqual(EBAY_ORDER_CONSENT_SCOPES);
  });

  it("every tier includes the base scope", () => {
    for (const tier of ["watchlist", "orders"] as const) {
      expect(consentScopesForTier(tier)).toContain(EBAY_BASE_SCOPE);
    }
  });

  it("classifies granted scopes back into a tier, conservatively", () => {
    expect(consentTierForScopes([EBAY_BASE_SCOPE])).toBe("watchlist");
    expect(consentTierForScopes([...EBAY_ORDER_CONSENT_SCOPES])).toBe("orders");
    // Order-independent, and only the fulfillment scope counts.
    expect(
      consentTierForScopes([
        EBAY_SELL_FULFILLMENT_READONLY_SCOPE,
        EBAY_BASE_SCOPE,
      ]),
    ).toBe("orders");
    expect(
      consentTierForScopes([
        EBAY_BASE_SCOPE,
        "https://api.ebay.com/oauth/api_scope/buy.order.readonly",
      ]),
    ).toBe("watchlist");
    // Missing/unreadable values read as the narrow tier, never as orders.
    expect(consentTierForScopes(null)).toBe("watchlist");
    expect(consentTierForScopes(undefined)).toBe("watchlist");
    expect(consentTierForScopes([])).toBe("watchlist");
  });

  it("round-trips every tier through scopes", () => {
    for (const tier of ["watchlist", "orders"] as const) {
      expect(consentTierForScopes(consentScopesForTier(tier))).toBe(tier);
    }
  });

  it("narrows untrusted tier input", () => {
    expect(isEbayConsentTier("watchlist")).toBe(true);
    expect(isEbayConsentTier("orders")).toBe(true);
    for (const value of [
      "ORDERS",
      "",
      "sell.fulfillment",
      null,
      undefined,
      0,
      {},
      ["orders"],
    ]) {
      expect(isEbayConsentTier(value)).toBe(false);
    }
  });

  it("builds a consent URL carrying exactly the selected tier's scopes", () => {
    const consent = buildConsentUrl(makeAdapter(), {
      state: "s",
      scopes: consentScopesForTier("orders"),
    });
    expect(new URL(consent.url).searchParams.get("scope")).toBe(
      EBAY_ORDER_CONSENT_SCOPES.join(" "),
    );
    expect(consent.scopes).toEqual([...EBAY_ORDER_CONSENT_SCOPES]);

    const narrow = buildConsentUrl(makeAdapter(), {
      state: "s",
      scopes: consentScopesForTier("watchlist"),
    });
    expect(new URL(narrow.url).searchParams.get("scope")).toBe(EBAY_BASE_SCOPE);
  });

  it("carries the tier's scopes onto the exchanged bundle, which is what persistence records", async () => {
    const adapter = makeAdapter();
    vi.spyOn(
      adapterInternals(adapter).client.OAuth2,
      "getToken",
    ).mockResolvedValue({
      access_token: FAKE_ACCESS_TOKEN,
      expires_in: 7200,
      refresh_token: FAKE_REFRESH_TOKEN,
      refresh_token_expires_in: 47_304_000,
      token_type: "User Access Token",
    } as never);

    const exchanged = await exchangeConsentCode(adapter, {
      code: "fake-authorization-code",
      scopes: consentScopesForTier("orders"),
    });
    expect(exchanged.scopes).toEqual([...EBAY_ORDER_CONSENT_SCOPES]);
    // The scopes the callback writes to connections.config.ebayOAuth.
    expect(credentialWriteForBundle(exchanged).connectionConfig.scopes).toEqual([
      ...EBAY_ORDER_CONSENT_SCOPES,
    ]);
    expect(consentTierForScopes(exchanged.scopes)).toBe("orders");
  });

  it("defaults an exchange with no scopes to the narrow tier (the pre-tier behaviour)", async () => {
    const adapter = makeAdapter();
    vi.spyOn(
      adapterInternals(adapter).client.OAuth2,
      "getToken",
    ).mockResolvedValue({
      access_token: FAKE_ACCESS_TOKEN,
      expires_in: 7200,
      refresh_token: FAKE_REFRESH_TOKEN,
      refresh_token_expires_in: 47_304_000,
      token_type: "User Access Token",
    } as never);

    const exchanged = await exchangeConsentCode(adapter, {
      code: "fake-authorization-code",
    });
    expect(exchanged.scopes).toEqual([...EBAY_DEFAULT_CONSENT_SCOPES]);
    expect(consentTierForScopes(exchanged.scopes)).toBe(
      DEFAULT_EBAY_CONSENT_TIER,
    );
  });
});

describe("consent state (CSRF binding)", () => {
  it("binds a connection id to a nonce whose hash — not value — is public", () => {
    const connectionId = "0d1f7f3a-2b4c-4d5e-8f90-112233445566";
    const state = buildConsentState(connectionId);

    expect(state.state.endsWith(`.${connectionId}`)).toBe(true);
    // The nonce itself must never appear in the URL-bound state.
    expect(state.state).not.toContain(state.nonce);
    expect(state.nonce.length).toBeGreaterThanOrEqual(43);
    expect(verifyConsentState(state.state, state.nonce)).toEqual({
      connectionId,
    });
  });

  it("produces a fresh nonce per attempt", () => {
    const a = buildConsentState("conn-a");
    const b = buildConsentState("conn-a");
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.state).not.toBe(b.state);
  });

  it("rejects a wrong nonce, a tampered state, and missing halves", () => {
    const state = buildConsentState("conn-1");
    const other = buildConsentState("conn-1");
    const cases: Array<[string | undefined | null, string | undefined | null]> =
      [
        [state.state, other.nonce],
        [state.state, undefined],
        [state.state, ""],
        [undefined, state.nonce],
        ["", state.nonce],
        ["no-separator", state.nonce],
        [`.${"conn-1"}`, state.nonce],
        [`${state.state.split(".")[0]}.`, state.nonce],
        [`x${state.state}`, state.nonce],
      ];
    for (const [presented, nonce] of cases) {
      expect(() => verifyConsentState(presented, nonce)).toThrowError(
        EbayAdapterError,
      );
    }
  });

  it("rejects a state whose connection id was swapped", () => {
    const state = buildConsentState("conn-1");
    const swapped = `${state.state.split(".")[0]}.conn-2`;
    // The binding hashes the connection id with the nonce, so retargeting a
    // consent at another connection invalidates the state.
    expect(() => verifyConsentState(swapped, state.nonce)).toThrowError(
      EbayAdapterError,
    );
  });

  it("refuses to build state for an id containing the separator", () => {
    expect(() => buildConsentState("bad.id")).toThrowError(EbayAdapterError);
    expect(() => buildConsentState("")).toThrowError(EbayAdapterError);
  });
});

describe("token bundle mapping", () => {
  const now = new Date("2026-08-11T10:00:00.000Z");

  it("maps an authorization-code response to absolute ISO expiries", () => {
    const mapped = bundleFromProviderToken(
      {
        access_token: FAKE_ACCESS_TOKEN,
        expires_in: 7200,
        refresh_token: FAKE_REFRESH_TOKEN,
        refresh_token_expires_in: 47304000,
        token_type: "User Access Token",
      },
      { now, scopes: [EBAY_BASE_SCOPE] },
    );
    expect(mapped).toEqual({
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: FAKE_REFRESH_TOKEN,
      accessTokenExpiresAt: "2026-08-11T12:00:00.000Z",
      // 47_304_000 s ≈ 18 months, eBay's documented refresh-token lifetime.
      refreshTokenExpiresAt: "2028-02-09T22:00:00.000Z",
      scopes: [EBAY_BASE_SCOPE],
    });
  });

  it("carries the refresh token and its expiry forward on a refresh response", () => {
    const previous = bundle();
    const mapped = bundleFromProviderToken(
      { access_token: "NEW-FAKE-ACCESS", expires_in: 7200 },
      { now, scopes: previous.scopes, previous },
    );
    expect(mapped.accessToken).toBe("NEW-FAKE-ACCESS");
    expect(mapped.refreshToken).toBe(previous.refreshToken);
    expect(mapped.refreshTokenExpiresAt).toBe(previous.refreshTokenExpiresAt);
  });

  it("falls back to a bounded lifetime when expires_in is missing", () => {
    const mapped = bundleFromProviderToken(
      { access_token: "A", refresh_token: "R" },
      { now, scopes: [EBAY_BASE_SCOPE] },
    );
    expect(mapped.accessTokenExpiresAt).toBe("2026-08-11T12:00:00.000Z");
  });

  it("refuses a response without an access token or any refresh token", () => {
    expect(() =>
      bundleFromProviderToken({ expires_in: 10 }, { now, scopes: ["s"] }),
    ).toThrowError(EbayAdapterError);
    expect(() =>
      bundleFromProviderToken(
        { access_token: "A", expires_in: 10 },
        { now, scopes: ["s"] },
      ),
    ).toThrowError(EbayAdapterError);
  });

  it("round-trips into the provider shape with a remaining lifetime", () => {
    const token = providerTokenFromBundle(bundle(), now);
    expect(token.access_token).toBe(FAKE_ACCESS_TOKEN);
    expect(token.refresh_token).toBe(FAKE_REFRESH_TOKEN);
    expect(token.expires_in).toBe(7200);
    expect(token.token_type).toBe("User Access Token");
  });

  it("never reports a negative remaining lifetime for an expired bundle", () => {
    const token = providerTokenFromBundle(
      bundle({ accessTokenExpiresAt: "2020-01-01T00:00:00.000Z" }),
      now,
    );
    expect(token.expires_in).toBe(0);
  });

  it("validates untrusted bundles by path/code without echoing values", () => {
    expect(parseEbayUserTokenBundle(bundle())).toEqual(bundle());
    try {
      parseEbayUserTokenBundle({
        ...bundle(),
        accessTokenExpiresAt: "not-a-date",
        extra: FAKE_REFRESH_TOKEN,
      });
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EbayAdapterError);
      const serialized = inspect(error, { depth: 8 });
      expect(serialized).not.toContain(FAKE_REFRESH_TOKEN);
      expect(serialized).not.toContain(FAKE_ACCESS_TOKEN);
    }
  });
});

describe("exchangeConsentCode", () => {
  it("exchanges the code through the library and maps the bundle", async () => {
    const adapter = makeAdapter();
    const internals = adapterInternals(adapter);
    const getToken = vi.fn(async (code: string) => {
      expect(code).toBe("fake-authorization-code");
      return {
        access_token: FAKE_ACCESS_TOKEN,
        expires_in: 7200,
        refresh_token: FAKE_REFRESH_TOKEN,
        refresh_token_expires_in: 47304000,
        token_type: "User Access Token",
      };
    });
    internals.client.OAuth2.getToken =
      getToken as unknown as typeof internals.client.OAuth2.getToken;

    const result = await exchangeConsentCode(adapter, {
      code: "fake-authorization-code",
    });
    expect(result.accessToken).toBe(FAKE_ACCESS_TOKEN);
    expect(result.refreshToken).toBe(FAKE_REFRESH_TOKEN);
    expect(result.scopes).toEqual([EBAY_BASE_SCOPE]);
    expect(Date.parse(result.accessTokenExpiresAt)).toBeGreaterThan(Date.now());
    // The exchange is a network call and must spend rate budget.
    expect(adapter.stats().rateBudget.acquired).toBe(1);
  });

  it("normalizes an eBay grant failure to auth without leaking the code", async () => {
    const adapter = makeAdapter();
    const internals = adapterInternals(adapter);
    internals.client.OAuth2.getToken = (async () => {
      throw Object.assign(new Error("Request failed with status code 400"), {
        isAxiosError: true,
        config: { auth: { username: FAKE.appId, password: FAKE.certId } },
        response: {
          status: 400,
          headers: { authorization: FAKE.certId },
          data: {
            error: "invalid_grant",
            error_description: "the provided authorization grant code is invalid",
          },
        },
      });
    }) as unknown as typeof internals.client.OAuth2.getToken;

    const error = await exchangeConsentCode(adapter, { code: "bad" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EbayAdapterError);
    expect((error as EbayAdapterError).kind).toBe("auth");
    const serialized = inspect(error, { depth: 12 });
    expect(serialized).not.toContain(FAKE.certId);
    expect(serialized).not.toContain(FAKE.appId);
  });

  it("refuses an empty code", async () => {
    await expect(
      exchangeConsentCode(makeAdapter(), { code: "" }),
    ).rejects.toThrowError(EbayAdapterError);
  });
});

// ---------------------------------------------------------------------------
// Refresh lifecycle — the network step is the user adapter's, so these tests
// substitute a structural adapter whose withUserToken returns a stub.
// ---------------------------------------------------------------------------

function stubAdapter(
  refreshed: EbayUserTokenBundle,
): { adapter: EbayAdapter; calls: EbayUserTokenBundle[] } {
  const calls: EbayUserTokenBundle[] = [];
  const adapter = {
    environment: "sandbox",
    marketplaceId: "EBAY_US",
    withUserToken(given: EbayUserTokenBundle): EbayUserAdapter {
      calls.push(given);
      return {
        async refreshUserToken() {
          return refreshed;
        },
      } as unknown as EbayUserAdapter;
    },
  } as unknown as EbayAdapter;
  return { adapter, calls };
}

describe("refreshUserToken", () => {
  it("refreshes through a user-context adapter carrying scopes forward", async () => {
    const next = bundle({ accessToken: "NEW-FAKE-ACCESS" });
    const { adapter, calls } = stubAdapter(next);
    const result = await refreshUserToken(adapter, {
      refreshToken: FAKE_REFRESH_TOKEN,
      scopes: [EBAY_BASE_SCOPE],
      refreshTokenExpiresAt: "2028-01-01T00:00:00.000Z",
    });
    expect(result).toBe(next);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.refreshToken).toBe(FAKE_REFRESH_TOKEN);
    expect(calls[0]?.scopes).toEqual([EBAY_BASE_SCOPE]);
    expect(calls[0]?.refreshTokenExpiresAt).toBe("2028-01-01T00:00:00.000Z");
  });

  it("refuses an empty refresh token before touching the adapter", async () => {
    const { adapter, calls } = stubAdapter(bundle());
    await expect(
      refreshUserToken(adapter, { refreshToken: "" }),
    ).rejects.toThrowError(EbayAdapterError);
    expect(calls).toHaveLength(0);
  });
});

describe("refreshTokenBundleIfNeeded", () => {
  const now = new Date("2026-08-11T10:00:00.000Z");

  it("leaves a token that is comfortably valid alone", async () => {
    const { adapter, calls } = stubAdapter(bundle());
    const current = bundle({
      accessTokenExpiresAt: "2026-08-11T11:00:00.000Z",
    });
    const result = await refreshTokenBundleIfNeeded({
      bundle: current,
      adapter,
      now,
    });
    expect(result).toEqual({ bundle: current, refreshed: false });
    expect(calls).toHaveLength(0);
  });

  it("refreshes inside the skew window", async () => {
    const next = bundle({ accessToken: "NEW-FAKE-ACCESS" });
    const { adapter, calls } = stubAdapter(next);
    const current = bundle({
      // 4 minutes left — inside the 5-minute default skew.
      accessTokenExpiresAt: "2026-08-11T10:04:00.000Z",
    });
    const result = await refreshTokenBundleIfNeeded({
      bundle: current,
      adapter,
      now,
    });
    expect(result).toEqual({ bundle: next, refreshed: true });
    expect(calls).toHaveLength(1);
  });

  it("honors a custom skew in both directions", async () => {
    const current = bundle({
      accessTokenExpiresAt: "2026-08-11T10:04:00.000Z",
    });
    const tight = stubAdapter(bundle());
    expect(
      (
        await refreshTokenBundleIfNeeded({
          bundle: current,
          adapter: tight.adapter,
          now,
          refreshSkewSeconds: 60,
        })
      ).refreshed,
    ).toBe(false);

    const wide = stubAdapter(bundle());
    expect(
      (
        await refreshTokenBundleIfNeeded({
          bundle: current,
          adapter: wide.adapter,
          now,
          refreshSkewSeconds: 3600,
        })
      ).refreshed,
    ).toBe(true);
  });

  it("refreshes an already-expired access token", async () => {
    const { adapter, calls } = stubAdapter(bundle());
    await refreshTokenBundleIfNeeded({
      bundle: bundle({ accessTokenExpiresAt: "2026-08-11T09:00:00.000Z" }),
      adapter,
      now,
    });
    expect(calls).toHaveLength(1);
  });

  it("raises auth (never retries) when the refresh token itself is dead", async () => {
    const { adapter, calls } = stubAdapter(bundle());
    const error = await refreshTokenBundleIfNeeded({
      bundle: bundle({
        accessTokenExpiresAt: "2026-08-11T09:00:00.000Z",
        refreshTokenExpiresAt: "2026-08-01T00:00:00.000Z",
      }),
      adapter,
      now,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EbayAdapterError);
    expect((error as EbayAdapterError).kind).toBe("auth");
    expect(calls).toHaveLength(0);
  });

  it("treats an unknown refresh-token expiry as still usable", async () => {
    const { adapter, calls } = stubAdapter(bundle());
    await refreshTokenBundleIfNeeded({
      bundle: bundle({
        accessTokenExpiresAt: "2026-08-11T09:00:00.000Z",
        refreshTokenExpiresAt: null,
      }),
      adapter,
      now,
    });
    expect(calls).toHaveLength(1);
  });
});

describe("skew helpers", () => {
  const now = new Date("2026-08-11T10:00:00.000Z");

  it("accessTokenNeedsRefresh brackets the window exactly", () => {
    const current = bundle({ accessTokenExpiresAt: "2026-08-11T10:05:00.000Z" });
    expect(accessTokenNeedsRefresh(current, now, 299)).toBe(false);
    expect(accessTokenNeedsRefresh(current, now, 300)).toBe(true);
  });

  it("refreshTokenExpired is false for an unknown expiry", () => {
    expect(refreshTokenExpired(bundle({ refreshTokenExpiresAt: null }), now)).toBe(
      false,
    );
    expect(
      refreshTokenExpired(
        bundle({ refreshTokenExpiresAt: "2026-08-11T09:59:59.000Z" }),
        now,
      ),
    ).toBe(true);
  });

  it("tokenRefreshAfter maps onto the credential refresh_after column", () => {
    expect(
      tokenRefreshAfter(
        bundle({ accessTokenExpiresAt: "2026-08-11T12:00:00.000Z" }),
      ).toISOString(),
    ).toBe("2026-08-11T11:55:00.000Z");
    expect(DEFAULT_REFRESH_SKEW_SECONDS).toBe(300);
  });
});

describe("persistence mapping", () => {
  it("splits the bundle into encrypted credential and non-secret config", () => {
    const current = bundle({
      accessTokenExpiresAt: "2026-08-11T12:00:00.000Z",
    });
    const write = credentialWriteForBundle(current);
    expect(write.credentialType).toBe("oauth_tokens");
    expect(write.payload).toEqual({
      accessToken: current.accessToken,
      refreshToken: current.refreshToken,
    });
    expect(write.expiresAt.toISOString()).toBe("2026-08-11T12:00:00.000Z");
    expect(write.refreshAfter.toISOString()).toBe("2026-08-11T11:55:00.000Z");
    // Scopes/refresh expiry are metadata, never inside the ciphertext.
    expect(write.connectionConfig).toEqual({
      scopes: current.scopes,
      refreshTokenExpiresAt: current.refreshTokenExpiresAt,
    });
    expect(Object.keys(write.payload)).toEqual(["accessToken", "refreshToken"]);
  });

  it("honors a custom refresh skew", () => {
    const write = credentialWriteForBundle(
      bundle({ accessTokenExpiresAt: "2026-08-11T12:00:00.000Z" }),
      { refreshSkewSeconds: 60 },
    );
    expect(write.refreshAfter.toISOString()).toBe("2026-08-11T11:59:00.000Z");
  });

  it("round-trips through the storage shape", () => {
    const current = bundle();
    const write = credentialWriteForBundle(current);
    expect(
      bundleFromCredential({
        payload: write.payload,
        expiresAt: write.expiresAt,
        scopes: write.connectionConfig.scopes,
        refreshTokenExpiresAt: write.connectionConfig.refreshTokenExpiresAt,
      }),
    ).toEqual(current);
  });

  it("raises auth for a stored credential without a refresh token", () => {
    const error = ((): unknown => {
      try {
        return bundleFromCredential({
          payload: { accessToken: FAKE_ACCESS_TOKEN },
          expiresAt: new Date(),
        });
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(EbayAdapterError);
    expect((error as EbayAdapterError).kind).toBe("auth");
  });

  it("raises invalid_request when the stored expiry is missing", () => {
    expect(() =>
      bundleFromCredential({
        payload: { accessToken: "A", refreshToken: "R" },
        expiresAt: null,
      }),
    ).toThrowError(EbayAdapterError);
  });

  it("defaults scopes to the base consent scope when none were recorded", () => {
    expect(
      bundleFromCredential({
        payload: { accessToken: "A", refreshToken: "R" },
        expiresAt: "2026-08-11T12:00:00.000Z",
      }).scopes,
    ).toEqual([EBAY_BASE_SCOPE]);
  });
});
