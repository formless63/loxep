/**
 * The Cloudflare adapter against a stubbed `fetch`: the real request path,
 * envelope handling, pagination, name and TTL translation, apply semantics,
 * and the taxonomy — with no network.
 *
 * The three behaviors this file exists to pin down, all named as hazards by
 * the binding design:
 *
 *  1. **HTTP 200 does not imply success** on an envelope-shaped API.
 *  2. **The TTL sentinel `1` never crosses the boundary** in either
 *     direction — ADR-0009 #5.
 *  3. **`proxied` on a non-proxiable type is refused, not degraded**, because
 *     silent degradation publishes an origin address the operator believes is
 *     hidden.
 */
import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_AUTOMATIC_TTL,
  createCloudflareAdapter,
  createRateBudget,
  toLoxepName,
  toProviderName,
} from "../src/index.ts";
import type { DnsApplyOperation } from "../src/index.ts";
import {
  createFailingFetchStub,
  createFetchStub,
  fail,
  ok,
  recordPayload,
  rejection,
  TEST_ACCOUNT_ID,
  TEST_TOKEN,
  TEST_ZONE_ID,
  TEST_ZONE_NAME,
  zonePayload,
  type FetchStub,
} from "./http.ts";

function makeAdapter(stub: FetchStub, overrides: Record<string, unknown> = {}) {
  return createCloudflareAdapter({
    apiToken: TEST_TOKEN,
    accountId: TEST_ACCOUNT_ID,
    fetchImpl: stub.impl,
    // Fast and permissive: rate-budget behavior has its own suite.
    rateBudget: createRateBudget({ capacity: 100, refillPerSecond: 1000 }),
    ...overrides,
  });
}

const SUBJECT = { externalZoneId: TEST_ZONE_ID, zoneName: TEST_ZONE_NAME };

describe("name translation", () => {
  it("maps the Loxep apex and wildcard onto complete provider names", () => {
    expect(toProviderName("@", "example.test")).toBe("example.test");
    expect(toProviderName("*", "example.test")).toBe("*.example.test");
    expect(toProviderName("www", "example.test")).toBe("www.example.test");
  });

  it("is idempotent when handed an already-complete name", () => {
    expect(toProviderName("www.example.test", "example.test")).toBe(
      "www.example.test",
    );
    expect(toProviderName("example.test", "example.test")).toBe("example.test");
  });

  it("round-trips back to the zone-relative form the natural key uses", () => {
    for (const name of ["@", "*", "www", "key1._domainkey"]) {
      expect(
        toLoxepName(toProviderName(name, "example.test"), "example.test"),
      ).toBe(name);
    }
  });
});

describe("authentication and transport", () => {
  it("sends the token as a bearer header and never in the URL", async () => {
    const stub = createFetchStub([ok([zonePayload()], { total_pages: 1 })]);
    await makeAdapter(stub).listZones();

    const call = stub.calls[0];
    expect(call?.headers["authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
    expect(call?.url.includes(TEST_TOKEN)).toBe(false);
    expect(stub.pathOf(0)).toBe("/client/v4/zones");
  });

  it("normalizes a transport failure to provider_unavailable without the request", async () => {
    const stub = createFailingFetchStub(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ENOTFOUND" },
      }),
    );
    const error = await rejection(makeAdapter(stub).listZones());
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["causeCode"]).toBe("ENOTFOUND");
    expect(JSON.stringify(error.detail).includes(TEST_TOKEN)).toBe(false);
  });

  it("classifies an abort as provider_unavailable", async () => {
    const stub = createFailingFetchStub(
      Object.assign(new Error("aborted"), { name: "TimeoutError" }),
    );
    const error = await rejection(makeAdapter(stub).listZones());
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["errorName"]).toBe("TimeoutError");
  });
});

describe("the envelope, not the status code", () => {
  it("REJECTS a 200 whose envelope reports success: false", async () => {
    const stub = createFetchStub([
      {
        status: 200,
        body: {
          success: false,
          errors: [{ code: 1004, message: "DNS Validation Error" }],
          messages: [],
          result: null,
        },
      },
    ]);
    const error = await rejection(makeAdapter(stub).listZones());
    expect(error.detail["envelopeFailureOnSuccessStatus"]).toBe(true);
    expect(error.detail["providerErrors"]).toEqual([
      { code: 1004, message: "DNS Validation Error" },
    ]);
  });

  it("rejects a 200 whose body is not an envelope at all", async () => {
    const stub = createFetchStub([
      { text: "<html>origin unreachable</html>", contentType: "text/html" },
    ]);
    const error = await rejection(makeAdapter(stub).listZones());
    expect(error.detail["providerBodyShape"]).toBe("not-a-cloudflare-envelope");
  });

  it("surfaces the chained error Cloudflare returns but never documents", async () => {
    const stub = createFetchStub([
      fail(400, [
        {
          code: 6003,
          message: "Invalid request headers",
          error_chain: [
            { code: 6111, message: "Invalid format for Authorization header" },
          ],
        },
      ]),
    ]);
    const error = await rejection(makeAdapter(stub).listZones());
    // 6003/6111 are auth codes even though the status is 400.
    expect(error.kind).toBe("auth");
    expect(error.detail["providerErrors"]).toEqual([
      {
        code: 6003,
        message: "Invalid request headers",
        chain: [
          { code: 6111, message: "Invalid format for Authorization header" },
        ],
      },
    ]);
  });

  it("maps 403 to auth, 404 to not_found, and 500 to provider_unavailable", async () => {
    const cases: Array<[number, string]> = [
      [403, "auth"],
      [404, "not_found"],
      [500, "provider_unavailable"],
    ];
    for (const [status, kind] of cases) {
      const stub = createFetchStub([fail(status, [])]);
      const error = await rejection(makeAdapter(stub).getZone(TEST_ZONE_ID));
      expect(error.kind).toBe(kind);
    }
  });

  it("reports a provider 429 as rate_limited and keeps retry-after", async () => {
    const stub = createFetchStub([
      { status: 429, body: {}, headers: { "retry-after": "42" } },
    ]);
    const error = await rejection(makeAdapter(stub).listZones());
    expect(error.kind).toBe("rate_limited");
    expect(error.detail["source"]).toBe("provider");
    expect(error.detail["retryAfterSeconds"]).toBe("42");
  });
});

describe("listZones", () => {
  it("filters by name and account, and walks pages using result_info", async () => {
    const stub = createFetchStub([
      ok([zonePayload({ id: "z1", name: "a.test" })], {
        page: 1,
        total_pages: 2,
      }),
      ok([zonePayload({ id: "z2", name: "b.test" })], {
        page: 2,
        total_pages: 2,
      }),
    ]);
    const zones = await makeAdapter(stub).listZones({ name: "a.test" });

    expect(zones.map((zone) => zone.externalZoneId)).toEqual(["z1", "z2"]);
    expect(stub.queryOf(0)["name"]).toEqual(["a.test"]);
    expect(stub.queryOf(0)["account.id"]).toEqual([TEST_ACCOUNT_ID]);
    // Zones cap at 50 per page, unlike DNS records.
    expect(stub.queryOf(0)["per_page"]).toEqual(["50"]);
    expect(stub.queryOf(1)["page"]).toEqual(["2"]);
  });

  it("keeps the provider status string verbatim rather than mapping it", async () => {
    const stub = createFetchStub([
      ok([zonePayload({ status: "pending" })], { total_pages: 1 }),
    ]);
    const [zone] = await makeAdapter(stub).listZones();
    expect(zone?.status).toBe("pending");
    expect(zone?.nameservers).toEqual([
      "ns1.cloudflare.test",
      "ns2.cloudflare.test",
    ]);
    expect(zone?.accountId).toBe(TEST_ACCOUNT_ID);
  });

  it("tolerates a status outside the documented enum", async () => {
    // `deleted`/`deactivated` are NOT in Cloudflare's published enum, so the
    // adapter must not treat an unknown value as a parse failure.
    const stub = createFetchStub([
      ok([zonePayload({ status: "deactivated" })], { total_pages: 1 }),
    ]);
    const [zone] = await makeAdapter(stub).listZones();
    expect(zone?.status).toBe("deactivated");
  });

  it("finds a zone by exact name and returns null when absent", async () => {
    const present = createFetchStub([
      ok([zonePayload()], { total_pages: 1 }),
    ]);
    expect(
      (await makeAdapter(present).findZoneByName(TEST_ZONE_NAME))
        ?.externalZoneId,
    ).toBe(TEST_ZONE_ID);

    const absent = createFetchStub([ok([], { total_pages: 1 })]);
    expect(await makeAdapter(absent).findZoneByName("nope.test")).toBeNull();
  });
});

describe("read()", () => {
  it("returns Loxep facts: relative names and a NULL automatic TTL", async () => {
    const stub = createFetchStub([
      ok(
        [
          recordPayload({ id: "r1", name: TEST_ZONE_NAME, ttl: 1 }),
          recordPayload({
            id: "r2",
            name: `www.${TEST_ZONE_NAME}`,
            ttl: 300,
            proxied: false,
          }),
          recordPayload({
            id: "r3",
            type: "TXT",
            name: `_acme-challenge.${TEST_ZONE_NAME}`,
            content: "token",
            ttl: 120,
            proxied: false,
            proxiable: false,
          }),
        ],
        { total_pages: 1 },
      ),
    ]);
    const records = await makeAdapter(stub).read(SUBJECT);

    expect(records.map((record) => record.name)).toEqual([
      "@",
      "www",
      "_acme-challenge",
    ]);
    // The sentinel is translated exactly once, here.
    expect(records[0]?.ttlSeconds).toBeNull();
    expect(records[1]?.ttlSeconds).toBe(300);
    expect(records[2]?.proxiable).toBe(false);
    expect(stub.pathOf(0)).toBe(`/client/v4/zones/${TEST_ZONE_ID}/dns_records`);
    expect(stub.queryOf(0)["per_page"]).toEqual(["100"]);
  });

  it("stops paging when a short page arrives with no result_info", async () => {
    const stub = createFetchStub([ok([recordPayload()])]);
    const records = await makeAdapter(stub).read(SUBJECT);
    expect(records).toHaveLength(1);
    expect(stub.calls).toHaveLength(1);
  });

  it("fails loudly when the result is not a collection", async () => {
    const stub = createFetchStub([ok({ id: "not-an-array" })]);
    const error = await rejection(makeAdapter(stub).read(SUBJECT));
    expect(error.kind).toBe("provider_unavailable");
  });
});

describe("apply()", () => {
  it("creates with a complete name and the automatic TTL sentinel", async () => {
    const stub = createFetchStub([ok(recordPayload({ id: "new" }))]);
    const operations: DnsApplyOperation[] = [
      {
        kind: "create",
        record: {
          type: "A",
          name: "@",
          content: "203.0.113.10",
          ttlSeconds: null,
          priority: null,
          proxied: true,
        },
      },
    ];
    const results = await makeAdapter(stub).apply({ ...SUBJECT, operations });

    expect(stub.calls[0]?.method).toBe("POST");
    expect(stub.bodyOf(0)).toEqual({
      type: "A",
      name: TEST_ZONE_NAME,
      content: "203.0.113.10",
      ttl: CLOUDFLARE_AUTOMATIC_TTL,
      proxied: true,
    });
    expect(results).toEqual([
      {
        kind: "create",
        type: "A",
        name: "@",
        status: "applied",
        externalRecordId: "new",
      },
    ]);
  });

  it("uses PUT (documented 'Overwrite'), not PATCH, for an update", async () => {
    const stub = createFetchStub([ok(recordPayload({ id: "r1" }))]);
    await makeAdapter(stub).apply({
      ...SUBJECT,
      operations: [
        {
          kind: "update",
          externalRecordId: "r1",
          record: {
            type: "A",
            name: "www",
            content: "203.0.113.11",
            ttlSeconds: 300,
            priority: null,
            proxied: false,
          },
        },
      ],
    });
    expect(stub.calls[0]?.method).toBe("PUT");
    expect(stub.pathOf(0)).toBe(
      `/client/v4/zones/${TEST_ZONE_ID}/dns_records/r1`,
    );
    expect(stub.bodyOf(0)["ttl"]).toBe(300);
  });

  it("sends priority only when the record carries one", async () => {
    const stub = createFetchStub([ok(recordPayload({ id: "mx" }))]);
    await makeAdapter(stub).apply({
      ...SUBJECT,
      operations: [
        {
          kind: "create",
          record: {
            type: "MX",
            name: "@",
            content: "mail.provider.test",
            ttlSeconds: null,
            priority: 10,
            proxied: false,
          },
        },
      ],
    });
    const body = stub.bodyOf(0);
    expect(body["priority"]).toBe(10);
    // MX is not proxiable, so `proxied` is omitted rather than sent as false.
    expect("proxied" in body).toBe(false);
  });

  it("REFUSES to proxy a non-proxiable type rather than degrading silently", async () => {
    const stub = createFetchStub([]);
    const error = await rejection(
      makeAdapter(stub).apply({
        ...SUBJECT,
        operations: [
          {
            kind: "create",
            record: {
              type: "TXT",
              name: "@",
              content: "v=spf1 -all",
              ttlSeconds: null,
              priority: null,
              proxied: true,
            },
          },
        ],
      }),
    );
    expect(error.kind).toBe("invalid_request");
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects a TTL outside the provider's documented range", async () => {
    const stub = createFetchStub([]);
    for (const ttlSeconds of [1, 30, 86_401]) {
      const error = await rejection(
        makeAdapter(stub).apply({
          ...SUBJECT,
          operations: [
            {
              kind: "create",
              record: {
                type: "A",
                name: "@",
                content: "203.0.113.10",
                ttlSeconds,
                priority: null,
                proxied: false,
              },
            },
          ],
        }),
      );
      expect(error.kind).toBe("invalid_request");
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("treats a replayed create as convergence, not failure", async () => {
    // At-least-once delivery: the same apply can run twice. 81057 is
    // empirically observed, never documented (see errors.ts).
    const stub = createFetchStub([
      fail(400, [{ code: 81_057, message: "The record already exists." }]),
    ]);
    const results = await makeAdapter(stub).apply({
      ...SUBJECT,
      operations: [
        {
          kind: "create",
          record: {
            type: "A",
            name: "@",
            content: "203.0.113.10",
            ttlSeconds: null,
            priority: null,
            proxied: false,
          },
        },
      ],
    });
    expect(results[0]?.status).toBe("already_present");
  });

  it("treats a replayed delete as convergence, not failure", async () => {
    const stub = createFetchStub([fail(404, [])]);
    const results = await makeAdapter(stub).apply({
      ...SUBJECT,
      operations: [
        {
          kind: "delete",
          externalRecordId: "gone",
          record: { type: "A", name: "@", content: "203.0.113.10" },
        },
      ],
    });
    expect(results[0]?.status).toBe("already_absent");
  });

  it("accepts the bare {result:{id}} body Cloudflare documents for DELETE", async () => {
    // Documented without the success/errors envelope, unlike every other
    // endpoint — and UNVERIFIED against a live account. Both shapes work.
    const bare = createFetchStub([{ status: 200, body: { result: { id: "r1" } } }]);
    const enveloped = createFetchStub([ok({ id: "r1" })]);
    for (const stub of [bare, enveloped]) {
      const results = await makeAdapter(stub).apply({
        ...SUBJECT,
        operations: [
          {
            kind: "delete",
            externalRecordId: "r1",
            record: { type: "A", name: "@", content: "203.0.113.10" },
          },
        ],
      });
      expect(results[0]?.status).toBe("applied");
    }
  });

  it("applies operations in order and stops at the first real failure", async () => {
    const stub = createFetchStub([
      ok(recordPayload({ id: "first" })),
      fail(500, [{ code: 1000, message: "boom" }]),
    ]);
    const record = {
      type: "A",
      name: "@",
      content: "203.0.113.10",
      ttlSeconds: null,
      priority: null,
      proxied: false,
    };
    const error = await rejection(
      makeAdapter(stub).apply({
        ...SUBJECT,
        operations: [
          { kind: "create", record },
          { kind: "create", record: { ...record, name: "www" } },
          { kind: "create", record: { ...record, name: "api" } },
        ],
      }),
    );
    expect(error.kind).toBe("provider_unavailable");
    // The third operation was never attempted.
    expect(stub.calls).toHaveLength(2);
  });
});

describe("capabilities()", () => {
  it("reports proxying, wildcards, and the certificate depth honestly", () => {
    const stub = createFetchStub([]);
    const capabilities = makeAdapter(stub).capabilities();
    expect(capabilities).toEqual({
      provider: "cloudflare",
      proxying: true,
      proxiableTypes: ["A", "AAAA", "CNAME"],
      // Verified 2026-08-13: available on ALL plans. This changed.
      proxiedWildcards: true,
      wildcardRecords: true,
      automaticTtl: true,
      minTtlSeconds: 60,
      maxTtlSeconds: 86_400,
      // Universal SSL covers the apex and ONE label of subdomain.
      automaticCertificateLabelDepth: 1,
    });
  });
});

describe("stats()", () => {
  it("never exposes the token", async () => {
    const stub = createFetchStub([ok([zonePayload()], { total_pages: 1 })]);
    const adapter = makeAdapter(stub);
    await adapter.listZones();
    const stats = adapter.stats();
    expect(stats.requests).toBe(1);
    expect(stats.sourceAccountKey).toBe(`cloudflare:${TEST_ACCOUNT_ID}`);
    expect(JSON.stringify(stats).includes(TEST_TOKEN)).toBe(false);
  });
});
