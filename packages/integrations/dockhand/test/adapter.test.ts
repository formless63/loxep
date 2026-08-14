/**
 * Unit tests for the Dockhand adapter. Every test injects a deterministic
 * `fetch` stub; nothing here touches the network.
 */
import { describe, expect, it } from "vitest";
import {
  DOCKHAND_CONTAINERS_PATH,
  DOCKHAND_ENVIRONMENTS_PATH,
  DOCKHAND_LOGIN_PATH,
  DOCKHAND_SESSION_PATH,
  DOCKHAND_STACKS_PATH,
  DockhandAdapterError,
  createDockhandAdapter,
  createRateBudget,
  dockhandSourceAccountKey,
  normalizeDockhandBaseUrl,
  parseDockhandAdapterConfig,
} from "../src/index.ts";
import {
  TEST_BASE_URL,
  TEST_PASSWORD,
  TEST_SESSION,
  TEST_USERNAME,
  bareList,
  containerRecord,
  createFetchStub,
  environmentRecord,
  fail,
  loginOk,
  stackRecord,
  wrappedList,
} from "./http.ts";

function adapterWith(responses: Parameters<typeof createFetchStub>[0]) {
  const stub = createFetchStub(responses);
  const adapter = createDockhandAdapter({
    config: { baseUrl: TEST_BASE_URL },
    credentials: { username: TEST_USERNAME, password: TEST_PASSWORD },
    fetchImpl: stub.impl,
    rateBudget: createRateBudget({ capacity: 100, refillPerSecond: 1000 }),
  });
  return { adapter, stub };
}

describe("base URL normalization", () => {
  it("strips a trailing /api, because operations.ts owns that prefix", () => {
    // Upstream writes its base URL WITH /api. Pasting that must not produce
    // /api/api/environments.
    expect(normalizeDockhandBaseUrl("http://dockhand.local:3000/api")).toBe(
      "http://dockhand.local:3000",
    );
    expect(normalizeDockhandBaseUrl("http://dockhand.local:3000/api/")).toBe(
      "http://dockhand.local:3000",
    );
  });

  it("keeps a genuine sub-path mount", () => {
    expect(normalizeDockhandBaseUrl("https://ops.example.com/dockhand")).toBe(
      "https://ops.example.com/dockhand",
    );
  });

  it("refuses userinfo, a non-http scheme, a query string, and a fragment", () => {
    for (const bad of [
      "https://user:secret@dockhand.local",
      "ftp://dockhand.local",
      "https://dockhand.local?x=1",
      "https://dockhand.local#frag",
      "not-a-url",
    ]) {
      expect(() => normalizeDockhandBaseUrl(bad)).toThrowError(
        DockhandAdapterError,
      );
    }
  });

  it("parses config and applies the default timeout", () => {
    expect(parseDockhandAdapterConfig({ baseUrl: TEST_BASE_URL })).toEqual({
      baseUrl: TEST_BASE_URL,
      timeoutMs: 15_000,
    });
  });
});

describe("source account key", () => {
  it("separates two accounts on one instance, since permissions are per user", () => {
    expect(dockhandSourceAccountKey(TEST_BASE_URL, "reader")).not.toBe(
      dockhandSourceAccountKey(TEST_BASE_URL, "admin"),
    );
  });

  it("is case- and prefix-insensitive, so one account is one key", () => {
    expect(dockhandSourceAccountKey(`${TEST_BASE_URL}/api`, "Loxep")).toBe(
      dockhandSourceAccountKey(TEST_BASE_URL, "loxep"),
    );
  });
});

describe("probeSession(): which auth mode is this instance in", () => {
  it("reports authentication disabled when upstream says so", async () => {
    // Upstream: "Authentication is optional; when disabled, the API is fully
    // accessible without credentials."
    const { adapter, stub } = adapterWith([
      { status: 200, body: { authEnabled: false } },
    ]);
    await expect(adapter.probeSession()).resolves.toEqual({
      authenticationEnabled: false,
      authenticated: false,
    });
    expect(stub.pathOf(0)).toBe(DOCKHAND_SESSION_PATH);
    // Must not log in first — answering this is its whole job.
    expect(stub.calls).toHaveLength(1);
  });

  it("infers an authenticated session from a returned user", async () => {
    const { adapter } = adapterWith([
      { status: 200, body: { authEnabled: true, user: { id: 1 } } },
    ]);
    await expect(adapter.probeSession()).resolves.toEqual({
      authenticationEnabled: true,
      authenticated: true,
    });
  });

  it("assumes authentication is required when the body is unreadable", async () => {
    // Failing safe: an unknown shape must not read as "no credential needed".
    const { adapter } = adapterWith([{ status: 200, body: "nonsense" }]);
    await expect(adapter.probeSession()).resolves.toEqual({
      authenticationEnabled: true,
      authenticated: false,
    });
  });
});

describe("listHosts(): Dockhand calls them environments", () => {
  it("logs in, then reads with the session cookie", async () => {
    const { adapter, stub } = adapterWith([
      loginOk(),
      bareList([environmentRecord()]),
    ]);

    const hosts = await adapter.listHosts();
    expect(hosts).toEqual([
      {
        externalHostId: "1",
        name: "vps-fra-01",
        connectionType: "direct",
        host: "10.0.0.5",
        port: 2376,
        protocol: "https",
        socketPath: "/var/run/docker.sock",
        tlsConfigured: true,
        tlsSkipVerify: false,
        labels: ["prod", "eu"],
        publicIp: "203.0.113.9",
        hawserConfigured: true,
        hawserLastSeen: "2026-08-13T07:00:00.000Z",
        updatedAt: "2026-08-13T07:00:00.000Z",
      },
    ]);

    expect(stub.pathOf(0)).toBe(DOCKHAND_LOGIN_PATH);
    expect(stub.calls[0]?.method).toBe("POST");
    expect(stub.bodyOf(0)).toEqual({
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
    });

    expect(stub.pathOf(1)).toBe(DOCKHAND_ENVIRONMENTS_PATH);
    expect(stub.calls[1]?.method).toBe("GET");
    // Upstream sends the session back as `Cookie: dockhand_session=…` (name OBSERVED live 2026-08-14; it was a transcribed guess before that).
    expect(stub.calls[1]?.headers["cookie"]).toBe(`dockhand_session=${TEST_SESSION}`);
  });

  it("never carries TLS material or a Hawser token into a fact", async () => {
    const { adapter } = adapterWith([loginOk(), bareList([environmentRecord()])]);
    const hosts = await adapter.listHosts();
    const serialized = JSON.stringify(hosts);
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain("zzz-private-key-marker-zzz");
    expect(serialized).not.toContain("zzz-hawser-token-marker-zzz");
    // Only the presence bits survive.
    expect(hosts[0]?.tlsConfigured).toBe(true);
    expect(hosts[0]?.hawserConfigured).toBe(true);
  });

  it("accepts a wrapped list as well as a bare one", async () => {
    // The documentation supports both shapes; see src/errors.ts.
    const { adapter } = adapterWith([
      loginOk(),
      wrappedList("environments", [environmentRecord()]),
    ]);
    await expect(adapter.listHosts()).resolves.toHaveLength(1);
  });

  it("reports tlsConfigured false when no PEM material is present", async () => {
    const { adapter } = adapterWith([
      loginOk(),
      bareList([
        environmentRecord({
          tlsCa: "",
          tlsCert: null,
          tlsKey: "",
          hawserToken: "",
        }),
      ]),
    ]);
    const hosts = await adapter.listHosts();
    expect(hosts[0]?.tlsConfigured).toBe(false);
    expect(hosts[0]?.hawserConfigured).toBe(false);
  });

  it("skips one unreadable environment instead of losing the inventory", async () => {
    const { adapter } = adapterWith([
      loginOk(),
      bareList([environmentRecord({ id: 7 }), { noNameAtAll: true }]),
    ]);
    const hosts = await adapter.listHosts();
    expect(hosts.map((h) => h.externalHostId)).toEqual(["7"]);
  });

  it("rejects a body that is neither an array nor a wrapped array", async () => {
    const { adapter } = adapterWith([loginOk(), { status: 200, body: 42 }]);
    await expect(adapter.listHosts()).rejects.toMatchObject({
      kind: "invalid_request",
    });
  });

  it("exposes readHosts as the reconciler's read half", async () => {
    const { adapter } = adapterWith([loginOk(), bareList([environmentRecord()])]);
    await expect(adapter.readHosts()).resolves.toHaveLength(1);
  });
});

describe("listContainers(): scoped to one host by the env parameter", () => {
  it("sends env and all, and stamps the host onto every fact", async () => {
    const { adapter, stub } = adapterWith([
      loginOk(),
      wrappedList("containers", [containerRecord()]),
    ]);

    const containers = await adapter.listContainers({ externalHostId: "1" });
    expect(containers).toEqual([
      {
        externalContainerId: "c0ffee0000",
        externalHostId: "1",
        name: "loxep-web",
        image: "ghcr.io/loxep/loxep:1.2.3",
        state: "running",
        status: "Up 3 days",
      },
    ]);

    expect(stub.pathOf(1)).toBe(DOCKHAND_CONTAINERS_PATH);
    expect(stub.queryOf(1)).toEqual({ env: "1", all: "true" });
  });

  it("honours includeStopped: false", async () => {
    const { adapter, stub } = adapterWith([loginOk(), bareList([])]);
    await adapter.listContainers({
      externalHostId: "3",
      includeStopped: false,
    });
    expect(stub.queryOf(1)).toEqual({ env: "3", all: "false" });
  });
});

describe("listStacks(): status plus a running count", () => {
  it("counts running containers out of containerDetails", async () => {
    const { adapter, stub } = adapterWith([loginOk(), bareList([stackRecord()])]);

    const stacks = await adapter.listStacks({ externalHostId: "1" });
    expect(stacks).toEqual([
      {
        name: "loxep",
        externalHostId: "1",
        status: "running",
        sourceType: "git",
        containerCount: 2,
        runningContainerCount: 1,
      },
    ]);
    expect(stub.pathOf(1)).toBe(DOCKHAND_STACKS_PATH);
    expect(stub.queryOf(1)).toEqual({ env: "1" });
  });

  it("keeps an undocumented status value verbatim rather than mapping it", async () => {
    // The documented set is running|stopped|partial|created, but the API is
    // unversioned with an additive-compatibility promise.
    const { adapter } = adapterWith([
      loginOk(),
      bareList([stackRecord({ status: "degraded" })]),
    ]);
    const stacks = await adapter.listStacks({ externalHostId: "1" });
    expect(stacks[0]?.status).toBe("degraded");
  });
});

describe("applyHost(): the one carve-out from rule 13", () => {
  it("creates a host with POST /api/environments", async () => {
    const { adapter, stub } = adapterWith([
      loginOk(),
      { status: 201, body: environmentRecord({ id: 12, name: "vps-hel-01" }) },
    ]);

    const result = await adapter.applyHost({
      kind: "create",
      host: {
        name: "vps-hel-01",
        connectionType: "direct",
        host: "10.0.0.9",
        port: 2376,
        protocol: "https",
      },
    });

    expect(result).toEqual({
      kind: "create",
      name: "vps-hel-01",
      status: "applied",
      externalHostId: "12",
    });
    expect(stub.pathOf(1)).toBe(DOCKHAND_ENVIRONMENTS_PATH);
    expect(stub.calls[1]?.method).toBe("POST");
    expect(stub.bodyOf(1)).toMatchObject({
      name: "vps-hel-01",
      connectionType: "direct",
    });
  });

  it("updates a host with PUT /api/environments/{id}", async () => {
    const { adapter, stub } = adapterWith([
      loginOk(),
      { status: 200, body: environmentRecord({ id: 4, name: "vps-fra-01" }) },
    ]);

    const result = await adapter.applyHost({
      kind: "update",
      externalHostId: "4",
      host: { publicIp: "203.0.113.10" },
    });

    expect(result).toEqual({
      kind: "update",
      name: "vps-fra-01",
      status: "applied",
      externalHostId: "4",
    });
    expect(stub.pathOf(1)).toBe(`${DOCKHAND_ENVIRONMENTS_PATH}/4`);
    expect(stub.calls[1]?.method).toBe("PUT");
    // Partial updates are documented: omitted fields stay unchanged.
    expect(stub.bodyOf(1)).toEqual({ publicIp: "203.0.113.10" });
  });

  it("refuses a connection type upstream does not document", async () => {
    const { adapter } = adapterWith([loginOk()]);
    await expect(
      adapter.applyHost({
        kind: "create",
        host: {
          name: "x",
          connectionType: "ssh" as unknown as "socket",
        },
      }),
    ).rejects.toMatchObject({ kind: "invalid_request" });
  });

  it("refuses more than the documented ten labels, locally", async () => {
    const { adapter, stub } = adapterWith([loginOk()]);
    await expect(
      adapter.applyHost({
        kind: "create",
        host: {
          name: "x",
          connectionType: "socket",
          labels: Array.from({ length: 11 }, (_, i) => `l${i}`),
        },
      }),
    ).rejects.toMatchObject({
      kind: "invalid_request",
      detail: { labelCount: 11 },
    });
    // Rejected before any network call — a reconcile run gets the reason.
    expect(stub.calls).toHaveLength(0);
  });

  it("fails loudly when a create returns no readable record", async () => {
    const { adapter } = adapterWith([
      loginOk(),
      { status: 201, body: { success: true } },
    ]);
    await expect(
      adapter.applyHost({
        kind: "create",
        host: { name: "x", connectionType: "socket" },
      }),
    ).rejects.toMatchObject({ kind: "provider_unavailable" });
  });

  it("has no delete member at all", () => {
    const { adapter } = adapterWith([]);
    expect(Object.keys(adapter)).not.toContain("deleteHost");
    expect(Object.keys(adapter)).not.toContain("removeHost");
  });
});

describe("session handling", () => {
  it("reuses the cached session across calls — one login, not one per read", async () => {
    const { adapter, stub } = adapterWith([
      loginOk(),
      bareList([]),
      bareList([]),
    ]);
    await adapter.listHosts();
    await adapter.listHosts();
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(adapter.stats().authExchanges).toBe(1);
  });

  it("re-authenticates exactly once when the session expires mid-run", async () => {
    const { adapter, stub } = adapterWith([
      loginOk("first-session"),
      fail(403, "Access denied"),
      loginOk("second-session"),
      bareList([environmentRecord()]),
    ]);
    await expect(adapter.listHosts()).resolves.toHaveLength(1);
    expect(adapter.stats().reauthRetries).toBe(1);
    expect(stub.calls[3]?.headers["cookie"]).toBe("dockhand_session=second-session");
  });

  it("gives up after one retry rather than walking into the lockout", async () => {
    // Upstream locks out after "5 failed attempts per IP/username".
    const { adapter, stub } = adapterWith([
      loginOk(),
      fail(403, "Access denied"),
      loginOk(),
      fail(403, "Access denied"),
    ]);
    await expect(adapter.listHosts()).rejects.toMatchObject({ kind: "auth" });
    expect(stub.calls).toHaveLength(4);
  });

  it("fails clearly when a login sets no cookie", async () => {
    const { adapter } = adapterWith([{ status: 200, body: { success: true } }]);
    await expect(adapter.listHosts()).rejects.toMatchObject({
      kind: "provider_unavailable",
    });
  });
});

describe("error taxonomy", () => {
  it("maps Dockhand statuses onto the five Loxep kinds", async () => {
    const cases: Array<[number, string]> = [
      [400, "invalid_request"],
      [401, "auth"],
      [403, "auth"],
      [404, "not_found"],
      [429, "rate_limited"],
      [500, "provider_unavailable"],
    ];
    for (const [status, kind] of cases) {
      const { adapter } = adapterWith([fail(status, "nope")]);
      await expect(adapter.probeSession()).rejects.toMatchObject({ kind });
    }
  });

  it("marks a 429 on the login path as a lockout, not backpressure", async () => {
    const { adapter } = adapterWith([fail(429, "Too many failed attempts")]);
    const error = await adapter.listHosts().catch((e: unknown) => e);
    expect(error).toMatchObject({
      kind: "rate_limited",
      detail: { lockout: true, operation: "auth.login" },
    });
  });

  it("does not mark a 429 on a read path as a lockout", async () => {
    const { adapter } = adapterWith([loginOk(), fail(429, "slow down")]);
    const error = await adapter.listHosts().catch((e: unknown) => e);
    expect((error as { detail: Record<string, unknown> }).detail["lockout"])
      .toBeUndefined();
  });

  it("records that upstream sent details without copying them", async () => {
    const { adapter } = adapterWith([
      fail(400, "Invalid environment", "tlsKey: zzz-private-key-marker-zzz"),
    ]);
    const error = await adapter.probeSession().catch((e: unknown) => e);
    const serialized = JSON.stringify((error as { detail: unknown }).detail);
    expect(serialized).toContain("providerDetailsOmitted");
    expect(serialized).toContain("Invalid environment");
    expect(serialized).not.toContain("zzz-private-key-marker-zzz");
  });

  it("treats a non-JSON body as provider_unavailable", async () => {
    const { adapter } = adapterWith([{ status: 200, text: "<html>nginx</html>" }]);
    await expect(adapter.probeSession()).rejects.toMatchObject({
      kind: "provider_unavailable",
    });
  });
});

describe("capabilities", () => {
  it("declares host registration on and container lifecycle permanently off", () => {
    const { adapter } = adapterWith([]);
    expect(adapter.capabilities()).toEqual({
      provider: "dockhand",
      hostRegistration: true,
      containerLifecycle: false,
      metricHistory: false,
      bearerTokenAuth: false,
      connectionTypes: ["socket", "direct", "hawser-standard", "hawser-edge"],
    });
  });
});

describe("rate budget", () => {
  it("charges the login more than a read, to stay clear of the lockout", async () => {
    const stub = createFetchStub([loginOk(), bareList([])]);
    const adapter = createDockhandAdapter({
      config: { baseUrl: TEST_BASE_URL },
      credentials: { username: TEST_USERNAME, password: TEST_PASSWORD },
      fetchImpl: stub.impl,
      // A negligible refill, so the tokens actually spent stay observable.
      rateBudget: createRateBudget({ capacity: 8, refillPerSecond: 0.001 }),
    });
    await adapter.listHosts();
    const stats = adapter.stats().rateBudget;
    // Two acquisitions — the login and the read — but FIVE tokens: the login
    // costs DOCKHAND_LOGIN_COST (4) so a failing login exhausts Loxep's budget
    // before it exhausts Dockhand's five-attempt lockout.
    expect(stats.acquired).toBe(2);
    expect(Math.round(stats.available)).toBe(3);
  });

  it("refuses locally rather than queueing forever", async () => {
    const stub = createFetchStub([loginOk(), bareList([])]);
    const adapter = createDockhandAdapter({
      config: { baseUrl: TEST_BASE_URL },
      credentials: { username: TEST_USERNAME, password: TEST_PASSWORD },
      fetchImpl: stub.impl,
      // Exactly enough for one login (4) plus one read (1), and no more.
      rateBudget: createRateBudget({
        capacity: 5,
        refillPerSecond: 0.001,
        maxWaitMs: 5,
      }),
    });
    await adapter.listHosts();
    await expect(adapter.listHosts()).rejects.toMatchObject({
      kind: "rate_limited",
      detail: { source: "local_rate_budget" },
    });
  });
});

describe("construction", () => {
  it("refuses an empty half of the credential pair", () => {
    const stub = createFetchStub([]);
    expect(() =>
      createDockhandAdapter({
        config: { baseUrl: TEST_BASE_URL },
        credentials: { username: "", password: TEST_PASSWORD },
        fetchImpl: stub.impl,
      }),
    ).toThrowError(DockhandAdapterError);
  });
});
