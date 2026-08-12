import { describe, expect, it } from "vitest";
import {
  EbayAdapterError,
  createEbayAdapter,
  parseEbayAdapterConfig,
} from "../src/index.ts";

// FAKE values only — never real keyset material.
const FAKE = {
  appId: "FakeApp-fakefake-SBX-0123456789ab-cdef0123",
  certId: "SBX-fakefakefake-abcd-1234-5678-9abc",
  devId: "01234567-89ab-cdef-0123-456789abcdef",
  environment: "sandbox",
} as const;

describe("parseEbayAdapterConfig", () => {
  it("accepts a valid sandbox config and defaults marketplaceId", () => {
    const parsed = parseEbayAdapterConfig({ ...FAKE });
    expect(parsed.environment).toBe("sandbox");
    expect(parsed.marketplaceId).toBe("EBAY_US");
  });

  it("requires environment explicitly", () => {
    expect(() =>
      parseEbayAdapterConfig({
        appId: FAKE.appId,
        certId: FAKE.certId,
        devId: FAKE.devId,
        // @ts-expect-error environment is mandatory
        environment: undefined,
      }),
    ).toThrowError(EbayAdapterError);
  });

  it("rejects unknown environments", () => {
    expect(() =>
      parseEbayAdapterConfig({
        ...FAKE,
        // @ts-expect-error not a valid environment
        environment: "staging",
      }),
    ).toThrowError(EbayAdapterError);
  });

  it("rejects empty credentials and unknown keys, reporting paths without values", () => {
    try {
      parseEbayAdapterConfig({
        ...FAKE,
        appId: "",
        // @ts-expect-error unknown key must be rejected (strict object)
        surprise: true,
      });
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EbayAdapterError);
      const adapterError = error as EbayAdapterError;
      expect(adapterError.kind).toBe("invalid_request");
      const issues = adapterError.detail["issues"] as Array<{
        path: string;
        code: string;
      }>;
      expect(issues.some((issue) => issue.path === "appId")).toBe(true);
      // Issue entries carry only path+code — never received values.
      for (const issue of issues) {
        expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
      }
    }
  });

  it("rejects a malformed marketplaceId", () => {
    expect(() =>
      parseEbayAdapterConfig({ ...FAKE, marketplaceId: "ebay_us" }),
    ).toThrowError(EbayAdapterError);
  });
});

describe("createEbayAdapter", () => {
  it("builds an adapter without touching the network", () => {
    const adapter = createEbayAdapter({ ...FAKE });
    expect(adapter.environment).toBe("sandbox");
    expect(adapter.marketplaceId).toBe("EBAY_US");
    const stats = adapter.stats();
    expect(stats.environment).toBe("sandbox");
    expect(stats.rateBudget.capacity).toBeGreaterThan(0);
    expect(stats.rateBudget.available).toBe(stats.rateBudget.capacity);
  });

  it("propagates config validation failures", () => {
    expect(() =>
      createEbayAdapter({ ...FAKE, certId: "" }),
    ).toThrowError(EbayAdapterError);
  });

  it("exposes no provider client internals on the adapter surface", () => {
    const adapter = createEbayAdapter({ ...FAKE });
    expect(Object.keys(adapter).sort()).toEqual([
      "browseGetItem",
      "browseGetItemByLegacyId",
      "browseSearch",
      "environment",
      "marketplaceId",
      "mintApplicationToken",
      "stats",
      "withUserToken",
    ]);
  });

  it("keeps the user-context adapter free of provider client internals too", () => {
    const adapter = createEbayAdapter({ ...FAKE });
    const userAdapter = adapter.withUserToken({
      accessToken: "FAKE-ACCESS",
      refreshToken: "FAKE-REFRESH",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshTokenExpiresAt: null,
      scopes: ["https://api.ebay.com/oauth/api_scope"],
    });
    expect(Object.keys(userAdapter).sort()).toEqual([
      "browseGetItem",
      "browseGetItemByLegacyId",
      "browseSearch",
      "currentTokenBundle",
      "environment",
      "marketplaceId",
      "refreshUserToken",
      "sellGetOrder",
      "sellGetOrders",
      "sellGetShippingFulfillments",
      "stats",
      "tradingCall",
    ]);
  });
});
