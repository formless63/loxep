/**
 * Boundary tests: the assertions that make "read-only", "GET only", and "no
 * credential leaks" properties of the code rather than of a review — the
 * fleet-observability design's open question 5, resolved as *"an
 * adapter-level rule that only `GET` … may leave the fleet integration
 * boundary, with a test per adapter rather than a code-review convention"*.
 */
import { describe, expect, it } from "vitest";
import {
  createGatusAdapter,
  createRateBudget,
  isGatusAllowedPath,
  redactGatusConfigProbe,
  redactGatusEndpointStatus,
  redactGatusEndpointStatusList,
  redactGatusHealth,
} from "../src/index.ts";
import * as gatus from "../src/index.ts";
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
  responseTimeText,
  uptimeText,
} from "./http.ts";

/** Drive every exported read so the recorded calls cover the whole surface. */
async function exerciseEverything() {
  const stub = createFetchStub([
    configProbe(false, true), // health() doesn't probe, but capabilities() below does
    health("UP"),
    configProbe(false, true),
    endpointStatuses([endpointStatus()]),
    uptimeText(0.99),
    responseTimeText(120),
  ]);
  const adapter = createGatusAdapter({
    config: { baseUrl: TEST_BASE_URL },
    credentials: { username: TEST_USERNAME, password: TEST_PASSWORD },
    fetchImpl: stub.impl,
    rateBudget: createRateBudget({ capacity: 100, refillPerSecond: 1000 }),
  });
  await adapter.capabilities();
  await adapter.health();
  await adapter.listEndpointStatuses();
  await adapter.endpointUptime("core_loxep", "24h");
  await adapter.endpointResponseTime("core_loxep", "24h");
  return { stub, adapter };
}

describe("the exported surface exposes no way to mutate a Gatus instance", () => {
  it("has exactly the read members and no others", () => {
    const stub = createFetchStub([]);
    const adapter = createGatusAdapter({
      config: { baseUrl: TEST_BASE_URL },
      fetchImpl: stub.impl,
    });
    expect(Object.keys(adapter).sort()).toEqual([
      "capabilities",
      "endpointResponseTime",
      "endpointUptime",
      "health",
      "listEndpointStatuses",
      "probeConfig",
      "stats",
    ]);
  });

  it("exports no function whose name suggests a write", () => {
    const forbidden =
      /^(update|create|delete|remove|patch|set|write|upsert|pause|resume|reset|push)/i;
    const offenders = Object.keys(gatus).filter(
      (name) => forbidden.test(name) && name !== "createRateBudget" && name !== "createGatusAdapter",
    );
    expect(offenders).toEqual([]);
  });
});

describe("every request the adapter actually makes", () => {
  it("is a GET, with no exceptions at all — Gatus has no login exchange", async () => {
    const { stub } = await exerciseEverything();
    expect(stub.calls.length).toBeGreaterThan(0);
    for (const call of stub.calls) {
      expect(call.method).toBe("GET");
    }
  });

  it("uses only paths recognized by operations.ts's allow-list", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      expect(isGatusAllowedPath(new URL(call.url).pathname)).toBe(true);
    }
  });

  it("never puts a credential in a URL or query string", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      expect(call.url).not.toContain(TEST_PASSWORD);
      expect(call.url).not.toContain(TEST_USERNAME);
    }
  });

  it("sends Basic auth ONLY to the protected bulk-statuses route", async () => {
    const { stub } = await exerciseEverything();
    const authorized = stub.calls.filter((call) => "authorization" in call.headers);
    expect(authorized).toHaveLength(1);
    expect(new URL(authorized[0]!.url).pathname).toBe(
      "/api/v1/endpoints/statuses",
    );
  });

  it("never authorizes the unauthenticated config/health/per-endpoint routes", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      const path = new URL(call.url).pathname;
      if (path !== "/api/v1/endpoints/statuses") {
        expect(call.headers["authorization"]).toBeUndefined();
      }
    }
  });
});

describe("no credential can reach an error detail", () => {
  it("keeps the username and password out of a failed bulk-statuses read", async () => {
    const stub = createFetchStub([configProbe(false, false), fail(401, "Unauthorized")]);
    const adapter = createGatusAdapter({
      config: { baseUrl: TEST_BASE_URL },
      credentials: { username: TEST_USERNAME, password: TEST_PASSWORD },
      fetchImpl: stub.impl,
    });
    const error = await adapter.listEndpointStatuses().catch((e: unknown) => e);
    const serialized = JSON.stringify({
      message: (error as Error).message,
      detail: (error as { detail: unknown }).detail,
    });
    expect(serialized).not.toContain(TEST_PASSWORD);
    expect(serialized).not.toContain(TEST_USERNAME);
    // The base64-encoded header value must not leak either.
    const header = Buffer.from(`${TEST_USERNAME}:${TEST_PASSWORD}`).toString(
      "base64",
    );
    expect(serialized).not.toContain(header);
    expect(serialized).toContain("Unauthorized");
  });
});

describe("redactors are allow-lists, not filters", () => {
  it("summarizes an endpoint status without inlining error text", () => {
    const facts = {
      key: "core_loxep",
      name: "Loxep",
      group: "core",
      success: false,
      observedAt: "2026-08-13T07:00:00Z",
      errorCount: 2,
      secretish: "do-not-copy",
    };
    expect(redactGatusEndpointStatus(facts)).toEqual({
      key: "core_loxep",
      name: "Loxep",
      group: "core",
      success: false,
      observedAt: "2026-08-13T07:00:00Z",
      errorCount: 2,
    });
  });

  it("summarizes a bulk read by its count, never the list itself", () => {
    expect(
      redactGatusEndpointStatusList([
        { key: "a" },
        { key: "b" },
        { key: "c" },
      ]),
    ).toEqual({ statusCount: 3 });
  });

  it("passes the health body through an allow-list even though it is harmless", () => {
    expect(
      redactGatusHealth({ status: "DOWN", reason: "db unreachable", futureField: "x" }),
    ).toEqual({ status: "DOWN", reason: "db unreachable" });
  });

  it("passes the config probe through an allow-list", () => {
    expect(
      redactGatusConfigProbe({ oidc: true, authenticated: false, announcements: [] }),
    ).toEqual({ oidc: true, authenticated: false });
  });
});

describe("no provider response type escapes the boundary", () => {
  it("exports facts and configuration, and nothing Gatus-shaped", () => {
    const exported = Object.keys(gatus);
    expect(exported).not.toContain("endpointStatusSchema");
    expect(exported).not.toContain("resultSchema");
    expect(exported).not.toContain("configProbeResponseSchema");
    expect(exported).not.toContain("endpointStatusesResponseSchema");
  });
});

describe("resultEntry/endpointStatus test fixtures stay realistic-but-fake", () => {
  it("does not accidentally assert on a real credential shape", () => {
    // Documented guard: TEST_USERNAME/TEST_PASSWORD must stay distinctive
    // marker strings, never a realistic token prefix.
    expect(TEST_USERNAME.startsWith("zzz-")).toBe(true);
    expect(TEST_PASSWORD.startsWith("zzz-")).toBe(true);
  });
});
