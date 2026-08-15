/**
 * Boundary tests: the assertions that make "read-only" and "no credential
 * leaks" properties of the code rather than of a review — the same shape
 * Beszel/Dockhand/Tailscale hold. **M1 issues no write verb anywhere, so
 * every recorded call in this suite must be a `GET`** — there is no
 * exception to carve out here, unlike Tailscale's single OAuth exchange.
 */
import { describe, expect, it } from "vitest";
import {
  PANGOLIN_ALLOWED_NON_GET_PATHS,
  PANGOLIN_ALLOWED_PATH_PREFIXES,
  PANGOLIN_API_PREFIX,
  createPangolinAdapter,
  createRateBudget,
  redactPangolinPage,
  redactPangolinResource,
  redactPangolinRule,
  redactPangolinSite,
  redactPangolinSiteCreate,
} from "../src/index.ts";
import * as pangolin from "../src/index.ts";
import {
  TEST_API_KEY_ID,
  TEST_API_KEY_SECRET,
  TEST_BASE_URL,
  TEST_ORG_ID,
  createFetchStub,
  domainRecord,
  dnsRecordRow,
  envelope,
  orgRecord,
  resourceRecord,
  ruleRecord,
  siteRecord,
  targetRecord,
} from "./http.ts";

/** Drive every exported read once. */
async function exerciseEverything() {
  const stub = createFetchStub([
    envelope({ orgs: [orgRecord()], pagination: { total: 1, limit: 1000, offset: 0 } }),
    envelope({ sites: [siteRecord()], pagination: { total: 1, limit: 1000, offset: 0 } }),
    envelope(siteRecord()),
    envelope(siteRecord()),
    envelope({ resources: [resourceRecord()], pagination: { total: 1, limit: 1000, offset: 0 } }),
    envelope(resourceRecord()),
    envelope({ targets: [targetRecord()], pagination: { total: 1, limit: 1000, offset: 0 } }),
    envelope({ rules: [ruleRecord()], pagination: { total: 1, limit: 1000, offset: 0 } }),
    envelope({ domains: [domainRecord()], pagination: { total: 1, limit: 1000, offset: 0 } }),
    envelope({ domains: [domainRecord()], pagination: { total: 1, limit: 1000, offset: 0 } }),
    envelope([dnsRecordRow()]),
    envelope({ sites: [siteRecord()], pagination: { total: 1, limit: 1000, offset: 0 } }),
  ]);
  const adapter = createPangolinAdapter({
    config: { baseUrl: TEST_BASE_URL, orgId: TEST_ORG_ID },
    credentials: { apiKeyId: TEST_API_KEY_ID, apiKeySecret: TEST_API_KEY_SECRET },
    fetchImpl: stub.impl,
    rateBudget: createRateBudget({ capacity: 100, refillPerSecond: 1000 }),
  });
  await adapter.listOrgs();
  await adapter.listSites(TEST_ORG_ID);
  await adapter.getSite("1");
  await adapter.getSite("site-1", TEST_ORG_ID);
  await adapter.listResources(TEST_ORG_ID);
  await adapter.getResource("10");
  await adapter.listTargets("10");
  await adapter.listRules("10");
  await adapter.listDomains(TEST_ORG_ID);
  await adapter.findDomainByBaseName(TEST_ORG_ID, "example.com");
  await adapter.listDomainDnsRecords(TEST_ORG_ID, "example.com");
  await adapter.probe();
  return { stub, adapter };
}

// "create" is deliberately excluded: it collides with the legitimate
// factory export (`createPangolinAdapter`, `CreatePangolinAdapterInput`) —
// too weak a write signal to be worth the false positive, exactly as
// Tailscale's own list excludes "set"/"key" for the same reason.
// `operations.ts`'s empty PANGOLIN_ALLOWED_NON_GET_PATHS is the STRUCTURAL
// guarantee for actual writes; this list is the exported-surface half.
const FORBIDDEN_MEMBER_VERBS = [
  "update",
  "delete",
  "remove",
  "apply",
  "write",
  "disable",
  "enable",
  "retire",
  "mutate",
];

describe("the exported surface exposes no way to mutate a Pangolin instance", () => {
  it("has exactly the read members and no others", () => {
    const stub = createFetchStub([]);
    const adapter = createPangolinAdapter({
      config: { baseUrl: TEST_BASE_URL, orgId: TEST_ORG_ID },
      credentials: { apiKeyId: TEST_API_KEY_ID, apiKeySecret: TEST_API_KEY_SECRET },
      fetchImpl: stub.impl,
    });
    expect(Object.keys(adapter).sort()).toEqual([
      "capabilities",
      "findDomainByBaseName",
      "getResource",
      "getSite",
      "listDomainDnsRecords",
      "listDomains",
      "listOrgs",
      "listResources",
      "listRules",
      "listSites",
      "listTargets",
      "probe",
      "stats",
    ]);
  });

  it("exports no member named after a forbidden verb", () => {
    for (const exported of Object.keys(pangolin)) {
      for (const verb of FORBIDDEN_MEMBER_VERBS) {
        expect(
          exported.toLowerCase().includes(verb),
          `export "${exported}" contains the forbidden verb "${verb}"`,
        ).toBe(false);
      }
    }
  });

  it("declares no non-GET path at all — M1 has no exception to carve out", () => {
    expect([...PANGOLIN_ALLOWED_NON_GET_PATHS]).toEqual([]);
  });

  it("declares only /v1-prefixed path prefixes", () => {
    for (const prefix of PANGOLIN_ALLOWED_PATH_PREFIXES) {
      expect(prefix.startsWith(`${PANGOLIN_API_PREFIX}/`)).toBe(true);
    }
  });
});

describe("every request the adapter actually makes", () => {
  it("is a GET, with zero exceptions", async () => {
    const { stub } = await exerciseEverything();
    const nonGet = stub.calls.filter((call) => call.method !== "GET");
    expect(nonGet).toHaveLength(0);
    expect(stub.calls.length).toBeGreaterThan(0);
  });

  it("uses only paths declared in operations.ts", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      const path = new URL(call.url).pathname;
      const allowed = PANGOLIN_ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
      expect(allowed, `request to undeclared path ${path}`).toBe(true);
    }
  });

  it("never puts a credential in a URL or query string", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      expect(call.url).not.toContain(TEST_API_KEY_SECRET);
      expect(call.url).not.toContain(TEST_API_KEY_ID);
    }
  });

  it("sends the bearer credential only in the Authorization header", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      expect(call.headers["authorization"]).toBe(`Bearer ${TEST_API_KEY_ID}.${TEST_API_KEY_SECRET}`);
      expect(call.body ?? "").not.toContain(TEST_API_KEY_SECRET);
    }
  });
});

describe("no credential can reach an error detail", () => {
  it("keeps the api key out of a detail when an authenticated read fails", async () => {
    const stub = createFetchStub([
      { status: 500, body: { data: null, success: false, error: true, message: "internal error", status: 500 } },
    ]);
    const adapter = createPangolinAdapter({
      config: { baseUrl: TEST_BASE_URL, orgId: TEST_ORG_ID },
      credentials: { apiKeyId: TEST_API_KEY_ID, apiKeySecret: TEST_API_KEY_SECRET },
      fetchImpl: stub.impl,
    });
    const error = await adapter.listOrgs().catch((e: unknown) => e);
    expect(JSON.stringify((error as { detail: unknown }).detail)).not.toContain(TEST_API_KEY_SECRET);
  });
});

describe("redactors are allow-lists, not filters", () => {
  it("omits the newt secret entirely from a site-create summary", () => {
    const summary = redactPangolinSiteCreate({
      siteId: 1,
      niceId: "site-1",
      newtId: "newt-abc",
      secret: "do-not-copy-secret",
    });
    expect(summary).toEqual({ siteId: 1, niceId: "site-1", newtId: "newt-abc", secretOmitted: true });
    expect(JSON.stringify(summary)).not.toContain("do-not-copy-secret");
  });

  it("summarizes a site without its public/private key material", () => {
    const summary = redactPangolinSite(siteRecord());
    expect(JSON.stringify(summary)).not.toContain("do-not-copy-pubkey");
    expect(JSON.stringify(summary)).not.toContain("do-not-copy-publickey");
  });

  it("summarizes a resource carrying sso/emailWhitelistEnabled as presence only", () => {
    const summary = redactPangolinResource(resourceRecord());
    expect(summary["sso"]).toBe(true);
    expect(summary["emailWhitelistEnabled"]).toBe(false);
  });

  it("summarizes a rule without any resourceId leaking beyond what the rule needs", () => {
    const summary = redactPangolinRule(ruleRecord());
    expect(summary).toEqual({ ruleId: 30, action: "ACCEPT", match: "CIDR", priority: 1, enabled: true });
  });

  it("summarizes a page by count, never by inlining the records", () => {
    expect(redactPangolinPage([siteRecord(), siteRecord()])).toEqual({ count: 2 });
  });
});

describe("no provider response type escapes the boundary", () => {
  it("exports facts and configuration, and nothing Pangolin-shaped", () => {
    const exported = Object.keys(pangolin);
    expect(exported).not.toContain("orgSchema");
    expect(exported).not.toContain("siteSchema");
    expect(exported).not.toContain("resourceSchema");
    expect(exported).not.toContain("targetSchema");
    expect(exported).not.toContain("ruleSchema");
    expect(exported).not.toContain("domainSchema");
  });
});
