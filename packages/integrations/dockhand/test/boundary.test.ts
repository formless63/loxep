/**
 * Boundary tests: credential containment and the redactor allow-lists.
 *
 * The read-only/lifecycle assertions live in `forbidden-verbs.test.ts`; this
 * file covers the other half of the boundary contract — that nothing this
 * package handles can carry a credential, a PEM private key, or a Hawser token
 * into an error detail, a summary, or a URL.
 */
import { describe, expect, it } from "vitest";
import {
  createDockhandAdapter,
  createRateBudget,
  redactDockhandContainer,
  redactDockhandHost,
  redactDockhandHostPayload,
  redactDockhandStack,
} from "../src/index.ts";
import * as dockhand from "../src/index.ts";
import {
  TEST_BASE_URL,
  TEST_HAWSER_TOKEN,
  TEST_PASSWORD,
  TEST_SESSION,
  TEST_TLS_KEY,
  TEST_USERNAME,
  bareList,
  containerRecord,
  createFetchStub,
  environmentRecord,
  fail,
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

describe("credentials never reach a URL", () => {
  it("keeps the password and session out of every request URL", async () => {
    const { stub, adapter } = makeAdapter([
      loginOk(),
      bareList([environmentRecord()]),
      bareList([containerRecord()]),
    ]);
    await adapter.listHosts();
    await adapter.listContainers({ externalHostId: "1" });
    for (const call of stub.calls) {
      expect(call.url).not.toContain(TEST_PASSWORD);
      expect(call.url).not.toContain(TEST_SESSION);
    }
  });

  it("sends the password in exactly one body — the login exchange", async () => {
    const { stub, adapter } = makeAdapter([loginOk(), bareList([])]);
    await adapter.listHosts();
    const carrying = stub.calls.filter((call) =>
      (call.body ?? "").includes(TEST_PASSWORD),
    );
    expect(carrying).toHaveLength(1);
    expect(new URL(carrying[0]!.url).pathname).toBe("/api/auth/login");
  });

  it("sends the session only in a Cookie header", async () => {
    const { stub, adapter } = makeAdapter([loginOk(), bareList([])]);
    await adapter.listHosts();
    const read = stub.calls[1]!;
    expect(read.headers["cookie"]).toBe(`dockhand_session=${TEST_SESSION}`);
    expect(read.body).toBeNull();
  });
});

describe("no credential can reach an error detail", () => {
  it("keeps the password out of a failed login's detail", async () => {
    const { adapter } = makeAdapter([
      fail(401, "Invalid credentials", `username=${TEST_USERNAME}`),
    ]);
    const error = await adapter.listHosts().catch((e: unknown) => e);
    const serialized = JSON.stringify({
      message: (error as Error).message,
      detail: (error as { detail: unknown }).detail,
    });
    expect(serialized).not.toContain(TEST_PASSWORD);
    expect(serialized).not.toContain(TEST_SESSION);
    // Upstream's `details` is never copied — see src/errors.ts.
    expect(serialized).not.toContain(TEST_USERNAME);
    expect(serialized).toContain("Invalid credentials");
  });

  it("keeps a submitted PEM key out of a failed host create's detail", async () => {
    // The realistic hazard: `details` is undocumented "additional context" and
    // a failed environment create submits a private key.
    const { adapter } = makeAdapter([
      loginOk(),
      fail(400, "Invalid TLS material", `tlsKey rejected: ${TEST_TLS_KEY}`),
    ]);
    const error = await adapter
      .applyHost({
        kind: "create",
        host: {
          name: "vps-new",
          connectionType: "direct",
          host: "10.0.0.1",
          tlsKey: TEST_TLS_KEY,
        },
      })
      .catch((e: unknown) => e);
    const serialized = JSON.stringify((error as { detail: unknown }).detail);
    expect(serialized).not.toContain("zzz-private-key-marker-zzz");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).toContain("providerDetailsOmitted");
  });
});

describe("redactors are allow-lists, not filters", () => {
  it("reduces every secret in a host payload to a presence bit", () => {
    const summary = redactDockhandHostPayload({
      name: "vps-new",
      connectionType: "direct",
      host: "10.0.0.1",
      port: 2376,
      protocol: "https",
      tlsCa: "-----BEGIN CERTIFICATE-----ca-----END CERTIFICATE-----",
      tlsCert: "-----BEGIN CERTIFICATE-----cert-----END CERTIFICATE-----",
      tlsKey: TEST_TLS_KEY,
      hawserToken: TEST_HAWSER_TOKEN,
      tlsSkipVerify: false,
      labels: ["a", "b"],
      publicIp: "203.0.113.1",
      // A field the intent shape does not know about must not survive.
      unknownFuture: "zzz-must-not-appear-zzz",
    });

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("zzz-private-key-marker-zzz");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain("zzz-hawser-token-marker-zzz");
    expect(serialized).not.toContain("zzz-must-not-appear-zzz");

    expect(summary).toEqual({
      name: "vps-new",
      connectionType: "direct",
      host: "10.0.0.1",
      port: 2376,
      protocol: "https",
      socketPath: null,
      tlsCaConfigured: true,
      tlsCertConfigured: true,
      tlsKeyConfigured: true,
      hawserTokenConfigured: true,
      tlsSkipVerify: false,
      labelCount: 2,
      publicIp: "203.0.113.1",
    });
  });

  it("summarizes a host record without its TLS material", () => {
    const summary = redactDockhandHost(environmentRecord());
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("zzz-private-key-marker-zzz");
    expect(serialized).not.toContain("zzz-hawser-token-marker-zzz");
    expect(summary).toMatchObject({
      id: "1",
      name: "vps-fra-01",
      tlsConfigured: true,
      hawserConfigured: true,
    });
  });

  it("summarizes a container without environment variables", () => {
    const summary = redactDockhandContainer(
      containerRecord({
        env: ["DATABASE_URL=postgres://user:zzz-db-password-zzz@db/loxep"],
        labels: { "traefik.http.routers.x.rule": "Host(`x`)" },
      }),
    );
    expect(JSON.stringify(summary)).not.toContain("zzz-db-password-zzz");
    expect(summary).toEqual({
      id: "c0ffee0000",
      name: "loxep-web",
      image: "ghcr.io/loxep/loxep:1.2.3",
      state: "running",
      status: "Up 3 days",
    });
  });

  it("summarizes a stack by counts, not by inlining its containers", () => {
    expect(redactDockhandStack(stackRecord())).toEqual({
      name: "loxep",
      status: "running",
      sourceType: "git",
      containerCount: 2,
    });
  });

  it("exports exactly four redactors and none for a login response", () => {
    const redactors = Object.keys(dockhand)
      .filter((name) => name.startsWith("redact"))
      .sort();
    expect(redactors).toEqual([
      "redactDockhandContainer",
      "redactDockhandHost",
      "redactDockhandHostPayload",
      "redactDockhandStack",
    ]);
  });
});

describe("no provider response type escapes the boundary", () => {
  it("exports facts and configuration, and nothing Dockhand-shaped", () => {
    const exported = Object.keys(dockhand);
    expect(exported).not.toContain("environmentSchema");
    expect(exported).not.toContain("containerSchema");
    expect(exported).not.toContain("stackSchema");
  });

  it("never lets TLS material into a fact even when upstream sends it", async () => {
    const { adapter } = makeAdapter([loginOk(), bareList([environmentRecord()])]);
    const hosts = await adapter.listHosts();
    // The parse schema does not declare tlsKey, so it cannot survive parsing.
    expect(Object.keys(hosts[0]!)).not.toContain("tlsKey");
    expect(Object.keys(hosts[0]!)).not.toContain("hawserToken");
  });
});
