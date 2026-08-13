import { describe, expect, it } from "vitest";
import {
  bundleFromProviderToken,
  EtsyAdapterError,
  parseEtsyUserTokenBundle,
  providerBearerToken,
  splitEtsyAccessToken,
} from "../src/index.ts";
import { oauthRefreshResponse, oauthTokenResponse } from "./fixtures.ts";

describe("splitEtsyAccessToken", () => {
  it("splits the userId prefix from the opaque remainder", () => {
    expect(splitEtsyAccessToken("111222333.opaque-part")).toEqual({
      etsyUserId: "111222333",
      accessToken: "opaque-part",
    });
  });

  it("throws provider_unavailable on a token with no dot, or an empty half", () => {
    expect(() => splitEtsyAccessToken("no-dot-here")).toThrowError(EtsyAdapterError);
    expect(() => splitEtsyAccessToken(".opaque")).toThrowError(EtsyAdapterError);
    expect(() => splitEtsyAccessToken("111222.")).toThrowError(EtsyAdapterError);
  });
});

describe("providerBearerToken", () => {
  it("reassembles the exact original access-token string", () => {
    const bundle = {
      etsyUserId: "111222333",
      accessToken: "opaque-part",
      refreshToken: "r",
      accessTokenExpiresAt: new Date().toISOString(),
      refreshTokenExpiresAt: null,
      scopes: ["shops_r"],
    };
    expect(providerBearerToken(bundle)).toBe("111222333.opaque-part");
  });
});

describe("bundleFromProviderToken", () => {
  const now = new Date("2026-08-13T00:00:00.000Z");

  it("parses a fresh exchange response into a bundle", () => {
    const bundle = bundleFromProviderToken(oauthTokenResponse, {
      now,
      scopes: ["shops_r", "listings_r"],
    });
    expect(bundle.etsyUserId).toBe("111222333");
    expect(bundle.accessToken).toBe("aVeryOpaqueEtsyAccessTokenValue");
    expect(bundle.refreshToken).toBe("aVeryOpaqueEtsyRefreshTokenValue");
    expect(bundle.accessTokenExpiresAt).toBe(
      new Date(now.getTime() + 3600 * 1000).toISOString(),
    );
    expect(bundle.scopes).toEqual(["shops_r", "listings_r"]);
  });

  it("carries the previous refresh token forward when a refresh omits it", () => {
    const bundle = bundleFromProviderToken(
      { access_token: oauthRefreshResponse.access_token, expires_in: 3600 },
      {
        now,
        scopes: ["shops_r"],
        previous: { refreshToken: "carried-forward", refreshTokenExpiresAt: null },
      },
    );
    expect(bundle.refreshToken).toBe("carried-forward");
  });

  it("throws provider_unavailable when access_token is missing", () => {
    expect(() => bundleFromProviderToken({}, { now, scopes: [] })).toThrowError(
      EtsyAdapterError,
    );
  });

  it("throws auth when no refresh token is available at all", () => {
    expect(() =>
      bundleFromProviderToken(
        { access_token: "111.opaque" },
        { now, scopes: [] },
      ),
    ).toThrowError(EtsyAdapterError);
  });
});

describe("parseEtsyUserTokenBundle", () => {
  it("round-trips a valid bundle", () => {
    const bundle = {
      etsyUserId: "111222333",
      accessToken: "a",
      refreshToken: "b",
      accessTokenExpiresAt: "2026-08-13T00:00:00.000Z",
      refreshTokenExpiresAt: null,
      scopes: ["shops_r"],
    };
    expect(parseEtsyUserTokenBundle(bundle)).toEqual(bundle);
  });

  it("rejects a bundle missing etsyUserId", () => {
    expect(() =>
      parseEtsyUserTokenBundle({
        accessToken: "a",
        refreshToken: "b",
        accessTokenExpiresAt: "2026-08-13T00:00:00.000Z",
        refreshTokenExpiresAt: null,
        scopes: ["shops_r"],
      }),
    ).toThrowError(EtsyAdapterError);
  });
});
