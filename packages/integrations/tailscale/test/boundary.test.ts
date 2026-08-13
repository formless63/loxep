/**
 * Boundary tests: the assertions that make "read-only" and "no credential
 * leaks" properties of the code rather than of a review — the
 * fleet-observability design's "a test per adapter rather than a
 * code-review convention" recommendation, applied here as it was to Beszel
 * and Dockhand.
 */
import { describe, expect, it } from "vitest";
import {
  TAILSCALE_ALLOWED_NON_GET_PATHS,
  TAILSCALE_ALLOWED_PATH_PREFIXES,
  TAILSCALE_OAUTH_TOKEN_PATH,
  createRateBudget,
  createTailscaleAdapter,
  redactTailscaleDevice,
  redactTailscaleDevicePage,
} from "../src/index.ts";
import * as tailscale from "../src/index.ts";
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
  oauthTokenOk,
} from "./http.ts";

/** Drive every exported read, in OAuth mode so the token exchange is covered too. */
async function exerciseEverything() {
  const stub = createFetchStub([
    oauthTokenOk(),
    devicesPage([deviceRecord()]),
    devicesPage([deviceRecord()]),
  ]);
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
  await adapter.listDevices();
  await adapter.probe();
  return { stub, adapter };
}

// "set" and "key" are deliberately excluded: they collide with legitimate
// exports ("parseTailscaleAdapterConfig", "tailscaleSourceAccountKey") and
// are too weak a write signal to be worth the false positive —
// operations.ts's path allow-list is the stronger guarantee for actual writes.
const FORBIDDEN_MEMBER_VERBS = [
  "authorize",
  "deauthorize",
  "delete",
  "remove",
  "expire",
  "update",
  "tag",
  "route",
  "revoke",
  "invite",
  "rename",
];

describe("the exported surface exposes no way to mutate a tailnet", () => {
  it("has exactly the read members and no others", () => {
    const stub = createFetchStub([]);
    const adapter = createTailscaleAdapter({
      config: { tailnet: TEST_TAILNET, baseUrl: TEST_BASE_URL },
      credentials: { mode: "api_access_token", apiAccessToken: TEST_API_ACCESS_TOKEN },
      fetchImpl: stub.impl,
    });
    expect(Object.keys(adapter).sort()).toEqual([
      "capabilities",
      "listDevices",
      "probe",
      "stats",
    ]);
  });

  it("exports no member named after a forbidden verb", () => {
    for (const exported of Object.keys(tailscale)) {
      for (const verb of FORBIDDEN_MEMBER_VERBS) {
        expect(
          exported.toLowerCase().includes(verb),
          `export "${exported}" contains the forbidden verb "${verb}"`,
        ).toBe(false);
      }
    }
  });

  it("declares only tailnet/device/oauth-token path prefixes", () => {
    for (const prefix of TAILSCALE_ALLOWED_PATH_PREFIXES) {
      expect(prefix.startsWith("/api/v2/")).toBe(true);
    }
    expect([...TAILSCALE_ALLOWED_NON_GET_PATHS]).toEqual([
      TAILSCALE_OAUTH_TOKEN_PATH,
    ]);
  });
});

describe("every request the adapter actually makes", () => {
  it("is a GET, except the single documented OAuth token POST", async () => {
    const { stub } = await exerciseEverything();
    const nonGet = stub.calls.filter((call) => call.method !== "GET");
    expect(nonGet).toHaveLength(1);
    expect(new URL(nonGet[0]!.url).pathname).toBe(TAILSCALE_OAUTH_TOKEN_PATH);
  });

  it("uses only paths declared in operations.ts", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      const path = new URL(call.url).pathname;
      const allowed = TAILSCALE_ALLOWED_PATH_PREFIXES.some((prefix) =>
        path.startsWith(prefix),
      );
      expect(allowed, `request to undeclared path ${path}`).toBe(true);
    }
  });

  it("never touches a device-authorize, key, route, or tag path segment", async () => {
    const { stub } = await exerciseEverything();
    const forbiddenSegments = ["authorized", "key", "routes", "tags", "expire"];
    for (const call of stub.calls) {
      const segments = new URL(call.url).pathname.split("/").filter(Boolean);
      for (const segment of segments) {
        expect(forbiddenSegments).not.toContain(segment);
      }
    }
  });

  it("never puts a credential in a URL or query string", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      expect(call.url).not.toContain(TEST_OAUTH_CLIENT_SECRET);
      expect(call.url).not.toContain(TEST_OAUTH_ACCESS_TOKEN);
    }
  });

  it("sends the client secret in exactly one body — the OAuth token exchange", async () => {
    const { stub } = await exerciseEverything();
    const carrying = stub.calls.filter((call) =>
      (call.body ?? "").includes(TEST_OAUTH_CLIENT_SECRET),
    );
    expect(carrying).toHaveLength(1);
    expect(new URL(carrying[0]!.url).pathname).toBe(TAILSCALE_OAUTH_TOKEN_PATH);
  });
});

describe("no credential can reach an error detail", () => {
  it("keeps the access token out of a detail when an authenticated read fails", async () => {
    const stub = createFetchStub([
      { status: 500, body: { message: "internal error" } },
    ]);
    const adapter = createTailscaleAdapter({
      config: { tailnet: TEST_TAILNET, baseUrl: TEST_BASE_URL },
      credentials: { mode: "api_access_token", apiAccessToken: TEST_API_ACCESS_TOKEN },
      fetchImpl: stub.impl,
    });
    const error = await adapter.listDevices().catch((e: unknown) => e);
    expect(JSON.stringify((error as { detail: unknown }).detail)).not.toContain(
      TEST_API_ACCESS_TOKEN,
    );
  });
});

describe("redactors are allow-lists, not filters", () => {
  it("summarizes a device without its owning user identity or key material", () => {
    const summary = redactTailscaleDevice(
      deviceRecord({
        nodeKey: "nodekey:do-not-copy",
        user: "someone@example.com",
      }),
    );
    expect(summary).toEqual({
      nodeId: "n123456CNTRL",
      hostname: "web-01",
      os: "linux",
      connectedToControl: true,
      addressCount: 1,
    });
    expect(JSON.stringify(summary)).not.toContain("someone@example.com");
    expect(JSON.stringify(summary)).not.toContain("do-not-copy");
  });

  it("summarizes a page by count, never by inlining the records", () => {
    expect(redactTailscaleDevicePage([deviceRecord(), deviceRecord()])).toEqual({
      deviceCount: 2,
    });
  });

  it("exports no redactor for the OAuth token response", () => {
    const redactors = Object.keys(tailscale).filter((name) =>
      name.startsWith("redact"),
    );
    expect(redactors.sort()).toEqual([
      "redactTailscaleDevice",
      "redactTailscaleDevicePage",
    ]);
  });
});

describe("no provider response type escapes the boundary", () => {
  it("exports facts and configuration, and nothing Tailscale-shaped", () => {
    const exported = Object.keys(tailscale);
    expect(exported).not.toContain("deviceSchema");
    expect(exported).not.toContain("oauthTokenResponseSchema");
  });
});
