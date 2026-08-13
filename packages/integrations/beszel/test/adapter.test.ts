/**
 * Unit tests for the Beszel read adapter. Every test injects a deterministic
 * `fetch` stub; nothing here touches the network.
 */
import { describe, expect, it } from "vitest";
import {
  BESZEL_AUTH_PATH,
  BESZEL_HEALTH_PATH,
  BESZEL_SYSTEMS_PATH,
  BeszelAdapterError,
  beszelSourceAccountKey,
  createBeszelAdapter,
  createRateBudget,
  normalizeBeszelBaseUrl,
  parseBeszelAdapterConfig,
} from "../src/index.ts";
import {
  TEST_BASE_URL,
  TEST_EMAIL,
  TEST_PASSWORD,
  TEST_TOKEN,
  authOk,
  createFetchStub,
  fail,
  page,
  systemRecord,
} from "./http.ts";

function adapterWith(responses: Parameters<typeof createFetchStub>[0]) {
  const stub = createFetchStub(responses);
  const adapter = createBeszelAdapter({
    config: { baseUrl: TEST_BASE_URL },
    credentials: { email: TEST_EMAIL, password: TEST_PASSWORD },
    fetchImpl: stub.impl,
    // A generous budget so no unit test waits on a refill.
    rateBudget: createRateBudget({ capacity: 100, refillPerSecond: 1000 }),
  });
  return { adapter, stub };
}

describe("base URL normalization", () => {
  it("strips a trailing slash so paths never double up", () => {
    expect(normalizeBeszelBaseUrl("https://hub.example.com/")).toBe(
      "https://hub.example.com",
    );
    expect(normalizeBeszelBaseUrl("https://hub.example.com/beszel/")).toBe(
      "https://hub.example.com/beszel",
    );
  });

  it("keeps an explicit port, which self-hosted hubs always have", () => {
    expect(normalizeBeszelBaseUrl("http://localhost:8090")).toBe(
      "http://localhost:8090",
    );
  });

  it("refuses userinfo — that would put a password in connections.config", () => {
    expect(() =>
      normalizeBeszelBaseUrl("https://user:secret@hub.example.com"),
    ).toThrowError(BeszelAdapterError);
  });

  it("refuses a non-http scheme, a query string, and a fragment", () => {
    for (const bad of [
      "ftp://hub.example.com",
      "https://hub.example.com?x=1",
      "https://hub.example.com#frag",
      "not-a-url",
    ]) {
      expect(() => normalizeBeszelBaseUrl(bad)).toThrowError(
        BeszelAdapterError,
      );
    }
  });

  it("parses config and applies the default timeout", () => {
    expect(parseBeszelAdapterConfig({ baseUrl: TEST_BASE_URL })).toEqual({
      baseUrl: TEST_BASE_URL,
      timeoutMs: 15_000,
    });
  });
});

describe("source account key", () => {
  it("separates two readonly users on the same hub", () => {
    expect(beszelSourceAccountKey(TEST_BASE_URL, "a@example.com")).not.toBe(
      beszelSourceAccountKey(TEST_BASE_URL, "b@example.com"),
    );
  });

  it("is case- and slash-insensitive, so one account is one key", () => {
    expect(beszelSourceAccountKey(`${TEST_BASE_URL}/`, "Ops@Example.com")).toBe(
      beszelSourceAccountKey(TEST_BASE_URL, "ops@example.com"),
    );
  });
});

describe("health(): the unauthenticated tier-2 probe", () => {
  it("reads PocketBase's health body and sends no credential at all", async () => {
    const { adapter, stub } = adapterWith([
      { status: 200, body: { status: 200, message: "API is healthy." } },
    ]);

    await expect(adapter.health()).resolves.toEqual({
      reachable: true,
      httpStatus: 200,
      message: "API is healthy.",
    });

    expect(stub.pathOf(0)).toBe(BESZEL_HEALTH_PATH);
    expect(stub.calls[0]?.method).toBe("GET");
    // The whole point of tier 2: reachability with no credential.
    expect(stub.calls[0]?.headers["authorization"]).toBeUndefined();
    expect(stub.calls).toHaveLength(1);
  });

  it("classifies an unreachable hub as provider_unavailable", async () => {
    const { adapter } = adapterWith([fail(502, "Bad Gateway")]);
    await expect(adapter.health()).rejects.toMatchObject({
      kind: "provider_unavailable",
    });
  });
});

describe("listSystems(): the read that makes this a tier-3 adapter", () => {
  it("logs in against the users collection, then reads with the token", async () => {
    const { adapter, stub } = adapterWith([
      authOk(),
      page([systemRecord()]),
    ]);

    const systems = await adapter.listSystems();
    expect(systems).toEqual([
      {
        externalSystemId: "sys_aaaaaaaaaaaaaaa",
        name: "web-01",
        host: "10.0.0.11",
        port: 45_876,
        status: "up",
        observedAt: "2026-08-13 07:00:00.000Z",
        sharedWithCount: 1,
      },
    ]);

    // The correction this package exists for: the ORDINARY users collection.
    expect(stub.pathOf(0)).toBe(BESZEL_AUTH_PATH);
    expect(stub.pathOf(0)).toContain("/collections/users/");
    expect(stub.pathOf(0)).not.toContain("_superusers");
    expect(stub.calls[0]?.method).toBe("POST");
    // PocketBase names the login field `identity`, not `email`.
    expect(stub.bodyOf(0)).toEqual({
      identity: TEST_EMAIL,
      password: TEST_PASSWORD,
    });

    expect(stub.pathOf(1)).toBe(BESZEL_SYSTEMS_PATH);
    expect(stub.calls[1]?.method).toBe("GET");
    // PocketBase documents the bare token, with no `Bearer` prefix.
    expect(stub.calls[1]?.headers["authorization"]).toBe(TEST_TOKEN);
  });

  it("sends PocketBase paging parameters", async () => {
    const { adapter, stub } = adapterWith([authOk(), page([systemRecord()])]);
    await adapter.listSystems();
    expect(stub.queryOf(1)).toEqual({ page: "1", perPage: "200" });
  });

  it("passes a filter through verbatim when one is supplied", async () => {
    const { adapter, stub } = adapterWith([authOk(), page([])]);
    await adapter.listSystems({ filter: 'status = "up"' });
    expect(stub.queryOf(1)["filter"]).toBe('status = "up"');
  });

  it("follows totalPages and stops at the last page", async () => {
    const { adapter, stub } = adapterWith([
      authOk(),
      page([systemRecord({ id: "sys_1" })], { page: 1, totalPages: 2 }),
      page([systemRecord({ id: "sys_2" })], { page: 2, totalPages: 2 }),
    ]);
    const systems = await adapter.listSystems();
    expect(systems.map((s) => s.externalSystemId)).toEqual(["sys_1", "sys_2"]);
    expect(stub.queryOf(2)["page"]).toBe("2");
    expect(stub.calls).toHaveLength(3);
  });

  it("reuses the cached token across calls — one login, not one per read", async () => {
    const { adapter, stub } = adapterWith([
      authOk(),
      page([systemRecord()]),
      page([systemRecord()]),
    ]);
    await adapter.listSystems();
    await adapter.listSystems();
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(adapter.stats().authExchanges).toBe(1);
  });

  it("re-authenticates exactly once when the hub rejects a stale token", async () => {
    const { adapter, stub } = adapterWith([
      authOk("first-token"),
      fail(401, "The request requires valid record authorization token."),
      authOk("second-token"),
      page([systemRecord()]),
    ]);

    const systems = await adapter.listSystems();
    expect(systems).toHaveLength(1);
    expect(adapter.stats().reauthRetries).toBe(1);
    expect(adapter.stats().authExchanges).toBe(2);
    expect(stub.calls[3]?.headers["authorization"]).toBe("second-token");
  });

  it("gives up after one re-authentication rather than looping on a dead account", async () => {
    const { adapter, stub } = adapterWith([
      authOk(),
      fail(401, "unauthorized"),
      authOk(),
      fail(401, "unauthorized"),
    ]);
    await expect(adapter.listSystems()).rejects.toMatchObject({ kind: "auth" });
    expect(stub.calls).toHaveLength(4);
  });

  it("returns an empty list for a readonly user with nothing shared with it", async () => {
    // Upstream: a readonly user "can view any system shared with them by an
    // admin". Nothing shared is a legitimate, non-error state.
    const { adapter } = adapterWith([authOk(), page([])]);
    await expect(adapter.listSystems()).resolves.toEqual([]);
  });
});

describe("record shapes change in minor releases, and that is designed for", () => {
  it("degrades every undocumented field to null rather than failing", async () => {
    const { adapter } = adapterWith([
      authOk(),
      // Only `id` is guaranteed by PocketBase. Everything else may vanish.
      page([{ id: "sys_bare" }]),
    ]);
    await expect(adapter.listSystems()).resolves.toEqual([
      {
        externalSystemId: "sys_bare",
        name: null,
        host: null,
        port: null,
        status: "",
        observedAt: null,
        sharedWithCount: 0,
      },
    ]);
  });

  it("skips one unreadable record instead of losing the whole fleet", async () => {
    const { adapter } = adapterWith([
      authOk(),
      page([systemRecord({ id: "sys_good" }), { noIdAtAll: true }]),
    ]);
    const systems = await adapter.listSystems();
    expect(systems.map((s) => s.externalSystemId)).toEqual(["sys_good"]);
  });

  it("keeps an unknown status string verbatim rather than mapping it", async () => {
    const { adapter } = adapterWith([
      authOk(),
      page([systemRecord({ status: "some-future-state" })]),
    ]);
    const systems = await adapter.listSystems();
    expect(systems[0]?.status).toBe("some-future-state");
  });

  it("accepts a numeric port as well as a string one", async () => {
    const { adapter } = adapterWith([
      authOk(),
      page([systemRecord({ port: 45876 })]),
    ]);
    expect((await adapter.listSystems())[0]?.port).toBe(45_876);
  });

  it("rejects a body that is not a PocketBase list envelope", async () => {
    const { adapter } = adapterWith([
      authOk(),
      { status: 200, body: { unexpected: true } },
    ]);
    await expect(adapter.listSystems()).rejects.toMatchObject({
      kind: "invalid_request",
    });
  });
});

describe("error taxonomy", () => {
  it("maps PocketBase statuses onto the five Loxep kinds", async () => {
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
      // Health is the unauthenticated path, so one response settles one case.
      const { adapter } = adapterWith([fail(status, "nope")]);
      await expect(adapter.health()).rejects.toMatchObject({ kind });
    }
  });

  it("treats a non-JSON body as provider_unavailable, not a refusal", async () => {
    const { adapter } = adapterWith([
      { status: 200, text: "<html>nginx</html>" },
    ]);
    await expect(adapter.health()).rejects.toMatchObject({
      kind: "provider_unavailable",
      detail: { providerBodyShape: "not-a-pocketbase-envelope" },
    });
  });

  it("records a status/envelope mismatch, because a proxy rewrote one of them", async () => {
    const { adapter } = adapterWith([
      { status: 502, body: { status: 404, message: "Missing." } },
    ]);
    await expect(adapter.health()).rejects.toMatchObject({
      kind: "provider_unavailable",
      detail: { envelopeStatusMismatch: 404 },
    });
  });
});

describe("capabilities", () => {
  it("states read-only structurally and denies metric history", () => {
    const { adapter } = adapterWith([]);
    expect(adapter.capabilities()).toEqual({
      provider: "beszel",
      readOnly: true,
      unauthenticatedHealthProbe: true,
      metricHistory: false,
      stableRecordShapes: false,
    });
  });
});

describe("rate budget", () => {
  it("refuses rather than queueing forever when the budget is exhausted", async () => {
    const stub = createFetchStub([authOk(), page([])]);
    const adapter = createBeszelAdapter({
      config: { baseUrl: TEST_BASE_URL },
      credentials: { email: TEST_EMAIL, password: TEST_PASSWORD },
      fetchImpl: stub.impl,
      rateBudget: createRateBudget({
        capacity: 1,
        refillPerSecond: 0.001,
        maxWaitMs: 5,
      }),
    });
    await expect(adapter.listSystems()).rejects.toMatchObject({
      kind: "rate_limited",
      detail: { source: "local_rate_budget" },
    });
  });

  it("reports budget stats alongside the auth counters", async () => {
    const { adapter } = adapterWith([authOk(), page([])]);
    await adapter.listSystems();
    const stats = adapter.stats();
    expect(stats.rateBudget.acquired).toBe(2);
    expect(stats.authExchanges).toBe(1);
    expect(stats.reauthRetries).toBe(0);
  });
});

describe("construction", () => {
  it("refuses an empty half of the credential pair", () => {
    const stub = createFetchStub([]);
    expect(() =>
      createBeszelAdapter({
        config: { baseUrl: TEST_BASE_URL },
        credentials: { email: TEST_EMAIL, password: "" },
        fetchImpl: stub.impl,
      }),
    ).toThrowError(BeszelAdapterError);
  });
});
