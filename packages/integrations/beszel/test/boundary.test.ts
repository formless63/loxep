/**
 * Boundary tests: the assertions that make "read-only" and "no credential
 * leaks" properties of the code rather than of a review.
 *
 * The fleet-observability design's open question 5 asked whether "no mutating
 * call to any fleet tool" is a permanent rule, and recommended making it
 * *"testable — an adapter-level rule that only `GET` … may leave the fleet
 * integration boundary, with a test per adapter rather than a code-review
 * convention"*. This file is that test for Beszel.
 */
import { describe, expect, it } from "vitest";
import {
  BESZEL_ALLOWED_NON_GET_PATHS,
  BESZEL_ALLOWED_PATHS,
  BESZEL_AUTH_PATH,
  BESZEL_SUPERUSERS_COLLECTION,
  createBeszelAdapter,
  createRateBudget,
  redactBeszelHealth,
  redactBeszelSystem,
  redactBeszelSystemPage,
} from "../src/index.ts";
import * as beszel from "../src/index.ts";
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

/** Drive every exported read so the recorded calls cover the whole surface. */
async function exerciseEverything() {
  const stub = createFetchStub([
    { status: 200, body: { status: 200, message: "API is healthy." } },
    authOk(),
    page([systemRecord()]),
  ]);
  const adapter = createBeszelAdapter({
    config: { baseUrl: TEST_BASE_URL },
    credentials: { email: TEST_EMAIL, password: TEST_PASSWORD },
    fetchImpl: stub.impl,
    rateBudget: createRateBudget({ capacity: 100, refillPerSecond: 1000 }),
  });
  await adapter.health();
  await adapter.listSystems();
  return { stub, adapter };
}

describe("the exported surface exposes no way to mutate a Beszel hub", () => {
  it("has exactly the read members and no others", async () => {
    const stub = createFetchStub([]);
    const adapter = createBeszelAdapter({
      config: { baseUrl: TEST_BASE_URL },
      credentials: { email: TEST_EMAIL, password: TEST_PASSWORD },
      fetchImpl: stub.impl,
    });
    expect(Object.keys(adapter).sort()).toEqual([
      "capabilities",
      "health",
      "listSystems",
      "stats",
    ]);
  });

  it("exports no function whose name suggests a write", () => {
    const forbidden =
      /^(update|create|delete|remove|patch|set|write|upsert|pause|resume|reset)/i;
    const offenders = Object.keys(beszel).filter(
      (name) => forbidden.test(name) && !name.startsWith("createBeszelAdapter"),
    );
    // `createRateBudget` is a local constructor, not a provider call.
    expect(offenders.filter((n) => n !== "createRateBudget")).toEqual([]);
  });

  it("declares no mutating path at all", () => {
    for (const path of BESZEL_ALLOWED_PATHS) {
      expect(path.startsWith("/api/")).toBe(true);
    }
    // The login exchange is the one and only non-GET path.
    expect([...BESZEL_ALLOWED_NON_GET_PATHS]).toEqual([BESZEL_AUTH_PATH]);
  });
});

describe("every request the adapter actually makes", () => {
  it("is a GET, except the single documented login POST", async () => {
    const { stub } = await exerciseEverything();
    const nonGet = stub.calls.filter((call) => call.method !== "GET");
    expect(nonGet).toHaveLength(1);
    expect(new URL(nonGet[0]!.url).pathname).toBe(BESZEL_AUTH_PATH);
  });

  it("uses only paths declared in operations.ts", async () => {
    const { stub } = await exerciseEverything();
    for (let i = 0; i < stub.calls.length; i++) {
      expect(BESZEL_ALLOWED_PATHS as readonly string[]).toContain(
        stub.pathOf(i),
      );
    }
  });

  it("never touches the PocketBase superuser collection", async () => {
    // The design gated Beszel on the belief that a read needed one. It does
    // not, and this assertion stops a later "fix" from reaching for it.
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      expect(call.url).not.toContain(BESZEL_SUPERUSERS_COLLECTION);
    }
  });

  it("never puts a credential in a URL or query string", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      expect(call.url).not.toContain(TEST_PASSWORD);
      expect(call.url).not.toContain(TEST_TOKEN);
      expect(call.url).not.toContain(TEST_EMAIL);
    }
  });

  it("sends the password in exactly one body — the login exchange", async () => {
    const { stub } = await exerciseEverything();
    const carrying = stub.calls.filter((call) =>
      (call.body ?? "").includes(TEST_PASSWORD),
    );
    expect(carrying).toHaveLength(1);
    expect(new URL(carrying[0]!.url).pathname).toBe(BESZEL_AUTH_PATH);
  });
});

describe("no credential can reach an error detail", () => {
  it("keeps the password and token out of a failed login's detail", async () => {
    const stub = createFetchStub([
      fail(400, "Failed to authenticate.", {
        // PocketBase keys validation context by field; for login that is the
        // account identity. `data` must never be copied into a detail.
        identity: { code: "validation_invalid_email", message: "Invalid." },
      }),
    ]);
    const adapter = createBeszelAdapter({
      config: { baseUrl: TEST_BASE_URL },
      credentials: { email: TEST_EMAIL, password: TEST_PASSWORD },
      fetchImpl: stub.impl,
    });

    const error = await adapter.listSystems().catch((e: unknown) => e);
    const serialized = JSON.stringify({
      message: (error as Error).message,
      detail: (error as { detail: unknown }).detail,
    });
    expect(serialized).not.toContain(TEST_PASSWORD);
    expect(serialized).not.toContain(TEST_TOKEN);
    expect(serialized).not.toContain(TEST_EMAIL);
    // The provider's own message is useful and safe; `data` is neither.
    expect(serialized).toContain("Failed to authenticate.");
    expect(serialized).not.toContain("validation_invalid_email");
  });

  it("keeps the token out of a detail when an authenticated read fails", async () => {
    const stub = createFetchStub([authOk(), fail(500, "Something went wrong.")]);
    const adapter = createBeszelAdapter({
      config: { baseUrl: TEST_BASE_URL },
      credentials: { email: TEST_EMAIL, password: TEST_PASSWORD },
      fetchImpl: stub.impl,
    });
    const error = await adapter.listSystems().catch((e: unknown) => e);
    expect(JSON.stringify((error as { detail: unknown }).detail)).not.toContain(
      TEST_TOKEN,
    );
  });
});

describe("redactors are allow-lists, not filters", () => {
  it("summarizes a system without its sharing list", () => {
    const summary = redactBeszelSystem(
      systemRecord({ users: ["u1", "u2", "u3"], secretish: "do-not-copy" }),
    );
    expect(summary).toEqual({
      id: "sys_aaaaaaaaaaaaaaa",
      name: "web-01",
      status: "up",
      updated: "2026-08-13 07:00:00.000Z",
      sharedWithCount: 3,
    });
    expect(JSON.stringify(summary)).not.toContain("do-not-copy");
    expect(JSON.stringify(summary)).not.toContain("u1");
  });

  it("summarizes a page by its counters, never by inlining the records", () => {
    const summary = redactBeszelSystemPage(
      page([systemRecord(), systemRecord({ id: "sys_b" })], {
        totalItems: 2,
      }).body,
    );
    expect(summary).toEqual({
      page: 1,
      perPage: 200,
      totalItems: 2,
      totalPages: 1,
      itemCount: 2,
    });
    expect(JSON.stringify(summary)).not.toContain("10.0.0.11");
  });

  it("passes the health body through an allow-list even though it is harmless", () => {
    expect(
      redactBeszelHealth({
        status: 200,
        message: "API is healthy.",
        futureField: "unreviewed",
      }),
    ).toEqual({ status: 200, message: "API is healthy." });
  });

  it("exports no redactor for the login response", () => {
    // `{token, record}` carries a live credential. There is deliberately no
    // function that accepts it, so no run step can ever summarize one.
    const redactors = Object.keys(beszel).filter((name) =>
      name.startsWith("redact"),
    );
    expect(redactors.sort()).toEqual([
      "redactBeszelHealth",
      "redactBeszelSystem",
      "redactBeszelSystemPage",
    ]);
  });
});

describe("no provider response type escapes the boundary", () => {
  it("exports facts and configuration, and nothing PocketBase-shaped", () => {
    // ADR-0009: provider SDK/response shapes stop here. A consumer
    // re-declares what it needs structurally.
    const exported = Object.keys(beszel);
    expect(exported).not.toContain("systemRecordSchema");
    expect(exported).not.toContain("listEnvelopeSchema");
    expect(exported).not.toContain("authResponseSchema");
  });
});
