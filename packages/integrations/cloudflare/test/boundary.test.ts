/**
 * The boundary modules on their own: the error taxonomy, config/TTL
 * translation, the rate budget, the redactors, and the dev credential loader.
 *
 * The redactor block is the one the design calls "the single highest-risk line
 * in the design", and the bead's MUST-NOT requires it be asserted by a test
 * rather than by code review: **no token value may reach a
 * `reconcile_run_steps` summary, a `provider_operations` summary, or a job
 * payload.**
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_AUTOMATIC_TTL,
  CLOUDFLARE_ERROR_KINDS,
  CLOUDFLARE_GLOBAL_LIMIT_PER_SECOND,
  CloudflareAdapterError,
  cloudflareKindFromStatus,
  cloudflareSourceAccountKey,
  cloudflareTtlFromLoxep,
  createRateBudget,
  defaultCloudflareEnvFilePath,
  envelopeCodes,
  loadCloudflareCredentialsFromEnvFile,
  loxepTtlFromCloudflare,
  normalizeCloudflareBaseUrl,
  parseCloudflareAdapterConfig,
  readCloudflareEnvelope,
  redactCloudflareDnsRecord,
  redactCloudflareRequest,
  redactCloudflareTokenCreate,
  redactCloudflareZone,
} from "../src/index.ts";

describe("error taxonomy", () => {
  it("carries exactly the five kinds every Loxep adapter carries", () => {
    expect([...CLOUDFLARE_ERROR_KINDS]).toEqual([
      "auth",
      "rate_limited",
      "not_found",
      "invalid_request",
      "provider_unavailable",
    ]);
  });

  it("parses the envelope, including the undocumented error_chain", () => {
    const envelope = readCloudflareEnvelope({
      success: false,
      errors: [
        {
          code: 6003,
          message: "Invalid request headers",
          error_chain: [{ code: 6111, message: "bad header" }],
          documentation_url: "https://developers.cloudflare.com/",
        },
      ],
      messages: [],
      result: null,
    });
    expect(envelope.success).toBe(false);
    expect(envelopeCodes(envelope)).toEqual([6003, 6111]);
    expect(envelope.errors[0]?.documentationUrl).toBe(
      "https://developers.cloudflare.com/",
    );
  });

  it("reports success: null for a body that is not an envelope", () => {
    for (const body of [null, "text", 42, ["a"]]) {
      expect(readCloudflareEnvelope(body).success).toBeNull();
    }
  });

  it("reads result_info for pagination", () => {
    const envelope = readCloudflareEnvelope({
      success: true,
      errors: [],
      messages: [],
      result: [],
      result_info: { page: 2, per_page: 50, count: 3, total_count: 103, total_pages: 3 },
    });
    expect(envelope.resultInfo).toEqual({
      page: 2,
      perPage: 50,
      count: 3,
      totalCount: 103,
      totalPages: 3,
    });
  });

  it("classifies by code first, then by status", () => {
    // A code wins even when the status would say otherwise: 6003/6111 arrive
    // with HTTP 400, and 9106/9107 with 403.
    expect(cloudflareKindFromStatus(400, [6003, 6111])).toBe("auth");
    expect(cloudflareKindFromStatus(403, [9106, 9107])).toBe("auth");
    expect(cloudflareKindFromStatus(400, [7003])).toBe("not_found");
    expect(cloudflareKindFromStatus(401, [])).toBe("auth");
    expect(cloudflareKindFromStatus(429, [])).toBe("rate_limited");
    expect(cloudflareKindFromStatus(404, [])).toBe("not_found");
    expect(cloudflareKindFromStatus(422, [])).toBe("invalid_request");
    expect(cloudflareKindFromStatus(503, [])).toBe("provider_unavailable");
    expect(cloudflareKindFromStatus(undefined, [])).toBe("provider_unavailable");
    // An envelope failure carried on a 2xx is a request problem, not an outage.
    expect(cloudflareKindFromStatus(200, [])).toBe("invalid_request");
  });
});

describe("config", () => {
  it("requires https and refuses a URL that smuggles credentials", () => {
    expect(normalizeCloudflareBaseUrl("https://api.cloudflare.com/client/v4/")).toBe(
      "https://api.cloudflare.com/client/v4",
    );
    for (const bad of [
      "http://api.cloudflare.com/client/v4",
      "https://user:pass@api.cloudflare.com/client/v4",
      "https://api.cloudflare.com/client/v4?token=leak",
      "not-a-url",
    ]) {
      expect(() => normalizeCloudflareBaseUrl(bad)).toThrow(
        CloudflareAdapterError,
      );
    }
  });

  it("reports zod issues as paths and codes, never values", () => {
    let thrown: CloudflareAdapterError | null = null;
    try {
      parseCloudflareAdapterConfig({ apiToken: "" });
    } catch (error) {
      thrown = error as CloudflareAdapterError;
    }
    expect(thrown?.kind).toBe("invalid_request");
    const serialized = JSON.stringify(thrown?.detail);
    expect(serialized).toContain("apiToken");
    expect(serialized).not.toContain("received");
  });

  it("derives a deterministic account key with and without an account id", () => {
    expect(cloudflareSourceAccountKey("acct_1")).toBe("cloudflare:acct_1");
    expect(cloudflareSourceAccountKey(null)).toBe("cloudflare:token-scoped");
    expect(cloudflareSourceAccountKey("")).toBe("cloudflare:token-scoped");
  });

  describe("TTL translation (ADR-0009 #5)", () => {
    it("maps null to the provider sentinel and back", () => {
      expect(cloudflareTtlFromLoxep(null)).toBe(CLOUDFLARE_AUTOMATIC_TTL);
      expect(loxepTtlFromCloudflare(CLOUDFLARE_AUTOMATIC_TTL)).toBeNull();
    });

    it("round-trips a real TTL untouched", () => {
      for (const ttl of [60, 300, 3600, 86_400]) {
        expect(loxepTtlFromCloudflare(cloudflareTtlFromLoxep(ttl))).toBe(ttl);
      }
    });

    it("refuses a TTL outside the provider's own documented range", () => {
      // 30 is the machine-readable minimum but is Enterprise-only per the
      // prose, so Loxep validates against the prose value of 60.
      for (const ttl of [0, 1, 30, 59, 86_401, 1.5]) {
        expect(() => cloudflareTtlFromLoxep(ttl)).toThrow(
          CloudflareAdapterError,
        );
      }
    });

    it("treats a missing or nonsense provider TTL as 'provider default'", () => {
      for (const value of [undefined, null, "300", Number.NaN]) {
        expect(loxepTtlFromCloudflare(value)).toBeNull();
      }
    });
  });
});

describe("rate budget", () => {
  it("exposes Cloudflare's documented per-user ceiling", () => {
    // 1200 requests per five minutes.
    expect(CLOUDFLARE_GLOBAL_LIMIT_PER_SECOND).toBeCloseTo(4, 6);
  });

  it("acquires from a full bucket without waiting", async () => {
    const budget = createRateBudget({ capacity: 3, refillPerSecond: 1 });
    await budget.acquire();
    await budget.acquire();
    expect(budget.stats().acquired).toBe(2);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(false);
  });

  it("refuses rather than waiting past maxWaitMs, and consumes nothing", async () => {
    const budget = createRateBudget({
      capacity: 1,
      refillPerSecond: 0.01,
      maxWaitMs: 10,
    });
    await budget.acquire();
    await expect(budget.acquire()).rejects.toMatchObject({
      kind: "rate_limited",
      detail: { source: "local_rate_budget" },
    });
    expect(budget.stats().rejected).toBe(1);
  });

  it("validates its own construction and cost arguments", () => {
    expect(() => createRateBudget({ capacity: 0, refillPerSecond: 1 })).toThrow(
      CloudflareAdapterError,
    );
    expect(() => createRateBudget({ capacity: 1, refillPerSecond: 0 })).toThrow(
      CloudflareAdapterError,
    );
    const budget = createRateBudget({ capacity: 2, refillPerSecond: 1 });
    expect(() => budget.tryAcquire(3)).toThrow(CloudflareAdapterError);
  });
});

describe("redactors", () => {
  const TOKEN_VALUE = "v1.0-SECRET-TOKEN-VALUE-THAT-MUST-NEVER-BE-LOGGED";

  it("NEVER passes a created token's value into a summary", () => {
    const response = {
      id: "tok_1",
      name: "loxep host token",
      status: "active",
      // The one Cloudflare response that contains a long-lived credential.
      value: TOKEN_VALUE,
      policies: [{ id: "p1" }, { id: "p2" }],
      condition: {},
      expires_on: null,
    };
    const summary = redactCloudflareTokenCreate(response);
    expect(summary).toEqual({
      tokenId: "tok_1",
      name: "loxep host token",
      status: "active",
      policyCount: 2,
      valueOmitted: true,
    });
    expect(JSON.stringify(summary)).not.toContain(TOKEN_VALUE);
  });

  it("is an allow-list, so a renamed secret field still cannot escape", () => {
    // The failure mode an omit-list has and an allow-list does not.
    const summary = redactCloudflareTokenCreate({
      id: "tok_2",
      secret_value: TOKEN_VALUE,
      token: TOKEN_VALUE,
      value: TOKEN_VALUE,
    });
    expect(JSON.stringify(summary)).not.toContain(TOKEN_VALUE);
  });

  it("projects a zone without its unreviewed fields", () => {
    expect(
      redactCloudflareZone({
        id: "z1",
        name: "example.test",
        status: "active",
        account: { id: "acct_1", name: "Test" },
        name_servers: ["a", "b"],
        meta: { phishing_detected: false },
        owner: { email: "someone@example.test" },
      }),
    ).toEqual({
      zoneId: "z1",
      name: "example.test",
      status: "active",
      accountId: "acct_1",
      nameserverCount: 2,
    });
  });

  it("keeps record content (public data) but drops operator free text", () => {
    const summary = redactCloudflareDnsRecord({
      id: "r1",
      type: "A",
      name: "example.test",
      content: "203.0.113.10",
      ttl: 1,
      proxied: true,
      proxiable: true,
      comment: "pasted something private here by mistake",
      tags: ["team:ops"],
    });
    expect(summary["content"]).toBe("203.0.113.10");
    expect(summary["comment"]).toBeUndefined();
    expect(summary["tags"]).toBeUndefined();
  });

  it("summarizes a request by path, never by URL", () => {
    const summary = redactCloudflareRequest({
      operation: "dns.records.create",
      method: "POST",
      path: "/zones/z1/dns_records",
    });
    expect(summary).toEqual({
      operation: "dns.records.create",
      method: "POST",
      path: "/zones/z1/dns_records",
    });
  });
});

describe("dev credential loader", () => {
  it("names the documented path", () => {
    expect(defaultCloudflareEnvFilePath()).toMatch(
      /\.config\/loxep\/cloudflare\.env$/,
    );
  });

  it("returns null when the file is absent, so tests skip cleanly", () => {
    expect(
      loadCloudflareCredentialsFromEnvFile(
        join(tmpdir(), "loxep-absent-cloudflare-env-file"),
      ),
    ).toBeNull();
  });

  it("parses tokens, comments, and quotes without echoing content on error", () => {
    const dir = mkdtempSync(join(tmpdir(), "loxep-cf-"));
    const good = join(dir, "good.env");
    writeFileSync(
      good,
      [
        "# a comment",
        "",
        'CLOUDFLARE_API_TOKEN="tok_value"',
        "CLOUDFLARE_ACCOUNT_ID=acct_1",
        "CLOUDFLARE_TEST_ZONE=example.test",
      ].join("\n"),
    );
    expect(loadCloudflareCredentialsFromEnvFile(good)).toEqual({
      apiToken: "tok_value",
      accountId: "acct_1",
      testZone: "example.test",
    });

    const missing = join(dir, "missing.env");
    writeFileSync(missing, "CLOUDFLARE_ACCOUNT_ID=acct_1\n");
    expect(() => loadCloudflareCredentialsFromEnvFile(missing)).toThrow(
      /missing CLOUDFLARE_API_TOKEN/,
    );

    const malformed = join(dir, "bad.env");
    writeFileSync(malformed, "this is not a key=value line at all\n");
    let thrown: CloudflareAdapterError | null = null;
    try {
      loadCloudflareCredentialsFromEnvFile(malformed);
    } catch (error) {
      thrown = error as CloudflareAdapterError;
    }
    expect(thrown?.detail["line"]).toBe(1);
    expect(JSON.stringify(thrown?.detail)).not.toContain("not a key");
  });
});
