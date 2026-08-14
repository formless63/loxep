/**
 * Unit tests for the Termix read adapter. Every test injects a deterministic
 * `fetch` stub; nothing here touches the network.
 */
import { describe, expect, it } from "vitest";
import {
  TERMIX_ACTIVE_SESSIONS_PATH,
  TERMIX_HOSTS_PATH,
  TERMIX_LOGIN_PATH,
  TERMIX_ME_PATH,
  TERMIX_ME_TOKEN_PATH,
  TERMIX_STATUS_PATH,
  TermixAdapterError,
  createRateBudget,
  createTermixAdapter,
  normalizeTermixBaseUrl,
  parseTermixAdapterConfig,
  termixSourceAccountKey,
} from "../src/index.ts";
import {
  TEST_BASE_URL,
  TEST_BEARER_TOKEN,
  TEST_PASSWORD,
  TEST_SESSION_COOKIE,
  TEST_USERNAME,
  createFetchStub,
  fail,
  hostRecord,
  hostsPage,
  loginOkCookieOnly,
  loginOkWithBodyToken,
  meTokenOk,
  sessionRecord,
  sessionsPage,
  statusMap,
} from "./http.ts";

function adapterWith(responses: Parameters<typeof createFetchStub>[0]) {
  const stub = createFetchStub(responses);
  const adapter = createTermixAdapter({
    config: { baseUrl: TEST_BASE_URL },
    credentials: { username: TEST_USERNAME, password: TEST_PASSWORD },
    fetchImpl: stub.impl,
    rateBudget: createRateBudget({ capacity: 200, refillPerSecond: 5000 }),
  });
  return { adapter, stub };
}

describe("base URL and config normalization", () => {
  it("strips a trailing slash", () => {
    expect(normalizeTermixBaseUrl("https://termix.example.com/")).toBe(
      "https://termix.example.com",
    );
  });

  it("keeps an explicit port, which self-hosted instances always have", () => {
    expect(normalizeTermixBaseUrl("http://localhost:8080")).toBe(
      "http://localhost:8080",
    );
  });

  it("refuses userinfo, a non-http(s) scheme, a query string, and a fragment", () => {
    for (const bad of [
      "https://user:pass@termix.example.com",
      "ftp://termix.example.com",
      "https://termix.example.com?x=1",
      "https://termix.example.com#frag",
      "not-a-url",
    ]) {
      expect(() => normalizeTermixBaseUrl(bad)).toThrowError(TermixAdapterError);
    }
  });

  it("requires baseUrl (no default — self-hosted)", () => {
    expect(() => parseTermixAdapterConfig({})).toThrowError(TermixAdapterError);
  });
});

describe("source account key", () => {
  it("separates two accounts on the same instance", () => {
    expect(termixSourceAccountKey(TEST_BASE_URL, "a")).not.toBe(
      termixSourceAccountKey(TEST_BASE_URL, "b"),
    );
  });

  it("is case- and slash-insensitive, so one account is one key", () => {
    expect(termixSourceAccountKey(`${TEST_BASE_URL}/`, "Ops")).toBe(
      termixSourceAccountKey(TEST_BASE_URL, "ops"),
    );
  });
});

describe("login: the two-hop token exchange", () => {
  it("uses the token from the login body directly when one is present", async () => {
    const { adapter, stub } = adapterWith([
      loginOkWithBodyToken(),
      hostsPage([]),
      statusMap({}),
    ]);
    await adapter.listHosts();
    expect(stub.calls).toHaveLength(3);
    expect(stub.pathOf(0)).toBe(TERMIX_LOGIN_PATH);
    expect(stub.bodyOf(0)).toEqual({
      username: TEST_USERNAME,
      password: TEST_PASSWORD,
    });
    // No call to /users/me/token was needed.
    expect(stub.calls.some((c) => new URL(c.url).pathname === TERMIX_ME_TOKEN_PATH)).toBe(
      false,
    );
    for (const call of stub.calls.slice(1)) {
      expect(call.headers["authorization"]).toBe(`Bearer ${TEST_BEARER_TOKEN}`);
    }
  });

  it("falls back to the session cookie + /users/me/token when the login body has no token", async () => {
    const { adapter, stub } = adapterWith([
      loginOkCookieOnly(),
      meTokenOk(),
      hostsPage([]),
      statusMap({}),
    ]);
    await adapter.listHosts();
    expect(stub.pathOf(1)).toBe(TERMIX_ME_TOKEN_PATH);
    expect(stub.calls[1]?.headers["cookie"]).toContain(TEST_SESSION_COOKIE);
    expect(stub.calls[2]?.headers["authorization"]).toBe(`Bearer ${TEST_BEARER_TOKEN}`);
  });

  it("reuses the cached token across calls — one login, not one per read", async () => {
    const { adapter, stub } = adapterWith([
      loginOkWithBodyToken(),
      hostsPage([]),
      statusMap({}),
      hostsPage([]),
      statusMap({}),
    ]);
    await adapter.listHosts();
    await adapter.listHosts();
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(adapter.stats().authExchanges).toBe(1);
  });

  it("re-authenticates exactly once when Termix rejects the cached token", async () => {
    const { adapter, stub } = adapterWith([
      loginOkWithBodyToken("first-token"),
      fail(401, "Session expired - please log in again."),
      loginOkWithBodyToken("second-token"),
      hostsPage([]),
      statusMap({}),
    ]);
    await adapter.listHosts();
    expect(adapter.stats().reauthRetries).toBe(1);
    expect(stub.calls[stub.calls.length - 1]?.headers["authorization"]).toBe(
      "Bearer second-token",
    );
  });
});

describe("listHosts(): merges /host/db/host with /status", () => {
  it("maps a host and its status entry into one fact", async () => {
    const { adapter } = adapterWith([
      loginOkWithBodyToken(),
      hostsPage([hostRecord()]),
      statusMap({ "1": { connected: true } }),
    ]);
    const hosts = await adapter.listHosts();
    expect(hosts).toEqual([
      { externalHostId: "1", name: "web-01", ip: "10.0.0.11", online: true, lastSeenAt: null },
    ]);
  });

  it("reads lastSeen only when the status entry reports not-connected", async () => {
    const { adapter } = adapterWith([
      loginOkWithBodyToken(),
      hostsPage([hostRecord()]),
      statusMap({ "1": { isConnected: false, lastChecked: "2026-08-01T00:00:00Z" } }),
    ]);
    const hosts = await adapter.listHosts();
    expect(hosts[0]?.online).toBe(false);
    expect(hosts[0]?.lastSeenAt).toBe("2026-08-01T00:00:00Z");
  });

  it("accepts a bare boolean status entry", async () => {
    const { adapter } = adapterWith([
      loginOkWithBodyToken(),
      hostsPage([hostRecord()]),
      statusMap({ "1": true }),
    ]);
    const hosts = await adapter.listHosts();
    expect(hosts[0]?.online).toBe(true);
  });

  it("degrades a host with no status entry to online: null", async () => {
    const { adapter } = adapterWith([
      loginOkWithBodyToken(),
      hostsPage([hostRecord()]),
      statusMap({}),
    ]);
    const hosts = await adapter.listHosts();
    expect(hosts[0]?.online).toBeNull();
    expect(hosts[0]?.lastSeenAt).toBeNull();
  });

  it("degrades a record missing every optional field, keeping only the id", async () => {
    const { adapter } = adapterWith([
      loginOkWithBodyToken(),
      hostsPage([{ id: 42 }]),
      statusMap({}),
    ]);
    const hosts = await adapter.listHosts();
    expect(hosts).toEqual([
      { externalHostId: "42", name: null, ip: null, online: null, lastSeenAt: null },
    ]);
  });

  it("skips one unreadable record instead of losing the whole inventory", async () => {
    const { adapter } = adapterWith([
      loginOkWithBodyToken(),
      hostsPage([hostRecord({ id: 1 }), { noIdAtAll: true }]),
      statusMap({}),
    ]);
    const hosts = await adapter.listHosts();
    expect(hosts.map((h) => h.externalHostId)).toEqual(["1"]);
  });
});

describe("listSessions(): the fully-specified read", () => {
  it("maps every documented field, dropping the internal tabInstanceId/shareId", async () => {
    const { adapter, stub } = adapterWith([
      loginOkWithBodyToken(),
      sessionsPage([sessionRecord()]),
    ]);
    const sessions = await adapter.listSessions();
    expect(sessions).toEqual([
      {
        sessionId: "sess-1",
        hostId: "1",
        hostName: "web-01",
        isConnected: true,
        createdAt: 1_755_000_000_000,
        isOwnSession: true,
        sharedByUsername: null,
        permissionLevel: null,
      },
    ]);
    expect(stub.pathOf(1)).toBe(TERMIX_ACTIVE_SESSIONS_PATH);
  });

  it("reports a session shared by another user", async () => {
    const { adapter } = adapterWith([
      loginOkWithBodyToken(),
      sessionsPage([
        sessionRecord({
          isOwnSession: false,
          sharedByUsername: "alice",
          permissionLevel: "view",
        }),
      ]),
    ]);
    const sessions = await adapter.listSessions();
    expect(sessions[0]?.isOwnSession).toBe(false);
    expect(sessions[0]?.sharedByUsername).toBe("alice");
    expect(sessions[0]?.permissionLevel).toBe("view");
  });
});

describe("probe(): the whoami-equivalent", () => {
  it("reports reachable and authenticated on a normal identity read", async () => {
    const { adapter, stub } = adapterWith([
      loginOkWithBodyToken(),
      { status: 200, body: { username: TEST_USERNAME } },
    ]);
    await expect(adapter.probe()).resolves.toEqual({
      reachable: true,
      authenticated: true,
      authRejectedStatus: null,
    });
    expect(stub.pathOf(1)).toBe(TERMIX_ME_PATH);
  });

  it("reports reachable but not authenticated on bad credentials, without throwing", async () => {
    const { adapter } = adapterWith([fail(401, "Invalid username or password.")]);
    await expect(adapter.probe()).resolves.toEqual({
      reachable: true,
      authenticated: false,
      authRejectedStatus: 401,
    });
  });

  it("reports authRejectedStatus: 403 when password auth is disabled instance-wide", async () => {
    const { adapter } = adapterWith([
      fail(403, "Password authentication is currently disabled."),
    ]);
    await expect(adapter.probe()).resolves.toEqual({
      reachable: true,
      authenticated: false,
      authRejectedStatus: 403,
    });
  });

  it("still throws for a network-level failure", async () => {
    const { adapter } = adapterWith([fail(503, "down")]);
    await expect(adapter.probe()).rejects.toMatchObject({
      kind: "provider_unavailable",
    });
  });
});

describe("error taxonomy", () => {
  it("maps non-auth statuses onto the matching Loxep kind and still rejects from probe()", async () => {
    const cases: Array<[number, string]> = [
      [400, "invalid_request"],
      [404, "not_found"],
      [429, "rate_limited"],
      [500, "provider_unavailable"],
    ];
    for (const [status, kind] of cases) {
      const { adapter } = adapterWith([fail(status, "nope")]);
      await expect(adapter.probe()).rejects.toMatchObject({ kind });
    }
  });

  it("maps 401/403 to 'auth', which probe() deliberately swallows rather than rejecting", async () => {
    for (const status of [401, 403]) {
      const { adapter } = adapterWith([fail(status, "nope")]);
      await expect(adapter.probe()).resolves.toEqual({
        reachable: true,
        authenticated: false,
        authRejectedStatus: status,
      });
    }
  });

  it("classifies the same 401/403 as 'auth' on a non-probe read, where it DOES reject", async () => {
    for (const status of [401, 403]) {
      const { adapter } = adapterWith([fail(status, "nope")]);
      await expect(adapter.listSessions()).rejects.toMatchObject({ kind: "auth" });
    }
  });
});

describe("construction", () => {
  it("refuses an empty half of the credential pair", () => {
    const stub = createFetchStub([]);
    expect(() =>
      createTermixAdapter({
        config: { baseUrl: TEST_BASE_URL },
        credentials: { username: TEST_USERNAME, password: "" },
        fetchImpl: stub.impl,
      }),
    ).toThrowError(TermixAdapterError);
  });
});

describe("rate budget", () => {
  it("refuses rather than queueing forever once the budget is exhausted", async () => {
    const stub = createFetchStub([loginOkWithBodyToken()]);
    const adapter = createTermixAdapter({
      config: { baseUrl: TEST_BASE_URL },
      credentials: { username: TEST_USERNAME, password: TEST_PASSWORD },
      fetchImpl: stub.impl,
      // Capacity exactly covers the login's cost; the follow-up /users/me
      // read then has nothing left to acquire from and cannot refill in time.
      rateBudget: createRateBudget({ capacity: 2, refillPerSecond: 0.001, maxWaitMs: 5 }),
    });
    await expect(adapter.probe()).rejects.toMatchObject({
      kind: "rate_limited",
      detail: { source: "local_rate_budget" },
    });
  });
});
