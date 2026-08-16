/**
 * Boundary tests: the assertions that make "GET-only except an exact,
 * enumerable write set" a property of the code rather than of a review —
 * the same shape Beszel/Dockhand/Tailscale hold. **THIS FILE EVOLVED IN
 * M4** (`loxep-acj.4`): M1/M2 asserted every request was a `GET` with zero
 * exceptions; M4 narrows that to "every request is a GET, OR one of exactly
 * four declared write shapes, and DELETE is never reachable through any
 * path" — dockhand's forbidden-verbs file (`THE SURFACE` / `THE TRAFFIC`
 * split) is the explicit template.
 */
import { describe, expect, it } from "vitest";
import {
  PANGOLIN_ALLOWED_PATH_PREFIXES,
  PANGOLIN_ALLOWED_WRITE_SHAPES,
  PANGOLIN_API_PREFIX,
  createPangolinAdapter,
  createRateBudget,
  isAllowedPangolinWrite,
  redactPangolinPage,
  redactPangolinResource,
  redactPangolinRule,
  redactPangolinSite,
  redactPangolinSiteCreate,
  redactPangolinTarget,
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

/** Drive every exported read AND every exported write once. */
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
    // The four writes, in the same order `exerciseEverything` drives them.
    envelope(resourceRecord({ resourceId: 101 })),
    envelope(targetRecord({ targetId: 201 })),
    envelope(ruleRecord({ ruleId: 301 })),
    envelope(ruleRecord({ ruleId: 30, enabled: false })),
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
  await adapter.createResource(TEST_ORG_ID, {
    name: "dockhand",
    domainId: "example.com",
    subdomain: "dockhand",
    mode: "http",
  });
  await adapter.addTarget("10", { siteId: "1", ip: "192.168.1.10", port: 3000 });
  await adapter.createRule("10", {
    action: "ACCEPT",
    match: "PATH",
    value: "/api/auth/session",
    priority: 100,
    enabled: true,
  });
  await adapter.updateRuleEnabled("10", "30", {
    action: "ACCEPT",
    match: "CIDR",
    value: "203.0.113.7/32",
    priority: 1,
    enabled: false,
  });
  return { stub, adapter };
}

// "create" is deliberately excluded: it collides with the legitimate
// factory export (`createPangolinAdapter`, `CreatePangolinAdapterInput`)
// AND with the three legitimate M4 create methods — too weak a write
// signal to be worth the false positive, exactly as Tailscale's own list
// excludes "set"/"key" for the same reason. "update" and "enable" are
// likewise dropped from M4 on: `updateRuleEnabled` is the one legitimate
// update this milestone ships, and its name necessarily contains both.
// What stays forbidden, permanently, is the vocabulary of a VERB THIS
// PACKAGE MUST NEVER GAIN: delete/remove (no delete verb, ever — the
// design's rule 5) and disable/retire as a standalone METHOD NAME (the
// disable-not-delete precedent — retirement is `updateRuleEnabled` carrying
// `enabled: false`, never a same-named verb of its own).
// `operations.ts`'s closed `PANGOLIN_ALLOWED_WRITE_SHAPES` is the
// STRUCTURAL guarantee for actual traffic; this list is the
// exported-surface half.
// "write" is deliberately excluded too: it collides with the legitimate
// `PANGOLIN_ALLOWED_WRITE_SHAPES` export, which NAMES the write surface
// rather than being one — the structural guarantee lives in the shapes'
// contents (asserted below), not in avoiding the word "write" in an export
// name.
const FORBIDDEN_MEMBER_VERBS = ["delete", "remove", "apply", "disable", "retire", "mutate"];

describe("THE SURFACE: the exported surface exposes exactly four writes, and DELETE never", () => {
  it("has exactly the read members plus the four M4 writes, and no others", () => {
    const stub = createFetchStub([]);
    const adapter = createPangolinAdapter({
      config: { baseUrl: TEST_BASE_URL, orgId: TEST_ORG_ID },
      credentials: { apiKeyId: TEST_API_KEY_ID, apiKeySecret: TEST_API_KEY_SECRET },
      fetchImpl: stub.impl,
    });
    expect(Object.keys(adapter).sort()).toEqual([
      "addTarget",
      "capabilities",
      "createResource",
      "createRule",
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
      "updateRuleEnabled",
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

  it("declares exactly four write shapes — three PUT creates and one POST update", () => {
    expect(PANGOLIN_ALLOWED_WRITE_SHAPES).toHaveLength(4);
    expect(PANGOLIN_ALLOWED_WRITE_SHAPES.map((s) => s.method).sort()).toEqual([
      "POST",
      "PUT",
      "PUT",
      "PUT",
    ]);
    expect(PANGOLIN_ALLOWED_WRITE_SHAPES.map((s) => s.label).sort()).toEqual([
      "resource.create",
      "rule.create",
      "rule.update_enabled",
      "target.create",
    ]);
  });

  it("declares only /v1-prefixed path prefixes", () => {
    for (const prefix of PANGOLIN_ALLOWED_PATH_PREFIXES) {
      expect(prefix.startsWith(`${PANGOLIN_API_PREFIX}/`)).toBe(true);
    }
  });

  it("never allows DELETE against any declared write shape's path — structurally, not by omission", () => {
    const examplePaths = [
      `/v1/org/${TEST_ORG_ID}/resource`,
      "/v1/resource/10/target",
      "/v1/resource/10/rule",
      "/v1/resource/10/rule/30",
    ];
    for (const path of examplePaths) {
      expect(isAllowedPangolinWrite("DELETE", path), `DELETE ${path} must never be allowed`).toBe(false);
    }
    // And no shape's OWN method is ever "DELETE" — the closed set itself.
    expect(PANGOLIN_ALLOWED_WRITE_SHAPES.some((s) => (s.method as string) === "DELETE")).toBe(false);
  });

  it("refuses a write to a path outside the four declared shapes, even with an allowed method", () => {
    // A resource UPDATE (POST /resource/:id, no /rule/:ruleId suffix) and a
    // SITE create (PUT /org/:orgId/site) are both real Pangolin routes this
    // adapter does not implement — proving the guard checks the whole
    // shape, not merely "PUT somewhere under /org/" or "POST somewhere
    // under /resource/".
    expect(isAllowedPangolinWrite("POST", `/v1/resource/10`)).toBe(false);
    expect(isAllowedPangolinWrite("PUT", `/v1/org/${TEST_ORG_ID}/site`)).toBe(false);
    expect(isAllowedPangolinWrite("PUT", `/v1/org/${TEST_ORG_ID}/domain`)).toBe(false);
  });
});

describe("THE TRAFFIC: what actually leaves the boundary", () => {
  it("is a GET, or exactly one of the four declared write shapes — nothing else", async () => {
    const { stub } = await exerciseEverything();
    const writes = stub.calls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => call.method)).toEqual(["PUT", "PUT", "PUT", "POST"]);
    for (const call of writes) {
      const path = new URL(call.url).pathname;
      expect(
        isAllowedPangolinWrite(call.method, path),
        `write ${call.method} ${path} is outside the declared write shapes`,
      ).toBe(true);
    }
    expect(stub.calls.length).toBeGreaterThan(writes.length);
  });

  it("issues the writes at the exact expected paths, in order", async () => {
    const { stub } = await exerciseEverything();
    const writes = stub.calls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => new URL(call.url).pathname)).toEqual([
      `/v1/org/${TEST_ORG_ID}/resource`,
      "/v1/resource/10/target",
      "/v1/resource/10/rule",
      "/v1/resource/10/rule/30",
    ]);
  });

  it("never issues a DELETE, ever, across the whole exported surface", async () => {
    const { stub } = await exerciseEverything();
    expect(stub.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("uses only paths declared in operations.ts", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      const path = new URL(call.url).pathname;
      const allowed =
        PANGOLIN_ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
        isAllowedPangolinWrite(call.method, path);
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

  it("sends the bearer credential only in the Authorization header, never in a write body", async () => {
    const { stub } = await exerciseEverything();
    for (const call of stub.calls) {
      expect(call.headers["authorization"]).toBe(`Bearer ${TEST_API_KEY_ID}.${TEST_API_KEY_SECRET}`);
      expect(call.body ?? "").not.toContain(TEST_API_KEY_SECRET);
      expect(call.body ?? "").not.toContain(TEST_API_KEY_ID);
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

  it("summarizes a rule without any resourceId leaking beyond what the rule needs, INCLUDING value", () => {
    const summary = redactPangolinRule(ruleRecord());
    // `value` is allow-listed, not a secret — M4's read-back resolution
    // matches on `(action, match, value, priority)`, so a reviewer of a
    // `reconcile_run_steps` row needs to see it to audit what a rule grants.
    expect(summary).toEqual({
      ruleId: 30,
      action: "ACCEPT",
      match: "CIDR",
      value: "203.0.113.7/32",
      priority: 1,
      enabled: true,
    });
  });

  it("summarizes a target with no secret material — none exists on a target", () => {
    const summary = redactPangolinTarget(targetRecord());
    expect(summary).toEqual({
      targetId: 20,
      siteId: 1,
      ip: "192.168.1.10",
      port: 3000,
      method: "http",
      enabled: true,
      priority: 100,
    });
    expect(JSON.stringify(summary)).not.toContain("do-not-copy-authtoken");
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
