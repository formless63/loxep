/**
 * Unit tests for the Gatus read adapter. Every test injects a deterministic
 * `fetch` stub; nothing here touches the network.
 */
import { describe, expect, it } from "vitest";
import {
  GATUS_CONFIG_PATH,
  GATUS_ENDPOINT_STATUSES_PATH,
  GATUS_HEALTH_PATH,
  GatusAdapterError,
  createGatusAdapter,
  createRateBudget,
  gatusEndpointResponseTimePath,
  gatusEndpointUptimePath,
  gatusSourceAccountKey,
  normalizeGatusBaseUrl,
  parseGatusAdapterConfig,
} from "../src/index.ts";
import {
  TEST_BASE_URL,
  TEST_PASSWORD,
  TEST_USERNAME,
  configProbe,
  createFetchStub,
  endpointStatus,
  endpointStatuses,
  fail,
  health,
  resultEntry,
  responseTimeText,
  uptimeText,
} from "./http.ts";

function adapterWith(
  responses: Parameters<typeof createFetchStub>[0],
  overrides: { credentials?: { username: string; password: string } } = {},
) {
  const stub = createFetchStub(responses);
  const adapter = createGatusAdapter({
    config: { baseUrl: TEST_BASE_URL },
    ...(overrides.credentials === undefined
      ? {}
      : { credentials: overrides.credentials }),
    fetchImpl: stub.impl,
    // A generous budget so no unit test waits on a refill.
    rateBudget: createRateBudget({ capacity: 100, refillPerSecond: 1000 }),
  });
  return { adapter, stub };
}

describe("base URL normalization", () => {
  it("strips a trailing slash so paths never double up", () => {
    expect(normalizeGatusBaseUrl("https://gatus.example.com/")).toBe(
      "https://gatus.example.com",
    );
  });

  it("refuses userinfo — that would put a password in connections.config", () => {
    expect(() =>
      normalizeGatusBaseUrl("https://user:secret@gatus.example.com"),
    ).toThrowError(GatusAdapterError);
  });

  it("refuses a non-http scheme, a query string, and a fragment", () => {
    for (const bad of [
      "ftp://gatus.example.com",
      "https://gatus.example.com?x=1",
      "https://gatus.example.com#frag",
      "not-a-url",
    ]) {
      expect(() => normalizeGatusBaseUrl(bad)).toThrowError(GatusAdapterError);
    }
  });

  it("parses config and applies the default timeout", () => {
    expect(parseGatusAdapterConfig({ baseUrl: TEST_BASE_URL })).toEqual({
      baseUrl: TEST_BASE_URL,
      timeoutMs: 15_000,
    });
  });
});

describe("source account key", () => {
  it("is the normalized base URL alone — no per-account identity to compose with", () => {
    expect(gatusSourceAccountKey(`${TEST_BASE_URL}/`)).toBe(
      gatusSourceAccountKey(TEST_BASE_URL),
    );
  });
});

describe("probeConfig(): the whole auth branch", () => {
  it("reports direct mode when no security block is configured (fully open)", async () => {
    const { adapter, stub } = adapterWith([configProbe(false, true)]);
    await expect(adapter.probeConfig()).resolves.toEqual({
      oidc: false,
      authenticated: true,
      mode: "direct",
    });
    expect(stub.pathOf(0)).toBe(GATUS_CONFIG_PATH);
    // Unauthenticated: no credential sent even when credentials ARE configured.
    expect(stub.calls[0]?.headers["authorization"]).toBeUndefined();
  });

  it("reports direct mode when Basic auth is configured", async () => {
    const { adapter } = adapterWith([configProbe(false, false)]);
    await expect(adapter.probeConfig()).resolves.toEqual({
      oidc: false,
      authenticated: false,
      mode: "direct",
    });
  });

  it("reports oidc_degraded mode when OIDC is configured", async () => {
    const { adapter } = adapterWith([configProbe(true, false)]);
    await expect(adapter.probeConfig()).resolves.toEqual({
      oidc: true,
      authenticated: false,
      mode: "oidc_degraded",
    });
  });

  it("re-probes on every call rather than caching a stale mode", async () => {
    const { adapter, stub } = adapterWith([
      configProbe(false, true),
      configProbe(true, false),
    ]);
    await expect(adapter.probeConfig()).resolves.toMatchObject({ mode: "direct" });
    await expect(adapter.probeConfig()).resolves.toMatchObject({
      mode: "oidc_degraded",
    });
    expect(stub.calls).toHaveLength(2);
  });
});

describe("health(): unauthenticated in every security mode", () => {
  it("reports UP with no credential sent", async () => {
    const { adapter, stub } = adapterWith([health("UP")]);
    await expect(adapter.health()).resolves.toEqual({
      reachable: true,
      status: "UP",
      httpStatus: 200,
    });
    expect(stub.pathOf(0)).toBe(GATUS_HEALTH_PATH);
    expect(stub.calls[0]?.headers["authorization"]).toBeUndefined();
  });

  it("treats a DOWN body (HTTP 500) as a real, reachable health fact", async () => {
    // github.com/TwiN/health maps Down -> HTTP 500 with a real JSON body.
    // A blanket "5xx = provider_unavailable" rule would misclassify this.
    const { adapter } = adapterWith([health("DOWN", "database unreachable")]);
    await expect(adapter.health()).resolves.toEqual({
      reachable: true,
      status: "DOWN",
      httpStatus: 500,
    });
  });

  it("classifies a body that is not JSON at all as provider_unavailable", async () => {
    const { adapter } = adapterWith([{ status: 502, text: "<html>bad gateway</html>" }]);
    await expect(adapter.health()).rejects.toMatchObject({
      kind: "provider_unavailable",
    });
  });
});

describe("listEndpointStatuses(): the direct-mode bulk read", () => {
  it("probes first, then reads with Basic auth attached", async () => {
    const { adapter, stub } = adapterWith(
      [configProbe(false, false), endpointStatuses([endpointStatus()])],
      { credentials: { username: TEST_USERNAME, password: TEST_PASSWORD } },
    );
    const statuses = await adapter.listEndpointStatuses();
    expect(statuses).toEqual([
      {
        key: "core_loxep",
        name: "Loxep",
        group: "core",
        success: true,
        httpStatus: 200,
        observedAt: "2026-08-13T07:00:00Z",
        errorCount: 0,
      },
    ]);
    expect(stub.pathOf(0)).toBe(GATUS_CONFIG_PATH);
    expect(stub.pathOf(1)).toBe(GATUS_ENDPOINT_STATUSES_PATH);
    const expected = `Basic ${Buffer.from(`${TEST_USERNAME}:${TEST_PASSWORD}`).toString("base64")}`;
    expect(stub.calls[1]?.headers["authorization"]).toBe(expected);
  });

  it("sends no Authorization header when no credential is configured (open Gatus)", async () => {
    const { adapter, stub } = adapterWith([
      configProbe(false, true),
      endpointStatuses([]),
    ]);
    await adapter.listEndpointStatuses();
    expect(stub.calls[1]?.headers["authorization"]).toBeUndefined();
  });

  it("passes page/pageSize through when supplied", async () => {
    const { adapter, stub } = adapterWith([
      configProbe(false, true),
      endpointStatuses([]),
    ]);
    await adapter.listEndpointStatuses({ page: 2, pageSize: 25 });
    expect(stub.queryOf(1)).toEqual({ page: "2", pageSize: "25" });
  });

  it("refuses to attempt the call at all in oidc_degraded mode", async () => {
    const { adapter, stub } = adapterWith([configProbe(true, false)]);
    await expect(adapter.listEndpointStatuses()).rejects.toMatchObject({
      kind: "auth",
    });
    // Only the probe — the adapter never even tries the protected route.
    expect(stub.calls).toHaveLength(1);
  });

  it("takes the LATEST result, never the whole history", async () => {
    const { adapter } = adapterWith([
      configProbe(false, true),
      endpointStatuses([
        endpointStatus({
          results: [
            resultEntry({ success: false, timestamp: "2026-08-13T06:00:00Z" }),
            resultEntry({ success: true, timestamp: "2026-08-13T07:00:00Z" }),
          ],
        }),
      ]),
    ]);
    const statuses = await adapter.listEndpointStatuses();
    expect(statuses[0]).toMatchObject({ success: true, observedAt: "2026-08-13T07:00:00Z" });
  });

  it("degrades an endpoint with no results yet to nulls rather than failing", async () => {
    const { adapter } = adapterWith([
      configProbe(false, true),
      endpointStatuses([{ key: "core_bare" }]),
    ]);
    await expect(adapter.listEndpointStatuses()).resolves.toEqual([
      {
        key: "core_bare",
        name: null,
        group: null,
        success: null,
        httpStatus: null,
        observedAt: null,
        errorCount: 0,
      },
    ]);
  });

  it("skips one unreadable status instead of losing the whole fleet", async () => {
    const { adapter } = adapterWith([
      configProbe(false, true),
      endpointStatuses([endpointStatus({ key: "core_good" }), { noKeyAtAll: true }]),
    ]);
    const statuses = await adapter.listEndpointStatuses();
    expect(statuses.map((s) => s.key)).toEqual(["core_good"]);
  });

  it("counts errors rather than inlining their text", async () => {
    const { adapter } = adapterWith([
      configProbe(false, true),
      endpointStatuses([
        endpointStatus({
          results: [
            resultEntry({
              success: false,
              errors: ["connection refused", "timeout"],
            }),
          ],
        }),
      ]),
    ]);
    const statuses = await adapter.listEndpointStatuses();
    expect(statuses[0]?.errorCount).toBe(2);
  });

  it("rejects a body that is not a JSON array", async () => {
    const { adapter } = adapterWith([
      configProbe(false, true),
      { status: 200, body: { unexpected: true } },
    ]);
    await expect(adapter.listEndpointStatuses()).rejects.toMatchObject({
      kind: "invalid_request",
    });
  });
});

describe("endpointUptime()/endpointResponseTime(): always unauthenticated", () => {
  it("reads a bare fraction with no credential sent, in ANY mode", async () => {
    const { adapter, stub } = adapterWith(
      [uptimeText(0.9876)],
      { credentials: { username: TEST_USERNAME, password: TEST_PASSWORD } },
    );
    await expect(adapter.endpointUptime("core_loxep", "24h")).resolves.toEqual({
      key: "core_loxep",
      duration: "24h",
      uptime: 0.9876,
    });
    expect(stub.pathOf(0)).toBe(gatusEndpointUptimePath("core_loxep", "24h"));
    expect(stub.calls[0]?.headers["authorization"]).toBeUndefined();
  });

  it("reads a bare integer millisecond count", async () => {
    const { adapter, stub } = adapterWith([responseTimeText(142)]);
    await expect(
      adapter.endpointResponseTime("core_loxep", "1h"),
    ).resolves.toEqual({ key: "core_loxep", duration: "1h", averageMs: 142 });
    expect(stub.pathOf(0)).toBe(gatusEndpointResponseTimePath("core_loxep", "1h"));
  });

  it("rejects a duration Gatus does not support before ever touching the network", async () => {
    const { adapter, stub } = adapterWith([]);
    await expect(
      adapter.endpointUptime("core_loxep", "3d" as never),
    ).rejects.toMatchObject({ kind: "invalid_request" });
    expect(stub.calls).toHaveLength(0);
  });

  it("classifies an unknown endpoint key as not_found", async () => {
    const { adapter } = adapterWith([fail(404, "endpoint not found")]);
    await expect(
      adapter.endpointUptime("nope_nope", "24h"),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("classifies an unparseable numeric body as invalid_request", async () => {
    const { adapter } = adapterWith([{ status: 200, text: "not-a-number" }]);
    await expect(
      adapter.endpointUptime("core_loxep", "24h"),
    ).rejects.toMatchObject({ kind: "invalid_request" });
  });
});

describe("error taxonomy", () => {
  it("maps Gatus statuses onto the five Loxep kinds", async () => {
    const cases: Array<[number, string]> = [
      [400, "invalid_request"],
      [401, "auth"],
      [403, "auth"],
      [404, "not_found"],
      [429, "rate_limited"],
      [500, "provider_unavailable"],
      [503, "provider_unavailable"],
    ];
    for (const [status, kind] of cases) {
      const { adapter } = adapterWith([fail(status, "nope")]);
      await expect(adapter.probeConfig()).rejects.toMatchObject({ kind });
    }
  });

  it("reads config.go's JSON {\"error\": ...} shape when present", async () => {
    const { adapter } = adapterWith([
      { status: 500, body: { error: "Failed to marshal response: boom" } },
    ]);
    const error = await adapter.probeConfig().catch((e: unknown) => e);
    expect((error as { detail: { providerMessage?: string } }).detail.providerMessage).toBe(
      "Failed to marshal response: boom",
    );
  });

  it("falls back to the raw plain-text body otherwise", async () => {
    const { adapter } = adapterWith([fail(401, "Unauthorized")]);
    const error = await adapter.probeConfig().catch((e: unknown) => e);
    expect((error as { detail: { providerMessage?: string } }).detail.providerMessage).toBe(
      "Unauthorized",
    );
  });
});

describe("capabilities", () => {
  it("reflects direct mode with the bulk read available", async () => {
    const { adapter } = adapterWith([configProbe(false, true)]);
    await expect(adapter.capabilities()).resolves.toEqual({
      provider: "gatus",
      readOnly: true,
      mode: "direct",
      oidc: false,
      unauthenticatedHealthProbe: true,
      perEndpointUptimeAvailable: true,
      endpointStatusesAvailable: true,
      metricHistory: false,
    });
  });

  it("reflects oidc_degraded mode with the bulk read UNAVAILABLE — the UI must say so", async () => {
    const { adapter } = adapterWith([configProbe(true, false)]);
    await expect(adapter.capabilities()).resolves.toMatchObject({
      mode: "oidc_degraded",
      endpointStatusesAvailable: false,
    });
  });
});

describe("rate budget", () => {
  it("refuses rather than queueing forever when the budget is exhausted", async () => {
    const stub = createFetchStub([configProbe(false, true)]);
    const adapter = createGatusAdapter({
      config: { baseUrl: TEST_BASE_URL },
      fetchImpl: stub.impl,
      rateBudget: createRateBudget({
        capacity: 1,
        refillPerSecond: 0.001,
        maxWaitMs: 5,
      }),
    });
    await adapter.probeConfig();
    await expect(adapter.probeConfig()).rejects.toMatchObject({
      kind: "rate_limited",
      detail: { source: "local_rate_budget" },
    });
  });

  it("reports budget stats alongside the probe counter", async () => {
    const { adapter } = adapterWith([configProbe(false, true)]);
    await adapter.probeConfig();
    const stats = adapter.stats();
    expect(stats.rateBudget.acquired).toBe(1);
    expect(stats.configProbes).toBe(1);
  });
});

describe("construction", () => {
  it("allows omitting credentials entirely — a legitimate state for Gatus", () => {
    const stub = createFetchStub([]);
    expect(() =>
      createGatusAdapter({
        config: { baseUrl: TEST_BASE_URL },
        fetchImpl: stub.impl,
      }),
    ).not.toThrow();
  });

  it("refuses an empty half of a supplied credential pair", () => {
    const stub = createFetchStub([]);
    expect(() =>
      createGatusAdapter({
        config: { baseUrl: TEST_BASE_URL },
        credentials: { username: TEST_USERNAME, password: "" },
        fetchImpl: stub.impl,
      }),
    ).toThrowError(GatusAdapterError);
  });
});
