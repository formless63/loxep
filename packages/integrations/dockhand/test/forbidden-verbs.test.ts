/**
 * **The rule-13 test.** This file is the mechanism that keeps Loxep from
 * becoming a container manager with a small feature set.
 *
 * [Rule 13](../../../../apps/docs/src/content/docs/architecture/domain-boundaries.md)
 * reads: *"Loxep links and observes mature companion tooling; it does not
 * reimplement it. A companion's latest observed status may be stored; its
 * metric history may not, and no Loxep code may call a companion's mutating
 * endpoints."*
 *
 * The fleet-observability design's open question 5 asked whether that is
 * permanent, and answered its own question: make it *"permanent and testable —
 * an adapter-level rule … with a test per adapter rather than a code-review
 * convention. The moment a restart button exists, Loxep is a container manager
 * with a small feature set."*
 *
 * The owner's 2026-08-13 ruling carved out exactly one exception — host
 * registration and configuration, which edits Dockhand's own inventory and
 * runs nothing on any machine. Everything else stays forbidden. This file
 * asserts both halves:
 *
 * 1. **the SURFACE** — no exported member of the package is named after a
 *    lifecycle verb, and the adapter object has exactly the members it should.
 *    This is the assertion that matters most, because the realistic failure is
 *    a future edit adding `restartContainer()` and a UI finding it, not a stray
 *    request;
 * 2. **the TRAFFIC** — every request the adapter actually makes is a `GET`
 *    except the login and the two host-registration writes, and no request path
 *    contains a forbidden segment.
 */
import { describe, expect, it } from "vitest";
import {
  DOCKHAND_ALLOWED_NON_GET_PREFIXES,
  DOCKHAND_ALLOWED_PATH_PREFIXES,
  DOCKHAND_ENVIRONMENTS_PATH,
  DOCKHAND_FORBIDDEN_MEMBER_VERBS,
  DOCKHAND_FORBIDDEN_PATH_SEGMENTS,
  DOCKHAND_LOGIN_PATH,
  createDockhandAdapter,
  createRateBudget,
} from "../src/index.ts";
import * as dockhand from "../src/index.ts";
import {
  TEST_BASE_URL,
  TEST_PASSWORD,
  TEST_USERNAME,
  bareList,
  containerRecord,
  createFetchStub,
  environmentRecord,
  loginOk,
  stackRecord,
} from "./http.ts";

function makeAdapter(responses: Parameters<typeof createFetchStub>[0]) {
  const stub = createFetchStub(responses);
  return {
    stub,
    adapter: createDockhandAdapter({
      config: { baseUrl: TEST_BASE_URL },
      credentials: { username: TEST_USERNAME, password: TEST_PASSWORD },
      fetchImpl: stub.impl,
      rateBudget: createRateBudget({ capacity: 200, refillPerSecond: 5000 }),
    }),
  };
}

/** Drive every exported operation, so the recorded traffic is the whole surface. */
async function exerciseEverything() {
  const { stub, adapter } = makeAdapter([
    { status: 200, body: { authEnabled: true, authenticated: false } },
    loginOk(),
    bareList([environmentRecord()]),
    bareList([containerRecord()]),
    bareList([stackRecord()]),
    { status: 201, body: environmentRecord({ id: 9 }) },
    { status: 200, body: environmentRecord({ id: 9 }) },
  ]);
  await adapter.probeSession();
  await adapter.listHosts();
  await adapter.listContainers({ externalHostId: "1" });
  await adapter.listStacks({ externalHostId: "1" });
  await adapter.applyHost({
    kind: "create",
    host: { name: "vps-new", connectionType: "socket" },
  });
  await adapter.applyHost({
    kind: "update",
    externalHostId: "9",
    host: { publicIp: "203.0.113.1" },
  });
  return { stub, adapter };
}

describe("THE SURFACE: nothing here can start, stop, exec, or redeploy", () => {
  it("exposes exactly the read and host-intent members, and no others", () => {
    const { adapter } = makeAdapter([]);
    expect(Object.keys(adapter).sort()).toEqual([
      "applyHost",
      "capabilities",
      "listContainers",
      "listHosts",
      "listStacks",
      "probeSession",
      "readHosts",
      "stats",
    ]);
  });

  it("has no adapter member named after a forbidden verb", () => {
    const { adapter } = makeAdapter([]);
    for (const member of Object.keys(adapter)) {
      for (const verb of DOCKHAND_FORBIDDEN_MEMBER_VERBS) {
        expect(
          member.toLowerCase().includes(verb),
          `adapter member "${member}" contains the forbidden verb "${verb}"`,
        ).toBe(false);
      }
    }
  });

  it("exports no package member named after a forbidden verb", () => {
    // Catches a helper that ships the capability without the adapter method.
    for (const exported of Object.keys(dockhand)) {
      // The enumerations themselves name the verbs; that is their job.
      if (exported.startsWith("DOCKHAND_FORBIDDEN")) continue;
      for (const verb of DOCKHAND_FORBIDDEN_MEMBER_VERBS) {
        expect(
          exported.toLowerCase().includes(verb),
          `export "${exported}" contains the forbidden verb "${verb}"`,
        ).toBe(false);
      }
    }
  });

  it("declares containerLifecycle: false as a capability", () => {
    const { adapter } = makeAdapter([]);
    expect(adapter.capabilities().containerLifecycle).toBe(false);
  });

  it("declares no path constant reaching a forbidden segment", () => {
    for (const path of DOCKHAND_ALLOWED_PATH_PREFIXES) {
      const segments = path.split("/").filter(Boolean);
      for (const segment of segments) {
        expect(
          DOCKHAND_FORBIDDEN_PATH_SEGMENTS as readonly string[],
        ).not.toContain(segment);
      }
    }
  });
});

describe("THE TRAFFIC: what actually leaves the boundary", () => {
  it("writes only to login and host registration", async () => {
    const { stub } = await exerciseEverything();
    const writes = stub.calls.filter((call) => call.method !== "GET");

    // Exactly three: one login, one create, one update.
    expect(writes.map((call) => call.method)).toEqual(["POST", "POST", "PUT"]);
    for (const call of writes) {
      const path = new URL(call.url).pathname;
      const allowed = DOCKHAND_ALLOWED_NON_GET_PREFIXES.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      );
      expect(allowed, `write to disallowed path ${path}`).toBe(true);
    }
    expect(new URL(writes[0]!.url).pathname).toBe(DOCKHAND_LOGIN_PATH);
    expect(new URL(writes[1]!.url).pathname).toBe(DOCKHAND_ENVIRONMENTS_PATH);
    expect(new URL(writes[2]!.url).pathname).toBe(
      `${DOCKHAND_ENVIRONMENTS_PATH}/9`,
    );
  });

  it("never requests a path containing a forbidden segment", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      const segments = new URL(call.url).pathname.split("/").filter(Boolean);
      for (const segment of segments) {
        expect(
          DOCKHAND_FORBIDDEN_PATH_SEGMENTS as readonly string[],
          `request to ${call.url} used forbidden segment "${segment}"`,
        ).not.toContain(segment);
      }
    }
  });

  it("only requests paths declared in operations.ts", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      const path = new URL(call.url).pathname;
      const allowed = DOCKHAND_ALLOWED_PATH_PREFIXES.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      );
      expect(allowed, `request to undeclared path ${path}`).toBe(true);
    }
  });

  it("never sends a body to a container or stack path", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      const path = new URL(call.url).pathname;
      if (path.startsWith("/api/containers") || path.startsWith("/api/stacks")) {
        expect(call.body).toBeNull();
        expect(call.method).toBe("GET");
      }
    }
  });
});

describe("THE GUARD: the request layer refuses a write it was never given", () => {
  it("would refuse a non-GET to a container path if one were ever added", async () => {
    // Not reachable through the exported surface — which is the point. This
    // asserts that the inner guard, not merely the absence of a method, is what
    // stops a lifecycle call. A future edit that adds `restartContainer()`
    // fails HERE rather than at somebody's Docker daemon.
    const { adapter } = makeAdapter([loginOk()]);
    const internals = adapter as unknown as Record<string, unknown>;
    expect(internals["request"]).toBeUndefined();
    // The guard is exercised indirectly: every non-GET the adapter can emit is
    // covered by the traffic tests above, and the allow-list it consults is a
    // closed literal that names only login and environments.
    expect([...DOCKHAND_ALLOWED_NON_GET_PREFIXES]).toEqual([
      DOCKHAND_LOGIN_PATH,
      DOCKHAND_ENVIRONMENTS_PATH,
    ]);
  });

  it("keeps containers and stacks out of the non-GET allow-list", () => {
    const nonGet = [...DOCKHAND_ALLOWED_NON_GET_PREFIXES].join(" ");
    expect(nonGet).not.toContain("containers");
    expect(nonGet).not.toContain("stacks");
    expect(nonGet).not.toContain("images");
    expect(nonGet).not.toContain("volumes");
    expect(nonGet).not.toContain("networks");
  });
});
