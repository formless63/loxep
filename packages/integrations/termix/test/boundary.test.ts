/**
 * Boundary tests: the assertions that make "read-only" and "no credential
 * leaks" properties of the code rather than of a review. Termix's full
 * surface (Docker control, systemd services, process signals, terminal
 * exec, file deletion) is far larger and more dangerous than any sibling
 * integration's, so this file is written in Dockhand's
 * `forbidden-verbs.test.ts` style: it asserts both the SURFACE (no exported
 * member is named after a write verb) and the TRAFFIC (no request ever
 * touches a forbidden path segment).
 */
import { describe, expect, it } from "vitest";
import {
  TERMIX_ALLOWED_NON_GET_PATHS,
  TERMIX_ALLOWED_PATHS,
  TERMIX_FORBIDDEN_MEMBER_VERBS,
  TERMIX_FORBIDDEN_PATH_SEGMENTS,
  TERMIX_LOGIN_PATH,
  createRateBudget,
  createTermixAdapter,
  redactTermixHost,
  redactTermixSession,
  redactTermixSessionPage,
} from "../src/index.ts";
import * as termix from "../src/index.ts";
import {
  TEST_BASE_URL,
  TEST_BEARER_TOKEN,
  TEST_PASSWORD,
  TEST_USERNAME,
  createFetchStub,
  hostRecord,
  hostsPage,
  loginOkWithBodyToken,
  sessionRecord,
  sessionsPage,
  statusMap,
} from "./http.ts";

/** Drive every exported read so the recorded traffic is the whole surface. */
async function exerciseEverything() {
  const stub = createFetchStub([
    loginOkWithBodyToken(),
    hostsPage([hostRecord()]),
    statusMap({ "1": true }),
    sessionsPage([sessionRecord()]),
    { status: 200, body: { username: TEST_USERNAME } },
  ]);
  const adapter = createTermixAdapter({
    config: { baseUrl: TEST_BASE_URL },
    credentials: { username: TEST_USERNAME, password: TEST_PASSWORD },
    fetchImpl: stub.impl,
    rateBudget: createRateBudget({ capacity: 200, refillPerSecond: 5000 }),
  });
  await adapter.listHosts();
  await adapter.listSessions();
  await adapter.probe();
  return { stub, adapter };
}

describe("THE SURFACE: nothing here can exec, start, stop, or delete", () => {
  it("has exactly the read members and no others", () => {
    const stub = createFetchStub([]);
    const adapter = createTermixAdapter({
      config: { baseUrl: TEST_BASE_URL },
      credentials: { username: TEST_USERNAME, password: TEST_PASSWORD },
      fetchImpl: stub.impl,
    });
    expect(Object.keys(adapter).sort()).toEqual([
      "capabilities",
      "listHosts",
      "listSessions",
      "probe",
      "stats",
    ]);
  });

  it("has no adapter member named after a forbidden verb", () => {
    const stub = createFetchStub([]);
    const adapter = createTermixAdapter({
      config: { baseUrl: TEST_BASE_URL },
      credentials: { username: TEST_USERNAME, password: TEST_PASSWORD },
      fetchImpl: stub.impl,
    });
    for (const member of Object.keys(adapter)) {
      for (const verb of TERMIX_FORBIDDEN_MEMBER_VERBS) {
        expect(
          member.toLowerCase().includes(verb),
          `adapter member "${member}" contains the forbidden verb "${verb}"`,
        ).toBe(false);
      }
    }
  });

  it("exports no package member named after a forbidden verb", () => {
    // `createTermixAdapter`/`createRateBudget` are local constructors, not
    // provider calls — the same exception Dockhand's equivalent test makes.
    const constructors = new Set(["createTermixAdapter", "createRateBudget"]);
    for (const exported of Object.keys(termix)) {
      if (exported.startsWith("TERMIX_FORBIDDEN") || constructors.has(exported)) {
        continue;
      }
      for (const verb of TERMIX_FORBIDDEN_MEMBER_VERBS) {
        expect(
          exported.toLowerCase().includes(verb),
          `export "${exported}" contains the forbidden verb "${verb}"`,
        ).toBe(false);
      }
    }
  });

  it("declares no allowed path containing a forbidden segment", () => {
    for (const path of TERMIX_ALLOWED_PATHS) {
      const segments = path.split("/").filter(Boolean);
      for (const segment of segments) {
        expect(TERMIX_FORBIDDEN_PATH_SEGMENTS as readonly string[]).not.toContain(
          segment,
        );
      }
    }
  });
});

describe("THE TRAFFIC: what actually leaves the boundary", () => {
  it("is a GET, except the single documented login POST", async () => {
    const { stub } = await exerciseEverything();
    const nonGet = stub.calls.filter((call) => call.method !== "GET");
    expect(nonGet).toHaveLength(1);
    expect(new URL(nonGet[0]!.url).pathname).toBe(TERMIX_LOGIN_PATH);
  });

  it("uses only paths declared in operations.ts", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      const path = new URL(call.url).pathname;
      expect(
        TERMIX_ALLOWED_PATHS as readonly string[],
        `request to undeclared path ${path}`,
      ).toContain(path);
    }
  });

  it("never requests a path containing a forbidden segment", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      const segments = new URL(call.url).pathname.split("/").filter(Boolean);
      for (const segment of segments) {
        expect(
          TERMIX_FORBIDDEN_PATH_SEGMENTS as readonly string[],
          `request to ${call.url} used forbidden segment "${segment}"`,
        ).not.toContain(segment);
      }
    }
  });

  it("only the login POST is a write; the allow-list has exactly one non-GET path", () => {
    expect([...TERMIX_ALLOWED_NON_GET_PATHS]).toEqual([TERMIX_LOGIN_PATH]);
  });

  it("never puts a credential in a URL", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      expect(call.url).not.toContain(TEST_PASSWORD);
      expect(call.url).not.toContain(TEST_BEARER_TOKEN);
    }
  });

  it("sends the password in exactly one body — the login exchange", async () => {
    const { stub } = await exerciseEverything();
    const carrying = stub.calls.filter((call) => (call.body ?? "").includes(TEST_PASSWORD));
    expect(carrying).toHaveLength(1);
    expect(new URL(carrying[0]!.url).pathname).toBe(TERMIX_LOGIN_PATH);
  });
});

describe("no credential can reach an error detail", () => {
  it("keeps the token out of a detail when an authenticated read fails", async () => {
    const stub = createFetchStub([
      loginOkWithBodyToken(),
      { status: 500, body: { message: "internal error" } },
    ]);
    const adapter = createTermixAdapter({
      config: { baseUrl: TEST_BASE_URL },
      credentials: { username: TEST_USERNAME, password: TEST_PASSWORD },
      fetchImpl: stub.impl,
    });
    const error = await adapter.listSessions().catch((e: unknown) => e);
    expect(JSON.stringify((error as { detail: unknown }).detail)).not.toContain(
      TEST_BEARER_TOKEN,
    );
  });
});

describe("redactors are allow-lists, not filters", () => {
  it("summarizes a host from only what the adapter itself already read", () => {
    const summary = redactTermixHost({
      externalHostId: "1",
      name: "web-01",
      ip: "10.0.0.11",
      online: true,
      lastSeenAt: null,
    });
    expect(summary).toEqual({ externalHostId: "1", name: "web-01", online: true });
  });

  it("summarizes a session fact without its internal tabInstanceId/shareId", () => {
    // redactTermixSession operates on the already-mapped Loxep fact — see
    // src/adapter.ts's listSessions(), which is what strips tabInstanceId/
    // shareId in the first place; this asserts the redactor does not
    // reintroduce either if a future edit widened the fact shape.
    const summary = redactTermixSession({
      sessionId: "sess-1",
      hostId: "1",
      hostName: "web-01",
      isConnected: true,
      createdAt: 1_755_000_000_000,
      isOwnSession: true,
      sharedByUsername: null,
      permissionLevel: null,
      // A future fact-shape widening that reintroduced these must not leak
      // through the redactor even though this test does not exercise it.
      tabInstanceId: "tab-1",
      shareId: "share-1",
    });
    expect(summary).toEqual({
      sessionId: "sess-1",
      hostId: "1",
      hostName: "web-01",
      isConnected: true,
      isOwnSession: true,
      sharedByUsername: null,
    });
    expect(JSON.stringify(summary)).not.toContain("tab-1");
    expect(JSON.stringify(summary)).not.toContain("share-1");
  });

  it("summarizes a page by count, never by inlining the records", () => {
    expect(redactTermixSessionPage([sessionRecord(), sessionRecord()])).toEqual({
      sessionCount: 2,
    });
  });

  it("exports no redactor for the login response or the JWT", () => {
    const redactors = Object.keys(termix).filter((name) => name.startsWith("redact"));
    expect(redactors.sort()).toEqual([
      "redactTermixHost",
      "redactTermixSession",
      "redactTermixSessionPage",
    ]);
  });
});

describe("no provider response type escapes the boundary", () => {
  it("exports facts and configuration, and nothing Termix-shaped", () => {
    const exported = Object.keys(termix);
    expect(exported).not.toContain("hostSchema");
    expect(exported).not.toContain("sessionSchema");
  });
});
