/**
 * Unit tests for the Pangolin read adapter. Every test injects a
 * deterministic `fetch` stub; nothing here touches the network.
 */
import { describe, expect, it } from "vitest";
import {
  PangolinAdapterError,
  createPangolinAdapter,
  createRateBudget,
  normalizePangolinBaseUrl,
  pangolinKindFromEnvelope,
  pangolinSourceAccountKey,
  parsePangolinAdapterConfig,
  readPangolinEnvelope,
} from "../src/index.ts";
import {
  TEST_API_KEY_ID,
  TEST_API_KEY_SECRET,
  TEST_BASE_URL,
  TEST_ORG_ID,
  createFetchStub,
  domainRecord,
  dnsRecordRow,
  envelope,
  failEnvelope,
  orgRecord,
  resourceRecord,
  ruleRecord,
  siteRecord,
  targetRecord,
} from "./http.ts";

// `null` (not `undefined`) is the "no orgId configured" sentinel here — a
// default PARAMETER value is not applied when the caller explicitly passes
// `undefined`, only when the argument is omitted, so `undefined` cannot be
// used to opt out of the default.
function adapterWith(responses: Parameters<typeof createFetchStub>[0], orgId: string | null = TEST_ORG_ID) {
  const stub = createFetchStub(responses);
  const adapter = createPangolinAdapter({
    config: { baseUrl: TEST_BASE_URL, ...(orgId === null ? {} : { orgId }) },
    credentials: { apiKeyId: TEST_API_KEY_ID, apiKeySecret: TEST_API_KEY_SECRET },
    fetchImpl: stub.impl,
    rateBudget: createRateBudget({ capacity: 100, refillPerSecond: 1000 }),
  });
  return { adapter, stub };
}

describe("base URL and config normalization", () => {
  it("strips a trailing slash", () => {
    expect(normalizePangolinBaseUrl("https://pangolin.example.com/")).toBe("https://pangolin.example.com");
  });

  it("refuses http:, userinfo, a query string, and a fragment", () => {
    for (const bad of [
      "http://pangolin.example.com",
      "https://user:pass@pangolin.example.com",
      "https://pangolin.example.com?x=1",
      "https://pangolin.example.com#frag",
      "not-a-url",
    ]) {
      expect(() => normalizePangolinBaseUrl(bad)).toThrowError(PangolinAdapterError);
    }
  });

  it("has no fixed default base URL — Pangolin is always self-hosted", () => {
    expect(() => parsePangolinAdapterConfig({})).toThrowError(PangolinAdapterError);
  });

  it("orgId is optional; timeoutMs defaults", () => {
    const config = parsePangolinAdapterConfig({ baseUrl: TEST_BASE_URL });
    expect(config.orgId).toBeNull();
    expect(config.timeoutMs).toBe(15_000);
  });
});

describe("source account key", () => {
  it("is the normalized base URL alone — org is not folded in", () => {
    expect(pangolinSourceAccountKey(`${TEST_BASE_URL}/`)).toBe(pangolinSourceAccountKey(TEST_BASE_URL));
  });
});

describe("envelope parsing", () => {
  it("reads success/error/message/status/data", () => {
    const parsed = readPangolinEnvelope({ data: { a: 1 }, success: true, error: false, message: "", status: 200 });
    expect(parsed).toEqual({ success: true, error: false, message: "", status: 200, data: { a: 1 } });
  });

  it("returns nulls for a body that is not envelope-shaped at all", () => {
    expect(readPangolinEnvelope("<html>not json-object</html>")).toEqual({
      success: null,
      error: null,
      message: null,
      status: null,
      data: null,
    });
  });

  it("classifies HTTP 200 with success:false as a failure, never as success", () => {
    const kind = pangolinKindFromEnvelope(200, {
      success: false,
      error: true,
      message: "Unauthorized",
      status: 401,
      data: null,
    });
    // The envelope's own status (401) is authoritative over the transport status (200).
    expect(kind).toBe("auth");
  });
});

describe("listOrgs()", () => {
  it("sends the bearer credential and unwraps data.orgs", async () => {
    const { adapter, stub } = adapterWith([
      envelope({ orgs: [orgRecord()], pagination: { total: 1, limit: 1000, offset: 0 } }),
    ]);
    const orgs = await adapter.listOrgs();
    expect(orgs).toEqual([{ orgId: TEST_ORG_ID, name: "Home Lab" }]);
    expect(stub.calls[0]?.headers["authorization"]).toBe(`Bearer ${TEST_API_KEY_ID}.${TEST_API_KEY_SECRET}`);
    expect(stub.pathOf(0)).toBe("/v1/orgs");
  });

  it("skips one unreadable org instead of losing the whole list", async () => {
    const { adapter } = adapterWith([
      envelope({
        orgs: [orgRecord({ orgId: "good" }), { name: "no id at all" }],
        pagination: { total: 2, limit: 1000, offset: 0 },
      }),
    ]);
    const orgs = await adapter.listOrgs();
    expect(orgs.map((o) => o.orgId)).toEqual(["good"]);
  });

  it("classifies a root-required rejection as auth, matching verifyApiKeyIsRoot's gate", async () => {
    const { adapter } = adapterWith([failEnvelope(403, "Root API key required")]);
    await expect(adapter.listOrgs()).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("listSites()", () => {
  it("maps a site record to Loxep's fact shape", async () => {
    const { adapter, stub } = adapterWith([
      envelope({ sites: [siteRecord()], pagination: { total: 1, limit: 1000, offset: 0 } }),
    ]);
    const sites = await adapter.listSites(TEST_ORG_ID);
    expect(sites).toEqual([
      {
        siteId: 1,
        niceId: "site-1",
        orgId: TEST_ORG_ID,
        name: "home-newt",
        type: "newt",
        online: true,
        address: "10.10.0.2",
        subnet: "10.10.0.0/24",
        endpoint: null,
        listenPort: 51820,
        status: "approved",
      },
    ]);
    expect(stub.pathOf(0)).toBe(`/v1/org/${TEST_ORG_ID}/sites`);
  });

  it("degrades a record missing every optional field to nulls/false, keeping only what parsed", async () => {
    const { adapter } = adapterWith([
      envelope({ sites: [{}], pagination: { total: 1, limit: 1000, offset: 0 } }),
    ]);
    const sites = await adapter.listSites(TEST_ORG_ID);
    expect(sites).toEqual([
      {
        siteId: null,
        niceId: null,
        orgId: null,
        name: null,
        type: null,
        online: false,
        address: null,
        subnet: null,
        endpoint: null,
        listenPort: null,
        status: null,
      },
    ]);
  });
});

describe("getSite(): numeric id vs niceId branching", () => {
  it("calls /site/:siteId for a purely numeric identifier, needing no orgId", async () => {
    const { adapter, stub } = adapterWith([envelope(siteRecord())], null);
    const site = await adapter.getSite("1");
    expect(site?.siteId).toBe(1);
    expect(stub.pathOf(0)).toBe("/v1/site/1");
  });

  it("calls /org/:orgId/site/:niceId for a non-numeric identifier", async () => {
    const { adapter, stub } = adapterWith([envelope(siteRecord())]);
    const site = await adapter.getSite("site-1", TEST_ORG_ID);
    expect(site?.niceId).toBe("site-1");
    expect(stub.pathOf(0)).toBe(`/v1/org/${TEST_ORG_ID}/site/site-1`);
  });

  it("falls back to the connection's configured orgId when none is passed", async () => {
    const { adapter, stub } = adapterWith([envelope(siteRecord())]);
    await adapter.getSite("site-1");
    expect(stub.pathOf(0)).toBe(`/v1/org/${TEST_ORG_ID}/site/site-1`);
  });

  it("refuses a niceId lookup with no orgId anywhere", async () => {
    const { adapter } = adapterWith([], null);
    await expect(adapter.getSite("site-1")).rejects.toMatchObject({ kind: "invalid_request" });
  });

  it("returns null on a not_found rather than throwing", async () => {
    const { adapter } = adapterWith([failEnvelope(404, "no such site")], null);
    await expect(adapter.getSite("999")).resolves.toBeNull();
  });
});

describe("listResources() / getResource()", () => {
  it("maps a resource record, carrying sso/emailWhitelistEnabled as presence booleans", async () => {
    const { adapter } = adapterWith([
      envelope({ resources: [resourceRecord()], pagination: { total: 1, limit: 1000, offset: 0 } }),
    ]);
    const resources = await adapter.listResources(TEST_ORG_ID);
    expect(resources[0]?.sso).toBe(true);
    expect(resources[0]?.emailWhitelistEnabled).toBe(false);
    expect(resources[0]?.mode).toBe("http");
  });

  it("uses the canonical /resource path, not /public-resource", async () => {
    const { adapter, stub } = adapterWith([envelope(resourceRecord())]);
    await adapter.getResource("10");
    expect(stub.pathOf(0)).toBe("/v1/resource/10");
  });
});

describe("listTargets()", () => {
  it("maps a target record", async () => {
    const { adapter, stub } = adapterWith([
      envelope({ targets: [targetRecord()], pagination: { total: 1, limit: 1000, offset: 0 } }),
    ]);
    const targets = await adapter.listTargets("10");
    expect(targets).toEqual([
      {
        targetId: 20,
        resourceId: 10,
        siteId: 1,
        ip: "192.168.1.10",
        port: 3000,
        method: "http",
        mode: "http",
        enabled: true,
        path: null,
        pathMatchType: null,
        priority: 100,
      },
    ]);
    expect(stub.pathOf(0)).toBe("/v1/resource/10/targets");
  });
});

describe("listRules()", () => {
  it("maps a rule record using the API's own vocabulary, unchanged", async () => {
    const { adapter, stub } = adapterWith([
      envelope({ rules: [ruleRecord()], pagination: { total: 1, limit: 1000, offset: 0 } }),
    ]);
    const rules = await adapter.listRules("10");
    expect(rules).toEqual([
      { ruleId: 30, resourceId: 10, action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 1, enabled: true },
    ]);
    expect(stub.pathOf(0)).toBe("/v1/resource/10/rules");
  });
});

describe("listDomains() / findDomainByBaseName()", () => {
  it("maps a domain record", async () => {
    const { adapter } = adapterWith([
      envelope({ domains: [domainRecord()], pagination: { total: 1, limit: 1000, offset: 0 } }),
    ]);
    const domains = await adapter.listDomains(TEST_ORG_ID);
    expect(domains[0]?.baseDomain).toBe("example.com");
    expect(domains[0]?.type).toBe("wildcard");
  });

  it("finds a domain by exact, case-insensitive baseDomain over a LIST call — there is no dedicated endpoint", async () => {
    const { adapter, stub } = adapterWith([
      envelope({ domains: [domainRecord({ baseDomain: "Example.COM" })], pagination: { total: 1, limit: 1000, offset: 0 } }),
    ]);
    const domain = await adapter.findDomainByBaseName(TEST_ORG_ID, "example.com");
    expect(domain?.baseDomain).toBe("Example.COM");
    expect(stub.calls).toHaveLength(1);
    expect(stub.pathOf(0)).toBe(`/v1/org/${TEST_ORG_ID}/domains`);
  });

  it("returns null when no domain matches", async () => {
    const { adapter } = adapterWith([
      envelope({ domains: [domainRecord({ baseDomain: "other.com" })], pagination: { total: 1, limit: 1000, offset: 0 } }),
    ]);
    await expect(adapter.findDomainByBaseName(TEST_ORG_ID, "example.com")).resolves.toBeNull();
  });
});

describe("listDomainDnsRecords()", () => {
  it("unwraps a bare array — the one list endpoint without a pagination wrapper", async () => {
    const { adapter, stub } = adapterWith([envelope([dnsRecordRow()])]);
    const records = await adapter.listDomainDnsRecords(TEST_ORG_ID, "example.com");
    expect(records).toEqual([
      { id: 40, domainId: "example.com", recordType: "A", baseDomain: "example.com", value: "203.0.113.1", verified: true },
    ]);
    expect(stub.pathOf(0)).toBe(`/v1/org/${TEST_ORG_ID}/domain/example.com/dns-records`);
  });
});

describe("probe()", () => {
  it("uses the configured orgId's site list as the cheapest authenticated read", async () => {
    const { adapter, stub } = adapterWith([
      envelope({ sites: [siteRecord(), siteRecord()], pagination: { total: 2, limit: 1000, offset: 0 } }),
    ]);
    await expect(adapter.probe()).resolves.toEqual({ reachable: true, authenticated: true, siteCount: 2 });
    expect(stub.pathOf(0)).toBe(`/v1/org/${TEST_ORG_ID}/sites`);
  });

  it("falls back to /orgs when no orgId is configured", async () => {
    const { adapter, stub } = adapterWith(
      [envelope({ orgs: [orgRecord()], pagination: { total: 1, limit: 1000, offset: 0 } })],
      null,
    );
    await expect(adapter.probe()).resolves.toEqual({ reachable: true, authenticated: true, siteCount: 1 });
    expect(stub.pathOf(0)).toBe("/v1/orgs");
  });

  it("reports reachable but not authenticated on a 401/403, without throwing", async () => {
    const { adapter } = adapterWith([failEnvelope(401, "Unauthorized")]);
    await expect(adapter.probe()).resolves.toEqual({ reachable: true, authenticated: false, siteCount: null });
  });

  it("still throws for a network-level failure", async () => {
    const { adapter } = adapterWith([failEnvelope(503, "down")]);
    await expect(adapter.probe()).rejects.toMatchObject({ kind: "provider_unavailable" });
  });
});

describe("createResource() — PUT /org/:orgId/resource, tier 1", () => {
  it("sends PUT with the payload and returns the created resource fact", async () => {
    const { adapter, stub } = adapterWith([envelope(resourceRecord({ resourceId: 99 }))]);
    const resource = await adapter.createResource(TEST_ORG_ID, {
      name: "dockhand",
      domainId: "example.com",
      subdomain: "dockhand",
      mode: "http",
    });
    expect(resource.resourceId).toBe(99);
    expect(stub.calls[0]?.method).toBe("PUT");
    expect(stub.pathOf(0)).toBe(`/v1/org/${TEST_ORG_ID}/resource`);
    const sentBody = JSON.parse(stub.calls[0]?.body ?? "{}");
    expect(sentBody).toMatchObject({
      name: "dockhand",
      domainId: "example.com",
      subdomain: "dockhand",
      mode: "http",
    });
  });

  it("classifies an envelope failure at HTTP 200 as an error, never a success (RPC envelope, not the transport status)", async () => {
    const { adapter } = adapterWith([
      { status: 200, body: { data: null, success: false, error: true, message: "resource exists", status: 409 } },
    ]);
    await expect(
      adapter.createResource(TEST_ORG_ID, {
        name: "dup",
        domainId: "example.com",
        subdomain: null,
        mode: "http",
      }),
    ).rejects.toMatchObject({ kind: "invalid_request" });
  });

  it("throws provider_unavailable, defensively, when Pangolin creates but returns no readable record", async () => {
    // `resourceSchema` is deliberately permissive (every field optional), so
    // an object that merely lacks the fields this fact wants still parses —
    // the genuinely unreadable case is a response that is not an object at
    // all (`null`, a bare array, a scalar).
    const { adapter } = adapterWith([envelope(null)]);
    await expect(
      adapter.createResource(TEST_ORG_ID, {
        name: "dockhand",
        domainId: "example.com",
        subdomain: "dockhand",
        mode: "http",
      }),
    ).rejects.toMatchObject({ kind: "provider_unavailable" });
  });
});

describe("addTarget() — PUT /resource/:resourceId/target, tier 1", () => {
  it("sends PUT and returns the created target fact", async () => {
    const { adapter, stub } = adapterWith([envelope(targetRecord({ targetId: 55 }))]);
    const target = await adapter.addTarget("10", {
      siteId: "1",
      ip: "192.168.1.10",
      port: 3000,
    });
    expect(target.targetId).toBe(55);
    expect(stub.calls[0]?.method).toBe("PUT");
    expect(stub.pathOf(0)).toBe("/v1/resource/10/target");
    // siteId is coerced to a number when it parses cleanly as one.
    expect(JSON.parse(stub.calls[0]?.body ?? "{}")).toMatchObject({ siteId: 1, ip: "192.168.1.10", port: 3000 });
  });

  it("defensively parses a malformed create response instead of returning a half-built fact", async () => {
    const { adapter } = adapterWith([envelope(null)]);
    await expect(
      adapter.addTarget("10", { siteId: "1", ip: "192.168.1.10", port: 3000 }),
    ).rejects.toMatchObject({ kind: "provider_unavailable" });
  });
});

describe("createRule() — PUT /resource/:resourceId/rule, tier 1, the owner's headline use case", () => {
  it("sends PUT with the full rule payload and returns the created rule fact", async () => {
    const { adapter, stub } = adapterWith([envelope(ruleRecord({ ruleId: 77 }))]);
    const rule = await adapter.createRule("10", {
      action: "ACCEPT",
      match: "PATH",
      value: "/api/auth/session",
      priority: 100,
      enabled: true,
    });
    expect(rule.ruleId).toBe(77);
    expect(stub.calls[0]?.method).toBe("PUT");
    expect(stub.pathOf(0)).toBe("/v1/resource/10/rule");
    expect(JSON.parse(stub.calls[0]?.body ?? "{}")).toEqual({
      action: "ACCEPT",
      match: "PATH",
      value: "/api/auth/session",
      priority: 100,
      enabled: true,
    });
  });

  it("is NOT idempotent from the adapter's own perspective — two calls are two requests", async () => {
    // The adapter issues exactly what it is told; non-idempotency is a
    // property of the PROVIDER (verdict 2), and the ledger
    // (`@loxep/infrastructure`'s `operations.ts`) is what stops a caller
    // from re-issuing this blindly. This test only proves the adapter adds
    // no de-duplication of its own that could mask a real double-create.
    const { adapter, stub } = adapterWith([envelope(ruleRecord({ ruleId: 1 })), envelope(ruleRecord({ ruleId: 2 }))]);
    const payload = { action: "ACCEPT", match: "CIDR", value: "203.0.113.7/32", priority: 1, enabled: true };
    const first = await adapter.createRule("10", payload);
    const second = await adapter.createRule("10", payload);
    expect(first.ruleId).not.toBe(second.ruleId);
    expect(stub.calls).toHaveLength(2);
  });

  it("classifies a 2xx-with-envelope-failure create as an error (the RPC-envelope warning, on a write this time)", async () => {
    const { adapter } = adapterWith([
      { status: 200, body: { data: null, success: false, error: true, message: "invalid rule", status: 400 } },
    ]);
    await expect(
      adapter.createRule("10", { action: "ACCEPT", match: "CIDR", value: "x", priority: 1, enabled: true }),
    ).rejects.toMatchObject({ kind: "invalid_request" });
  });
});

describe("updateRuleEnabled() — POST /resource/:resourceId/rule/:ruleId, the ONE update this milestone ships", () => {
  it("sends POST, not PUT — the inverted verb convention made concrete", async () => {
    const { adapter, stub } = adapterWith([envelope(ruleRecord({ ruleId: 30, enabled: false }))]);
    const rule = await adapter.updateRuleEnabled("10", "30", {
      action: "ACCEPT",
      match: "CIDR",
      value: "203.0.113.7/32",
      priority: 1,
      enabled: false,
    });
    expect(rule.enabled).toBe(false);
    expect(stub.calls[0]?.method).toBe("POST");
    expect(stub.pathOf(0)).toBe("/v1/resource/10/rule/30");
  });

  it("always carries priority, action, match, and value — never a partial {enabled} body", async () => {
    const { adapter, stub } = adapterWith([envelope(ruleRecord())]);
    await adapter.updateRuleEnabled("10", "30", {
      action: "ACCEPT",
      match: "CIDR",
      value: "203.0.113.7/32",
      priority: 7,
      enabled: false,
    });
    const sent = JSON.parse(stub.calls[0]?.body ?? "{}");
    expect(sent).toEqual({
      action: "ACCEPT",
      match: "CIDR",
      value: "203.0.113.7/32",
      priority: 7,
      enabled: false,
    });
  });

  it("classifies a not_found update the same as any other read", async () => {
    const { adapter } = adapterWith([failEnvelope(404, "no such rule")]);
    await expect(
      adapter.updateRuleEnabled("10", "missing", {
        action: "ACCEPT",
        match: "CIDR",
        value: "x",
        priority: 1,
        enabled: false,
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("HTTP 200 does not imply success — the design's binding warning", () => {
  it("classifies a 2xx response whose envelope reports failure as an error, never a success", async () => {
    const stub = createFetchStub([
      { status: 200, body: { data: null, success: false, error: true, message: "Unauthorized", status: 401 } },
    ]);
    const adapter = createPangolinAdapter({
      config: { baseUrl: TEST_BASE_URL, orgId: TEST_ORG_ID },
      credentials: { apiKeyId: TEST_API_KEY_ID, apiKeySecret: TEST_API_KEY_SECRET },
      fetchImpl: stub.impl,
    });
    const error = await adapter.listOrgs().catch((e: unknown) => e);
    expect((error as { kind: string }).kind).toBe("auth");
    expect((error as { detail: Record<string, unknown> }).detail["envelopeFailureOnSuccessStatus"]).toBe(true);
  });

  it("treats a 2xx body that is not envelope-shaped as provider_unavailable, never success", async () => {
    const stub = createFetchStub([{ status: 200, text: "<!DOCTYPE html>not json" }]);
    const adapter = createPangolinAdapter({
      config: { baseUrl: TEST_BASE_URL, orgId: TEST_ORG_ID },
      credentials: { apiKeyId: TEST_API_KEY_ID, apiKeySecret: TEST_API_KEY_SECRET },
      fetchImpl: stub.impl,
    });
    await expect(adapter.listOrgs()).rejects.toMatchObject({ kind: "provider_unavailable" });
  });
});

describe("error taxonomy", () => {
  it("maps statuses onto the five Loxep kinds", async () => {
    const cases: Array<[number, string]> = [
      [400, "invalid_request"],
      [401, "auth"],
      [403, "auth"],
      [404, "not_found"],
      [429, "rate_limited"],
      [500, "provider_unavailable"],
    ];
    for (const [status, kind] of cases) {
      const { adapter } = adapterWith([failEnvelope(status, "nope")]);
      await expect(adapter.listOrgs()).rejects.toMatchObject({ kind });
    }
  });
});

describe("capabilities and construction", () => {
  it("reports readOnly:false from M4 — the adapter can now issue the four tier-1/POST writes", () => {
    const { adapter } = adapterWith([]);
    expect(adapter.capabilities()).toEqual({
      provider: "pangolin",
      readOnly: false,
      bulkRuleSet: false,
      ruleAliases: false,
      ruleDisable: true,
      domainCreate: false,
      siteCreate: true,
      ruleMatches: ["CIDR", "IP", "PATH", "COUNTRY", "COUNTRY_IS_NOT", "ASN", "REGION"],
      ruleActions: ["ACCEPT", "DROP", "PASS"],
    });
  });

  it("refuses an empty api key id or secret", () => {
    const stub = createFetchStub([]);
    expect(() =>
      createPangolinAdapter({
        config: { baseUrl: TEST_BASE_URL },
        credentials: { apiKeyId: "", apiKeySecret: TEST_API_KEY_SECRET },
        fetchImpl: stub.impl,
      }),
    ).toThrowError(PangolinAdapterError);
    expect(() =>
      createPangolinAdapter({
        config: { baseUrl: TEST_BASE_URL },
        credentials: { apiKeyId: TEST_API_KEY_ID, apiKeySecret: "" },
        fetchImpl: stub.impl,
      }),
    ).toThrowError(PangolinAdapterError);
  });
});

describe("rate budget", () => {
  it("refuses rather than queueing forever once the budget is exhausted", async () => {
    const stub = createFetchStub([
      envelope({ orgs: [orgRecord()], pagination: { total: 1, limit: 1000, offset: 0 } }),
      envelope({ orgs: [orgRecord()], pagination: { total: 1, limit: 1000, offset: 0 } }),
    ]);
    const adapter = createPangolinAdapter({
      config: { baseUrl: TEST_BASE_URL, orgId: TEST_ORG_ID },
      credentials: { apiKeyId: TEST_API_KEY_ID, apiKeySecret: TEST_API_KEY_SECRET },
      fetchImpl: stub.impl,
      rateBudget: createRateBudget({ capacity: 1, refillPerSecond: 0.001, maxWaitMs: 5 }),
    });
    await adapter.listOrgs();
    await expect(adapter.listOrgs()).rejects.toMatchObject({
      kind: "rate_limited",
      detail: { source: "local_rate_budget" },
    });
  });
});
