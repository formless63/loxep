/**
 * Unit tests for the Tailscale read adapter. Every test injects a
 * deterministic `fetch` stub; nothing here touches the network.
 */
import { describe, expect, it } from "vitest";
import {
  TAILSCALE_DEFAULT_TAILNET,
  TailscaleAdapterError,
  createRateBudget,
  createTailscaleAdapter,
  normalizeTailscaleBaseUrl,
  parseTailscaleAdapterConfig,
  tailscaleDevicesPath,
  tailscaleSourceAccountKey,
} from "../src/index.ts";
import {
  TEST_API_ACCESS_TOKEN,
  TEST_BASE_URL,
  TEST_OAUTH_ACCESS_TOKEN,
  TEST_OAUTH_CLIENT_ID,
  TEST_OAUTH_CLIENT_SECRET,
  TEST_TAILNET,
  createFetchStub,
  devicesPage,
  deviceRecord,
  fail,
  oauthTokenOk,
} from "./http.ts";

function tokenAdapterWith(responses: Parameters<typeof createFetchStub>[0]) {
  const stub = createFetchStub(responses);
  const adapter = createTailscaleAdapter({
    config: { tailnet: TEST_TAILNET, baseUrl: TEST_BASE_URL },
    credentials: { mode: "api_access_token", apiAccessToken: TEST_API_ACCESS_TOKEN },
    fetchImpl: stub.impl,
    rateBudget: createRateBudget({ capacity: 100, refillPerSecond: 1000 }),
  });
  return { adapter, stub };
}

function oauthAdapterWith(responses: Parameters<typeof createFetchStub>[0]) {
  const stub = createFetchStub(responses);
  const adapter = createTailscaleAdapter({
    config: { tailnet: TEST_TAILNET, baseUrl: TEST_BASE_URL },
    credentials: {
      mode: "oauth_client",
      clientId: TEST_OAUTH_CLIENT_ID,
      clientSecret: TEST_OAUTH_CLIENT_SECRET,
    },
    fetchImpl: stub.impl,
    rateBudget: createRateBudget({ capacity: 100, refillPerSecond: 1000 }),
  });
  return { adapter, stub };
}

describe("base URL and config normalization", () => {
  it("strips a trailing slash", () => {
    expect(normalizeTailscaleBaseUrl("https://api.tailscale.com/")).toBe(
      "https://api.tailscale.com",
    );
  });

  it("refuses userinfo, a non-https scheme, a query string, and a fragment", () => {
    for (const bad of [
      "http://api.tailscale.com",
      "https://user:pass@api.tailscale.com",
      "https://api.tailscale.com?x=1",
      "https://api.tailscale.com#frag",
      "not-a-url",
    ]) {
      expect(() => normalizeTailscaleBaseUrl(bad)).toThrowError(
        TailscaleAdapterError,
      );
    }
  });

  it("defaults the tailnet to the '-' shorthand and applies the SaaS base URL", () => {
    const config = parseTailscaleAdapterConfig({});
    expect(config.tailnet).toBe(TAILSCALE_DEFAULT_TAILNET);
    expect(config.baseUrl).toBe("https://api.tailscale.com");
    expect(config.timeoutMs).toBe(15_000);
  });
});

describe("source account key", () => {
  it("separates two tailnets on the same base URL", () => {
    expect(tailscaleSourceAccountKey(TEST_BASE_URL, "a.example.com")).not.toBe(
      tailscaleSourceAccountKey(TEST_BASE_URL, "b.example.com"),
    );
  });

  it("is case- and slash-insensitive, so one tailnet is one key", () => {
    expect(tailscaleSourceAccountKey(`${TEST_BASE_URL}/`, "Example.Com")).toBe(
      tailscaleSourceAccountKey(TEST_BASE_URL, "example.com"),
    );
  });
});

describe("listDevices(): api_access_token mode", () => {
  it("sends HTTP Basic auth with the token as username and empty password", async () => {
    const { adapter, stub } = tokenAdapterWith([devicesPage([deviceRecord()])]);
    await adapter.listDevices();
    const expected = `Basic ${Buffer.from(`${TEST_API_ACCESS_TOKEN}:`).toString("base64")}`;
    expect(stub.calls[0]?.headers["authorization"]).toBe(expected);
    expect(stub.calls[0]?.method).toBe("GET");
    expect(stub.pathOf(0)).toBe(tailscaleDevicesPath(TEST_TAILNET));
  });

  it("maps a device record to Loxep's fact shape", async () => {
    const { adapter } = tokenAdapterWith([devicesPage([deviceRecord()])]);
    const devices = await adapter.listDevices();
    expect(devices).toEqual([
      {
        externalDeviceId: "n123456CNTRL",
        name: "web-01.tailnet-name.ts.net",
        hostname: "web-01",
        addresses: ["100.64.0.1"],
        online: true,
        lastSeen: null,
        os: "linux",
        authorized: true,
      },
    ]);
  });

  it("reports lastSeen only when the device is not currently connected", async () => {
    const { adapter } = tokenAdapterWith([
      devicesPage([
        deviceRecord({
          connectedToControl: false,
          lastSeen: "2026-08-01T00:00:00Z",
        }),
      ]),
    ]);
    const devices = await adapter.listDevices();
    expect(devices[0]?.online).toBe(false);
    expect(devices[0]?.lastSeen).toBe("2026-08-01T00:00:00Z");
  });

  it("prefers nodeId over id, but falls back to id when nodeId is absent", async () => {
    const { adapter } = tokenAdapterWith([
      devicesPage([deviceRecord({ nodeId: undefined, id: "legacy-id" })]),
    ]);
    const devices = await adapter.listDevices();
    expect(devices[0]?.externalDeviceId).toBe("legacy-id");
  });

  it("accepts a bare array as well as the {devices:[...]} wrapper", async () => {
    const { adapter } = tokenAdapterWith([{ status: 200, body: [deviceRecord()] }]);
    await expect(adapter.listDevices()).resolves.toHaveLength(1);
  });

  it("never re-exchanges anything on an auth failure — a static token cannot be fixed by retrying", async () => {
    const { adapter, stub } = tokenAdapterWith([fail(401, "unauthorized")]);
    await expect(adapter.listDevices()).rejects.toMatchObject({ kind: "auth" });
    expect(stub.calls).toHaveLength(1);
  });

  it("degrades a record missing every optional field to nulls, keeping only the id", async () => {
    const { adapter } = tokenAdapterWith([devicesPage([{ id: "bare-only" }])]);
    const devices = await adapter.listDevices();
    expect(devices).toEqual([
      {
        externalDeviceId: "bare-only",
        name: null,
        hostname: null,
        addresses: [],
        online: false,
        lastSeen: null,
        os: null,
        authorized: null,
      },
    ]);
  });

  it("skips one unreadable record instead of losing the whole tailnet", async () => {
    const { adapter } = tokenAdapterWith([
      devicesPage([deviceRecord({ id: "good", nodeId: "good" }), { addresses: "not-an-array" }]),
    ]);
    const devices = await adapter.listDevices();
    expect(devices.map((d) => d.externalDeviceId)).toEqual(["good"]);
  });
});

describe("listDevices(): oauth_client mode", () => {
  it("exchanges client credentials, then sends a bearer token", async () => {
    const { adapter, stub } = oauthAdapterWith([
      oauthTokenOk(),
      devicesPage([deviceRecord()]),
    ]);
    await adapter.listDevices();

    expect(stub.calls[0]?.method).toBe("POST");
    expect(stub.calls[0]?.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const params = new URLSearchParams(stub.calls[0]?.body ?? "");
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe(TEST_OAUTH_CLIENT_ID);
    expect(params.get("client_secret")).toBe(TEST_OAUTH_CLIENT_SECRET);

    expect(stub.calls[1]?.headers["authorization"]).toBe(
      `Bearer ${TEST_OAUTH_ACCESS_TOKEN}`,
    );
  });

  it("reuses the cached access token across calls", async () => {
    const { adapter, stub } = oauthAdapterWith([
      oauthTokenOk(),
      devicesPage([]),
      devicesPage([]),
    ]);
    await adapter.listDevices();
    await adapter.listDevices();
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(adapter.stats().oauthExchanges).toBe(1);
  });

  it("re-exchanges exactly once when the API rejects the cached access token", async () => {
    const { adapter, stub } = oauthAdapterWith([
      oauthTokenOk("first-token"),
      fail(401, "token expired"),
      oauthTokenOk("second-token"),
      devicesPage([]),
    ]);
    await adapter.listDevices();
    expect(adapter.stats().reauthRetries).toBe(1);
    expect(adapter.stats().oauthExchanges).toBe(2);
    expect(stub.calls[3]?.headers["authorization"]).toBe("Bearer second-token");
  });

  it("gives up after one re-exchange rather than looping", async () => {
    const { adapter, stub } = oauthAdapterWith([
      oauthTokenOk(),
      fail(401, "nope"),
      oauthTokenOk(),
      fail(401, "nope"),
    ]);
    await expect(adapter.listDevices()).rejects.toMatchObject({ kind: "auth" });
    expect(stub.calls).toHaveLength(4);
  });
});

describe("probe(): the whoami-equivalent", () => {
  it("reports reachable and authenticated on a normal read", async () => {
    const { adapter } = tokenAdapterWith([devicesPage([deviceRecord(), deviceRecord()])]);
    await expect(adapter.probe()).resolves.toEqual({
      reachable: true,
      authenticated: true,
      deviceCount: 2,
    });
  });

  it("reports reachable but not authenticated on a 401/403, without throwing", async () => {
    const { adapter } = tokenAdapterWith([fail(403, "invalid token")]);
    await expect(adapter.probe()).resolves.toEqual({
      reachable: true,
      authenticated: false,
      deviceCount: null,
    });
  });

  it("still throws for a network-level failure", async () => {
    const { adapter } = tokenAdapterWith([fail(503, "down")]);
    await expect(adapter.probe()).rejects.toMatchObject({
      kind: "provider_unavailable",
    });
  });
});

describe("error taxonomy", () => {
  it("maps statuses onto the five Loxep kinds", async () => {
    const cases: Array<[number, string]> = [
      [400, "invalid_request"],
      [401, "auth"],
      [403, "auth"],
      [404, "not_found"],
      [429, "rate_limited"],
      [500, "provider_unavailable"],
    ];
    for (const [status, kind] of cases) {
      const { adapter } = tokenAdapterWith([fail(status, "nope")]);
      await expect(adapter.listDevices()).rejects.toMatchObject({ kind });
    }
  });

  it("carries the provider's own message but never the credential", async () => {
    const { adapter } = tokenAdapterWith([fail(401, "invalid access token")]);
    const error = await adapter.listDevices().catch((e: unknown) => e);
    const serialized = JSON.stringify({
      message: (error as Error).message,
      detail: (error as { detail: unknown }).detail,
    });
    expect(serialized).toContain("invalid access token");
    expect(serialized).not.toContain(TEST_API_ACCESS_TOKEN);
  });
});

describe("capabilities and construction", () => {
  it("reports the credential mode it was built with", () => {
    const { adapter } = tokenAdapterWith([]);
    expect(adapter.capabilities()).toEqual({
      provider: "tailscale",
      readOnly: true,
      authMode: "api_access_token",
      unauthenticatedHealthProbe: false,
    });
  });

  it("refuses an empty api access token", () => {
    const stub = createFetchStub([]);
    expect(() =>
      createTailscaleAdapter({
        config: { tailnet: TEST_TAILNET, baseUrl: TEST_BASE_URL },
        credentials: { mode: "api_access_token", apiAccessToken: "" },
        fetchImpl: stub.impl,
      }),
    ).toThrowError(TailscaleAdapterError);
  });

  it("refuses an incomplete OAuth client pair", () => {
    const stub = createFetchStub([]);
    expect(() =>
      createTailscaleAdapter({
        config: { tailnet: TEST_TAILNET, baseUrl: TEST_BASE_URL },
        credentials: { mode: "oauth_client", clientId: "id", clientSecret: "" },
        fetchImpl: stub.impl,
      }),
    ).toThrowError(TailscaleAdapterError);
  });
});

describe("rate budget", () => {
  it("refuses rather than queueing forever once the budget is exhausted", async () => {
    const stub = createFetchStub([devicesPage([]), devicesPage([])]);
    const adapter = createTailscaleAdapter({
      config: { tailnet: TEST_TAILNET, baseUrl: TEST_BASE_URL },
      credentials: { mode: "api_access_token", apiAccessToken: TEST_API_ACCESS_TOKEN },
      fetchImpl: stub.impl,
      rateBudget: createRateBudget({ capacity: 1, refillPerSecond: 0.001, maxWaitMs: 5 }),
    });
    // The first read consumes the bucket's single starting token.
    await adapter.listDevices();
    // The second cannot refill within maxWaitMs at this refill rate.
    await expect(adapter.listDevices()).rejects.toMatchObject({
      kind: "rate_limited",
      detail: { source: "local_rate_budget" },
    });
  });
});
