/**
 * The Purelymail adapter against a stubbed `fetch`: the real request path, the
 * envelope, fact mapping, and the taxonomy — with no network.
 *
 * The behaviors this file exists to pin down, all named as hazards by the
 * binding design or by the source's own module docs:
 *
 *  1. **HTTP 200 does not imply success.** For Cloudflare that warning was
 *     defensive; here it is the PRIMARY path and it is live-verified — an
 *     unauthenticated call answers HTTP 200 with
 *     `{"type":"error","code":"invalidToken"}`. An adapter that branched on
 *     `response.ok` would call that a success and then fail somewhere
 *     downstream on a missing field. That is the central test below.
 *  2. **An envelope error with an unrecognized code is `invalid_request`, not
 *     `provider_unavailable`.** The provider answered, understood, and refused;
 *     a retry would fail identically, so it must not look transient to a
 *     reconciler that backs off and tries again.
 *  3. **The operation NAME is the entire protocol surface.** Purelymail is
 *     RPC-shaped: `POST /api/v0/<name>`, JSON body, always. A wrong name is a
 *     one-line fix in `PURELYMAIL_OPERATIONS` and presents as an HTML 404 — so
 *     the map is asserted here as a table, name by name.
 *  4. **The field-name asymmetries are real traps.** `updateDomainSettings`
 *     takes `name` where every other operation takes `domainName`; `createUser`
 *     takes a LOCAL PART plus a domain while `deleteUser` takes the FULL
 *     address. Both are asserted rather than trusted.
 *
 * Credential containment has its own file (`boundary.test.ts`); what is
 * asserted here is only the transport half — that the token is a header and
 * appears in no URL, query string, or body.
 */
import { describe, expect, it } from "vitest";
import {
  PURELYMAIL_API_PREFIX,
  PURELYMAIL_DEFAULT_BASE_URL,
  PURELYMAIL_LIST_USER_LIMIT,
  PURELYMAIL_OPERATIONS,
  PURELYMAIL_TOKEN_HEADER,
  PurelymailAdapterError,
  createPurelymailAdapter,
  createRateBudget,
  normalizePurelymailBaseUrl,
  purelymailFullAddress,
  purelymailPath,
} from "../src/index.ts";
import type { PurelymailAdapter, PurelymailOperation } from "../src/index.ts";
import {
  createFailingFetchStub,
  createFetchStub,
  documentedOk,
  domainPayload,
  fail,
  htmlNotFound,
  ok,
  rejection,
  routingRulePayload,
  TEST_DOMAIN,
  TEST_OWNERSHIP_CODE,
  TEST_TOKEN,
  type FetchStub,
} from "./http.ts";

function makeAdapter(
  stub: FetchStub,
  overrides: Record<string, unknown> = {},
): PurelymailAdapter {
  return createPurelymailAdapter({
    apiToken: TEST_TOKEN,
    fetchImpl: stub.impl,
    // Fast and permissive: rate-budget behavior has its own block below.
    rateBudget: createRateBudget({ capacity: 100, refillPerSecond: 1000 }),
    ...overrides,
  });
}

/**
 * Every adapter method, with the operation it must use and a response that
 * satisfies it. Table-driven so a renamed or re-pointed method fails once, in
 * a named row, rather than silently calling the wrong RPC.
 */
interface Invocation {
  label: string;
  operation: PurelymailOperation;
  response: ReturnType<typeof ok>;
  run: (adapter: PurelymailAdapter) => Promise<unknown>;
}

const INVOCATIONS: Invocation[] = [
  {
    label: "getOwnershipCode",
    operation: "domain.ownershipCode",
    response: ok({ code: TEST_OWNERSHIP_CODE }),
    run: (adapter) => adapter.getOwnershipCode(),
  },
  {
    label: "addDomain",
    operation: "domain.add",
    response: ok({}),
    run: (adapter) => adapter.addDomain(TEST_DOMAIN),
  },
  {
    label: "listDomains",
    operation: "domain.list",
    response: ok({ domains: [domainPayload()] }),
    run: (adapter) => adapter.listDomains(),
  },
  {
    label: "recheckDomainDns",
    operation: "domain.updateSettings",
    response: ok({}),
    run: (adapter) => adapter.recheckDomainDns(TEST_DOMAIN),
  },
  {
    label: "createUser",
    operation: "user.create",
    response: ok({}),
    run: (adapter) =>
      adapter.createUser({
        userName: "postmaster",
        domainName: TEST_DOMAIN,
        password: "unit-test-not-a-real-password",
      }),
  },
  {
    label: "deleteUser",
    operation: "user.delete",
    response: ok({}),
    run: (adapter) =>
      adapter.deleteUser(purelymailFullAddress("postmaster", TEST_DOMAIN)),
  },
  {
    label: "listUsers",
    operation: "user.list",
    response: ok({ users: [`postmaster@${TEST_DOMAIN}`] }),
    run: (adapter) => adapter.listUsers(),
  },
  {
    label: "listRoutingRules",
    operation: "routing.list",
    response: ok({ rules: [routingRulePayload()] }),
    run: (adapter) => adapter.listRoutingRules(),
  },
  {
    label: "createRoutingRule",
    operation: "routing.create",
    response: ok({}),
    run: (adapter) =>
      adapter.createRoutingRule({
        domainName: TEST_DOMAIN,
        matchUser: "abuse",
        targetAddresses: [`ops@${TEST_DOMAIN}`],
      }),
  },
  {
    label: "deleteRoutingRule",
    operation: "routing.delete",
    response: ok({}),
    run: (adapter) => adapter.deleteRoutingRule(4_815_162_342),
  },
  {
    label: "checkAccountCredit",
    operation: "account.credit",
    response: ok({ credit: "12.34" }),
    run: (adapter) => adapter.checkAccountCredit(),
  },
];

/** Operations that take no arguments and must therefore send `{}`. */
const ARGUMENT_LESS: Invocation[] = INVOCATIONS.filter((invocation) =>
  (
    [
      "domain.ownershipCode",
      "user.list",
      "routing.list",
      "account.credit",
    ] as PurelymailOperation[]
  ).includes(invocation.operation),
);

describe("the operation map is the whole protocol surface", () => {
  it("carries all nineteen names from the published OpenAPI document", () => {
    // Transcribed from `window.swaggerSpec` at
    // news.purelymail.com/api/swagger-spec.js (info.version "0.0.1", nineteen
    // paths) on 2026-08-13. Written out here rather than counted from the
    // source, so a name that changes has to change in two places and a reviewer
    // sees the provider's spelling next to Loxep's label.
    expect({ ...PURELYMAIL_OPERATIONS }).toEqual({
      "domain.add": "addDomain",
      "domain.ownershipCode": "getOwnershipCode",
      "domain.list": "listDomains",
      "domain.updateSettings": "updateDomainSettings",
      "domain.delete": "deleteDomain",
      "user.create": "createUser",
      "user.delete": "deleteUser",
      "user.list": "listUser",
      "user.modify": "modifyUser",
      "user.get": "getUser",
      "passwordReset.upsert": "upsertPasswordReset",
      "passwordReset.delete": "deletePasswordReset",
      "passwordReset.list": "listPasswordReset",
      "routing.create": "createRoutingRule",
      "routing.delete": "deleteRoutingRule",
      "routing.list": "listRoutingRules",
      "appPassword.create": "createAppPassword",
      "appPassword.delete": "deleteAppPassword",
      "account.credit": "checkAccountCredit",
    });
    expect(Object.keys(PURELYMAIL_OPERATIONS)).toHaveLength(19);
    // Including the ones Loxep deliberately does not call. Present-but-unused
    // is obvious; missing is invisible — and `createAppPassword` in particular
    // is the one Purelymail response documented to return a credential, so it
    // is listed next to that warning rather than transcribed afresh later.
    for (const operation of [
      "domain.delete",
      "user.modify",
      "user.get",
      "passwordReset.upsert",
      "passwordReset.delete",
      "passwordReset.list",
      "appPassword.create",
      "appPassword.delete",
    ] as PurelymailOperation[]) {
      expect(PURELYMAIL_OPERATIONS[operation]).toBeTypeOf("string");
    }
  });

  it("spells `listUser` singular, unlike every other list operation", () => {
    // The provider's own inconsistency, and the kind of thing a tidying edit
    // would "correct" into a 404. `listDomains` and `listRoutingRules` are
    // plural; `listUser` is not.
    expect(PURELYMAIL_OPERATIONS["user.list"]).toBe("listUser");
    expect(PURELYMAIL_OPERATIONS["domain.list"]).toBe("listDomains");
    expect(PURELYMAIL_OPERATIONS["routing.list"]).toBe("listRoutingRules");
  });

  it("puts every operation under /api/v0, with no path parameter anywhere", () => {
    // There is nothing to interpolate anywhere in this API: no ids in paths, no
    // query strings, no verbs but POST. A path is a constant string, which is
    // what makes this map the only place a protocol mistake can live.
    expect(PURELYMAIL_API_PREFIX).toBe("/api/v0");
    for (const operation of Object.keys(
      PURELYMAIL_OPERATIONS,
    ) as PurelymailOperation[]) {
      expect(purelymailPath(operation)).toBe(
        `/api/v0/${PURELYMAIL_OPERATIONS[operation]}`,
      );
      expect(purelymailPath(operation)).toMatch(/^\/api\/v0\/[A-Za-z]+$/);
    }
  });

  it("routes every adapter method to the exact path its operation names", async () => {
    // The table. A method re-pointed at the wrong RPC fails on its own row
    // here, with the label in the diff, rather than by returning plausible
    // nonsense somewhere downstream.
    const routed: Array<[string, string]> = [];
    for (const invocation of INVOCATIONS) {
      const stub = createFetchStub([invocation.response]);
      await invocation.run(makeAdapter(stub));
      routed.push([invocation.label, stub.pathOf(0)]);
    }
    expect(routed).toEqual([
      ["getOwnershipCode", "/api/v0/getOwnershipCode"],
      ["addDomain", "/api/v0/addDomain"],
      ["listDomains", "/api/v0/listDomains"],
      ["recheckDomainDns", "/api/v0/updateDomainSettings"],
      ["createUser", "/api/v0/createUser"],
      ["deleteUser", "/api/v0/deleteUser"],
      ["listUsers", "/api/v0/listUser"],
      ["listRoutingRules", "/api/v0/listRoutingRules"],
      ["createRoutingRule", "/api/v0/createRoutingRule"],
      ["deleteRoutingRule", "/api/v0/deleteRoutingRule"],
      ["checkAccountCredit", "/api/v0/checkAccountCredit"],
    ]);
    // And the same paths, derived rather than typed, so the map and the
    // adapter cannot drift apart in the same direction.
    expect(routed.map(([, path]) => path)).toEqual(
      INVOCATIONS.map((invocation) => purelymailPath(invocation.operation)),
    );
  });
});

describe("authentication and transport", () => {
  it("sends the token in the Purelymail-Api-Token header, and in no other", async () => {
    // This provider uses a bespoke header. An `Authorization: Bearer` copied
    // from the Cloudflare adapter would be silently ignored and every call
    // would come back as an HTTP 200 invalidToken — a failure that looks like a
    // bad credential rather than like a bad header.
    const stub = createFetchStub([ok({ credit: "0.00" })]);
    await makeAdapter(stub).checkAccountCredit();
    expect(PURELYMAIL_TOKEN_HEADER).toBe("Purelymail-Api-Token");
    expect(stub.calls[0]?.headers["purelymail-api-token"]).toBe(TEST_TOKEN);
    expect(stub.calls[0]?.headers["authorization"]).toBeUndefined();
  });

  it("puts the token in NO url, query string, or body, for any operation", async () => {
    // Structural containment: the token cannot reach a log field, an error, or
    // a run-step summary if the only place it is ever written is one header.
    for (const invocation of INVOCATIONS) {
      const stub = createFetchStub([invocation.response]);
      await invocation.run(makeAdapter(stub));
      const call = stub.calls[0];
      expect(call?.url.includes(TEST_TOKEN)).toBe(false);
      expect(call?.body?.includes(TEST_TOKEN) ?? false).toBe(false);
      expect(stub.queryOf(0)).toEqual({});
    }
  });

  it("POSTs a JSON object body to every operation, without exception", async () => {
    // No GET, no path parameters, no query strings, no verbs but POST. That
    // uniformity is what makes the operation map the only place a mistake can
    // live, so it is asserted for every method rather than sampled.
    for (const invocation of INVOCATIONS) {
      const stub = createFetchStub([invocation.response]);
      await invocation.run(makeAdapter(stub));
      expect(stub.calls[0]?.method).toBe("POST");
      expect(stub.calls[0]?.headers["content-type"]).toBe("application/json");
      expect(stub.calls[0]?.headers["accept"]).toBe("application/json");
      expect(stub.bodyOf(0)).toBeTypeOf("object");
    }
  });

  it("sends `{}` rather than an empty body for the argument-less operations", async () => {
    // `EmptyRequest` in the published document: the several operations that
    // take no arguments still take a JSON object. A zero-length body would be a
    // different request, and this API has no GET to fall back on.
    for (const invocation of ARGUMENT_LESS) {
      const stub = createFetchStub([invocation.response]);
      await invocation.run(makeAdapter(stub));
      expect([invocation.label, stub.rawBodyOf(0)]).toEqual([
        invocation.label,
        "{}",
      ]);
    }
  });

  it("defaults to the provider's own base URL and honors a proxied one", async () => {
    // servers[1] in the published document is the provider's own dev server;
    // an absolute URL is accepted so a self-hosted or proxied deployment stays
    // possible, and a trailing slash never doubles the path separator.
    const first = createFetchStub([ok({ credit: "0.00" })]);
    const adapter = makeAdapter(first);
    expect(adapter.baseUrl).toBe(PURELYMAIL_DEFAULT_BASE_URL);
    await adapter.checkAccountCredit();
    expect(first.calls[0]?.url).toBe(
      "https://purelymail.com/api/v0/checkAccountCredit",
    );

    const second = createFetchStub([ok({ credit: "0.00" })]);
    await makeAdapter(second, {
      baseUrl: "https://mail-proxy.internal.test/",
    }).checkAccountCredit();
    expect(second.calls[0]?.url).toBe(
      "https://mail-proxy.internal.test/api/v0/checkAccountCredit",
    );
  });

  it("refuses a base URL that smuggles credentials, a query string, or a fragment", () => {
    // Each of these is operator-inflicted rather than reachable from the
    // connection model, and each fails in a way that looks like a provider
    // problem rather than like a typo:
    //
    //   userinfo   makes `fetch` emit its own Basic Authorization header — a
    //              credential this adapter never chose to send;
    //   query      the adapter concatenates base + path, so `?x=1` swallows
    //              the path and EVERY call silently hits `/` instead;
    //   fragment   is never sent over the wire at all, so its presence means
    //              the value is not what its author believes it is.
    for (const bad of [
      "https://user:pass@purelymail.com",
      "https://purelymail.com/?token=leak",
      "https://purelymail.com/#anchor",
    ]) {
      expect(() => normalizePurelymailBaseUrl(bad)).toThrowError(
        PurelymailAdapterError,
      );
    }

    // The legitimate shapes still pass, including a proxied host with a path.
    expect(normalizePurelymailBaseUrl("https://purelymail.com/")).toBe(
      "https://purelymail.com",
    );
    expect(
      normalizePurelymailBaseUrl("https://mail-proxy.internal.test/purelymail"),
    ).toBe("https://mail-proxy.internal.test/purelymail");
  });

  it("normalizes a transport failure to provider_unavailable without the request", async () => {
    const stub = createFailingFetchStub(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ENOTFOUND" },
      }),
    );
    const error = await rejection(makeAdapter(stub).listUsers());
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["causeCode"]).toBe("ENOTFOUND");
    expect(JSON.stringify(error.detail).includes(TEST_TOKEN)).toBe(false);
  });

  it("classifies a timeout or abort as provider_unavailable", async () => {
    for (const name of ["AbortError", "TimeoutError"]) {
      const stub = createFailingFetchStub(
        Object.assign(new Error("aborted"), { name }),
      );
      const error = await rejection(makeAdapter(stub).listUsers());
      expect(error.kind).toBe("provider_unavailable");
      expect(error.detail["errorName"]).toBe(name);
    }
  });

  it("survives a non-Error thrown from beneath the adapter", async () => {
    const stub = createFailingFetchStub("a string, somehow");
    const error = await rejection(makeAdapter(stub).listUsers());
    expect(error.kind).toBe("provider_unavailable");
    expect(error.message).toMatch(/non-Error value/);
  });
});

describe("THE CENTRAL TEST: the envelope, not the status code", () => {
  it("throws `auth` for an HTTP 200 carrying {type:'error',code:'invalidToken'}", async () => {
    // LIVE-VERIFIED 2026-08-13 against
    // POST https://purelymail.com/api/v0/checkAccountCredit with no token:
    //   200 {"type":"error","code":"invalidToken","message":"Token not valid."}
    // If this test ever passes by returning a value instead of throwing, the
    // adapter is treating an unauthenticated call as a success.
    const stub = createFetchStub([
      fail("invalidToken", "Token not valid."),
    ]);
    const error = await rejection(makeAdapter(stub).checkAccountCredit());
    expect(error.kind).toBe("auth");
    expect(error.detail["httpStatus"]).toBe(200);
    expect(error.detail["providerCode"]).toBe("invalidToken");
    expect(error.detail["providerMessage"]).toBe("Token not valid.");
    // Recorded positively so a run step shows WHY a 200 was rejected, rather
    // than leaving a reader to wonder whether the adapter misclassified a
    // healthy response.
    expect(error.detail["envelopeFailureOnSuccessStatus"]).toBe(true);
  });

  it("classifies the OTHER live invalidToken message identically", async () => {
    // The second probe's wording — "Token must be supplied in
    // Purelymail-Api-Token header" — arrives when the header is missing rather
    // than wrong. Same code, same 200, and it must not be classified by the
    // message text.
    const stub = createFetchStub([
      fail("invalidToken", "Token must be supplied in Purelymail-Api-Token header"),
    ]);
    const error = await rejection(makeAdapter(stub).listDomains());
    expect(error.kind).toBe("auth");
  });

  it("throws `invalid_request` for an HTTP 200 error with an unrecognized code", async () => {
    // The provider understood the request and refused it. Calling that an
    // outage would make the reconciler retry a call that will never succeed —
    // a retry would fail identically, so it must not look transient.
    const stub = createFetchStub([fail("somethingElse", "nope")]);
    const error = await rejection(makeAdapter(stub).listDomains());
    expect(error.kind).toBe("invalid_request");
    expect(error.detail["providerCode"]).toBe("somethingElse");
    expect(error.detail["envelopeFailureOnSuccessStatus"]).toBe(true);
  });

  it("throws `not_found` for the UNVERIFIED absence codes, at HTTP 200", async () => {
    // Nothing depends on these for correctness — the read-back paths answer
    // from a LIST call rather than by interpreting an error code — but a more
    // precise kind is worth having while it is right.
    for (const code of ["noSuchUser", "noSuchDomain"]) {
      const stub = createFetchStub([fail(code, "no such thing")]);
      const error = await rejection(
        makeAdapter(stub).deleteUser(`ghost@${TEST_DOMAIN}`),
      );
      expect(error.kind).toBe("not_found");
    }
  });

  it("accepts a body with `result` and no `type` as a success", async () => {
    // The shape the published OpenAPI document describes for every 200. The
    // live API sends `type` as well; tolerating both means a future removal of
    // the discriminator degrades to the documented contract instead of failing
    // every call.
    const stub = createFetchStub([documentedOk({ credit: "5.00" })]);
    expect(await makeAdapter(stub).checkAccountCredit()).toBe("5.00");
  });

  it("does NOT invent a success for a 200 with neither `type` nor `result`", async () => {
    const stub = createFetchStub([{ status: 200, body: { credit: "5.00" } }]);
    const error = await rejection(makeAdapter(stub).checkAccountCredit());
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["providerBodyShape"]).toBe(
      "not-a-purelymail-envelope",
    );
  });

  it("rejects a 200 whose body is not JSON, and a 200 with no body at all", async () => {
    // A proxy interposing an HTML error page, or a truncated response. Nothing
    // about the request is known to be wrong, so neither is blamed on the
    // caller — both are `provider_unavailable`.
    for (const spec of [
      { status: 200, text: "<html>origin unreachable</html>", contentType: "text/html" },
      { status: 200, text: "" },
    ]) {
      const stub = createFetchStub([spec]);
      const error = await rejection(makeAdapter(stub).listUsers());
      expect(error.kind).toBe("provider_unavailable");
      expect(error.detail["providerBodyShape"]).toBe(
        "not-a-purelymail-envelope",
      );
    }
  });

  it("classifies the HTML 404 of a wrong operation name as not_found", async () => {
    // LIVE-VERIFIED: an unknown path answers 404 with an HTML page rather than
    // an envelope — exactly how a typo in PURELYMAIL_OPERATIONS presents. The
    // status wins over the missing envelope here, by design: `not_found` says
    // "this path does not exist", which is the true diagnosis, where
    // `provider_unavailable` would suggest waiting and retrying.
    const stub = createFetchStub([htmlNotFound()]);
    const error = await rejection(makeAdapter(stub).listDomains());
    expect(error.kind).toBe("not_found");
    expect(error.detail["httpStatus"]).toBe(404);
    expect(error.detail["providerBodyShape"]).toBe(
      "not-a-purelymail-envelope",
    );
  });

  it("refuses a `type: success` carried on a non-2xx status", async () => {
    // Never observed, and it would mean the response cannot be trusted either
    // way — so it fails rather than being taken at its word.
    const stub = createFetchStub([{ status: 500, body: { type: "success", result: {} } }]);
    const error = await rejection(makeAdapter(stub).addDomain(TEST_DOMAIN));
    expect(error.kind).toBe("provider_unavailable");
  });

  it("falls back to the status when the body carries no envelope code", async () => {
    const cases: Array<[number, string]> = [
      [401, "auth"],
      [403, "auth"],
      [400, "invalid_request"],
      [422, "invalid_request"],
      [500, "provider_unavailable"],
      [503, "provider_unavailable"],
    ];
    for (const [status, kind] of cases) {
      const stub = createFetchStub([{ status, body: {} }]);
      const error = await rejection(makeAdapter(stub).listUsers());
      expect([status, error.kind]).toEqual([status, kind]);
    }
  });

  it("reports a provider 429 as rate_limited and keeps retry-after verbatim", async () => {
    // Purelymail publishes no API rate limit at all, so a 429 is surfaced with
    // whatever the provider said rather than used to mutate the local bucket,
    // which describes a limit this adapter does not own — and an absent
    // retry-after is left absent rather than filled in with a guess.
    const withHeader = createFetchStub([
      { status: 429, body: {}, headers: { "retry-after": "42" } },
    ]);
    const first = await rejection(makeAdapter(withHeader).listUsers());
    expect(first.kind).toBe("rate_limited");
    expect(first.detail["source"]).toBe("provider");
    expect(first.detail["retryAfterSeconds"]).toBe("42");

    const without = createFetchStub([{ status: 429, body: {} }]);
    const second = await rejection(makeAdapter(without).listUsers());
    expect(second.kind).toBe("rate_limited");
    expect("retryAfterSeconds" in second.detail).toBe(false);
  });
});

describe("domains", () => {
  it("maps a provider domain onto a Loxep fact", async () => {
    const stub = createFetchStub([
      ok({
        domains: [
          domainPayload({
            name: "alpha.test",
            symbolicSubaddressing: true,
            // Purelymail warns that anyone controlling this domain's DNS could
            // then recover the ACCOUNT password. Loxep never turns it on; the
            // fact is surfaced so an operator can see that it is off.
            allowAccountReset: false,
          }),
        ],
      }),
    ]);
    const [domain] = await makeAdapter(stub).listDomains();
    expect(domain).toEqual({
      name: "alpha.test",
      allowAccountReset: false,
      symbolicSubaddressing: true,
      isShared: false,
      dns: { passesMx: true, passesSpf: true, passesDkim: true, passesDmarc: true },
    });
  });

  it("reads every absent or non-boolean flag as false, never as healthy", async () => {
    // A missing check is "not proven", never "fine". Defaulting the other way
    // would let the reconciler declare a domain healthy because the provider
    // said nothing about it — and a truthy non-boolean (`"yes"`, `1`) must not
    // sneak past as a pass either.
    const stub = createFetchStub([
      ok({
        domains: [
          { name: "bare.test" },
          { name: "odd.test", dnsSummary: { passesMx: "yes", passesSpf: 1 } },
        ],
      }),
    ]);
    const [bare, odd] = await makeAdapter(stub).listDomains();
    expect(bare?.dns).toEqual({
      passesMx: false,
      passesSpf: false,
      passesDkim: false,
      passesDmarc: false,
    });
    expect(bare?.allowAccountReset).toBe(false);
    expect(bare?.symbolicSubaddressing).toBe(false);
    expect(bare?.isShared).toBe(false);
    expect(odd?.dns.passesMx).toBe(false);
    expect(odd?.dns.passesSpf).toBe(false);
  });

  it("excludes Purelymail's shared domains unless asked, and flags them when asked", async () => {
    const stub = createFetchStub([
      ok({ domains: [] }),
      ok({ domains: [domainPayload({ name: "purelymail.com", isShared: true })] }),
    ]);
    const adapter = makeAdapter(stub);
    await adapter.listDomains();
    expect(stub.bodyOf(0)).toEqual({ includeShared: false });

    const [shared] = await adapter.listDomains({ includeShared: true });
    expect(stub.bodyOf(1)).toEqual({ includeShared: true });
    // Loxep never manages a provider-owned shared domain, so the fact has to
    // carry enough for a caller to leave it alone.
    expect(shared?.isShared).toBe(true);
  });

  it("fails loudly on a nameless domain or a `domains` that is not an array", async () => {
    const nameless = createFetchStub([ok({ domains: [{ isShared: false }] })]);
    const first = await rejection(makeAdapter(nameless).listDomains());
    expect(first.kind).toBe("provider_unavailable");
    expect(first.detail["field"]).toBe("name");

    const notAList = createFetchStub([ok({ domains: { name: "not-a-list" } })]);
    const second = await rejection(makeAdapter(notAList).listDomains());
    expect(second.kind).toBe("provider_unavailable");
    expect(second.detail["field"]).toBe("domains");
  });

  it("finds a domain by EXACT name and returns null when it is absent", async () => {
    // The read-back path that resolves a `pending` addDomain without a blind
    // retry. Absence is read from a LIST — more trustworthy than interpreting
    // an unverified error code — and a subdomain must not satisfy the lookup.
    const present = createFetchStub([
      ok({ domains: [domainPayload({ name: "alpha.test" }), domainPayload()] }),
    ]);
    expect(
      (await makeAdapter(present).findDomainByName(TEST_DOMAIN))?.name,
    ).toBe(TEST_DOMAIN);

    const absent = createFetchStub([ok({ domains: [domainPayload()] })]);
    expect(await makeAdapter(absent).findDomainByName("absent.test")).toBeNull();

    const subdomain = createFetchStub([
      ok({ domains: [domainPayload({ name: `mail.${TEST_DOMAIN}` })] }),
    ]);
    expect(await makeAdapter(subdomain).findDomainByName(TEST_DOMAIN)).toBeNull();
  });

  it("sends {domainName} when registering a domain", async () => {
    const stub = createFetchStub([ok({})]);
    await makeAdapter(stub).addDomain(TEST_DOMAIN);
    expect(stub.bodyOf(0)).toEqual({ domainName: TEST_DOMAIN });
  });

  it("recheckDomainDns sends `name`, NOT `domainName`, and nothing else", async () => {
    // The one operation in this API whose domain field is called `name`. Send
    // `domainName` instead and `updateDomainSettings` silently no-ops: the call
    // succeeds, nothing is rechecked, and the reconciler waits forever on a
    // verification that was never requested.
    //
    // The exact-body assertion carries a second rule: `updateDomainSettings`
    // also accepts `allowAccountReset` and `symbolicSubaddressing`, so sending
    // either would let a DNS recheck silently rewrite the account-recovery
    // setting Purelymail itself warns about.
    const stub = createFetchStub([ok({})]);
    await makeAdapter(stub).recheckDomainDns(TEST_DOMAIN);
    const body = stub.bodyOf(0);
    expect(body).toEqual({ name: TEST_DOMAIN, recheckDns: true });
    expect("domainName" in body).toBe(false);
  });
});

describe("the ownership code", () => {
  it("is fetched with an EMPTY body, because it is per ACCOUNT", async () => {
    // Verified from the API rather than the docs page: `getOwnershipCode` takes
    // no arguments. One published value proves every domain on the account,
    // which is why `requiredRecords` takes the code instead of deriving it.
    const stub = createFetchStub([ok({ code: TEST_OWNERSHIP_CODE })]);
    const code = await makeAdapter(stub).getOwnershipCode();
    expect(code).toBe(TEST_OWNERSHIP_CODE);
    expect(stub.rawBodyOf(0)).toBe("{}");
  });

  it("fails loudly when the response has no code", async () => {
    const stub = createFetchStub([ok({})]);
    const error = await rejection(makeAdapter(stub).getOwnershipCode());
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["field"]).toBe("code");
  });
});

describe("mailboxes", () => {
  it("createUser sends a LOCAL PART plus the domain, separately", async () => {
    // `createUser` documents `userName` as "Local part of username, e.g. 'user'
    // in 'user@domain.com'". Sending a full address here creates a mailbox
    // called `user@domain.com@domain.com` or fails, depending on the provider's
    // mood — and the sibling operations take the opposite form.
    const stub = createFetchStub([ok({})]);
    await makeAdapter(stub).createUser({
      userName: "postmaster",
      domainName: TEST_DOMAIN,
      password: "unit-test-not-a-real-password",
    });
    const body = stub.bodyOf(0);
    expect(body["userName"]).toBe("postmaster");
    expect(body["domainName"]).toBe(TEST_DOMAIN);
    expect(String(body["userName"]).includes("@")).toBe(false);
  });

  it("createUser omits the optional flags, or sends exactly what it was given", async () => {
    // Omitting rather than defaulting matters here: `enablePasswordReset` is
    // the mailbox-level cousin of the account-reset setting Purelymail warns
    // about, and Loxep must not decide it by accident.
    const omitted = createFetchStub([ok({})]);
    await makeAdapter(omitted).createUser({
      userName: "postmaster",
      domainName: TEST_DOMAIN,
      password: "unit-test-not-a-real-password",
    });
    expect(Object.keys(omitted.bodyOf(0)).sort()).toEqual([
      "domainName",
      "password",
      "userName",
    ]);

    const given = createFetchStub([ok({})]);
    await makeAdapter(given).createUser({
      userName: "postmaster",
      domainName: TEST_DOMAIN,
      password: "unit-test-not-a-real-password",
      enablePasswordReset: false,
      enableSearchIndexing: false,
      sendWelcomeEmail: false,
    });
    const body = given.bodyOf(0);
    // `false` in particular must survive: an "omit falsy values" spread would
    // drop all three and silently accept the provider's defaults instead.
    expect(body["enablePasswordReset"]).toBe(false);
    expect(body["enableSearchIndexing"]).toBe(false);
    expect(body["sendWelcomeEmail"]).toBe(false);
  });

  it("deleteUser sends the FULL address, the opposite form createUser takes", async () => {
    // The asymmetry `purelymailFullAddress` exists to make explicit:
    // `deleteUser`, `getUser`, and `modifyUser` all document `userName` as
    // "Full username, e.g. 'user@domain.com'", while `createUser` documents the
    // same field name as the LOCAL PART. Got wrong once, then debugged twice.
    expect(purelymailFullAddress("postmaster", TEST_DOMAIN)).toBe(
      `postmaster@${TEST_DOMAIN}`,
    );
    const stub = createFetchStub([ok({})]);
    await makeAdapter(stub).deleteUser(`postmaster@${TEST_DOMAIN}`);
    expect(stub.bodyOf(0)).toEqual({ userName: `postmaster@${TEST_DOMAIN}` });
  });

  it("listUsers returns a plain string array, dropping anything else", async () => {
    // The read-back path for a `pending` createUser, so a single odd entry must
    // not fail the whole reconciliation.
    const clean = createFetchStub([
      ok({ users: [`a@${TEST_DOMAIN}`, `b@${TEST_DOMAIN}`] }),
    ]);
    expect(await makeAdapter(clean).listUsers()).toEqual([
      `a@${TEST_DOMAIN}`,
      `b@${TEST_DOMAIN}`,
    ]);

    const mixed = createFetchStub([ok({ users: [`a@${TEST_DOMAIN}`, 42, null] })]);
    expect(await makeAdapter(mixed).listUsers()).toEqual([`a@${TEST_DOMAIN}`]);
  });

  it("listUsers fails loudly when `users` is not an array", async () => {
    // Distinct from the above: an empty read-back means "no mailboxes", and a
    // malformed one must never be mistaken for it.
    const stub = createFetchStub([ok({ users: "a@example.test" })]);
    const error = await rejection(makeAdapter(stub).listUsers());
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["field"]).toBe("users");
  });

  it("publishes the 1000-user ceiling, since there is no paging to detect it", async () => {
    // `listUser` returns "up to 1000" users with no page, cursor, or per_page
    // parameter of any kind. Without this number a caller cannot tell "this
    // account has fewer than a thousand mailboxes" from "this is all of them".
    expect(PURELYMAIL_LIST_USER_LIMIT).toBe(1000);
    expect(makeAdapter(createFetchStub([])).capabilities().maxListedUsers).toBe(
      1000,
    );
    const stub = createFetchStub([ok({ users: [] })]);
    await makeAdapter(stub).listUsers();
    expect(stub.queryOf(0)).toEqual({});
  });
});

describe("routing rules", () => {
  it("maps a routing rule onto a Loxep fact, keeping the id NUMERIC", async () => {
    // `int64` in the provider's schema and the only parameter
    // `deleteRoutingRule` takes. A rule read back without a usable id cannot be
    // deleted, so the id's type is part of the fact's contract.
    const stub = createFetchStub([ok({ rules: [routingRulePayload()] })]);
    const [rule] = await makeAdapter(stub).listRoutingRules();
    expect(rule).toEqual({
      id: 4_815_162_342,
      domainName: TEST_DOMAIN,
      prefix: false,
      matchUser: "abuse",
      targetAddresses: [`ops@${TEST_DOMAIN}`],
      catchall: false,
    });
    expect(typeof rule?.id).toBe("number");
  });

  it("fails loudly when a rule has no numeric id", async () => {
    for (const id of ["7", null, undefined, Number.NaN]) {
      const stub = createFetchStub([
        ok({ rules: [{ ...routingRulePayload(), id }] }),
      ]);
      const error = await rejection(makeAdapter(stub).listRoutingRules());
      expect(error.kind).toBe("provider_unavailable");
      expect(error.detail["field"]).toBe("id");
    }
  });

  it("surfaces a catch-all rule as such, empty matchUser and all", async () => {
    // A catch-all is how this provider expresses "everything else", and it does
    // not fire when the address maps to a real user — so an empty `matchUser`
    // is meaningful data, not a missing field.
    const stub = createFetchStub([
      ok({ rules: [routingRulePayload({ catchall: true, matchUser: "" })] }),
    ]);
    const [rule] = await makeAdapter(stub).listRoutingRules();
    expect(rule?.catchall).toBe(true);
    expect(rule?.matchUser).toBe("");
  });

  it("reads targets defensively: non-strings dropped, absent list empty", async () => {
    const mixed = createFetchStub([
      ok({
        rules: [
          routingRulePayload({ targetAddresses: [`ops@${TEST_DOMAIN}`, 7, null] }),
        ],
      }),
    ]);
    expect(
      (await makeAdapter(mixed).listRoutingRules())[0]?.targetAddresses,
    ).toEqual([`ops@${TEST_DOMAIN}`]);

    const absent = createFetchStub([
      ok({ rules: [{ id: 1, domainName: TEST_DOMAIN }] }),
    ]);
    expect(
      (await makeAdapter(absent).listRoutingRules())[0]?.targetAddresses,
    ).toEqual([]);
  });

  it("always sends prefix and catchall, even though both have obvious defaults", async () => {
    // Both are REQUIRED by the document. Omitting a required boolean because it
    // is false is how a create starts failing on a schema the provider has been
    // enforcing all along.
    const stub = createFetchStub([ok({})]);
    await makeAdapter(stub).createRoutingRule({
      domainName: TEST_DOMAIN,
      matchUser: "abuse",
      targetAddresses: [`ops@${TEST_DOMAIN}`],
    });
    expect(stub.bodyOf(0)).toEqual({
      domainName: TEST_DOMAIN,
      prefix: false,
      matchUser: "abuse",
      targetAddresses: [`ops@${TEST_DOMAIN}`],
      catchall: false,
    });

    const explicit = createFetchStub([ok({})]);
    await makeAdapter(explicit).createRoutingRule({
      domainName: TEST_DOMAIN,
      matchUser: "",
      targetAddresses: [`ops@${TEST_DOMAIN}`],
      prefix: true,
      catchall: true,
    });
    expect(explicit.bodyOf(0)["prefix"]).toBe(true);
    expect(explicit.bodyOf(0)["catchall"]).toBe(true);
  });

  it("copies the caller's target list rather than sending the caller's array", async () => {
    const targets = [`ops@${TEST_DOMAIN}`];
    const stub = createFetchStub([ok({})]);
    await makeAdapter(stub).createRoutingRule({
      domainName: TEST_DOMAIN,
      matchUser: "abuse",
      targetAddresses: targets,
    });
    targets.push("late@example.test");
    expect(stub.bodyOf(0)["targetAddresses"]).toEqual([`ops@${TEST_DOMAIN}`]);
  });

  it("deletes by the numeric id from a list call", async () => {
    const stub = createFetchStub([ok({})]);
    await makeAdapter(stub).deleteRoutingRule(4_815_162_342);
    expect(stub.bodyOf(0)).toEqual({ routingRuleId: 4_815_162_342 });
  });

  it("fails loudly when `rules` is not an array", async () => {
    const stub = createFetchStub([ok({ rules: null })]);
    const error = await rejection(makeAdapter(stub).listRoutingRules());
    expect(error.detail["field"]).toBe("rules");
  });
});

describe("account credit", () => {
  it("returns the credit as a STRING, verbatim, never as a number", async () => {
    // Money is PostgreSQL `numeric` in Loxep and never JS `number` arithmetic.
    // `"12.34"` parsed to a float and formatted back is how a balance acquires
    // a rounding error that nobody can explain later; `"0.00"` and `"1000.000"`
    // are how trailing zeros disappear on the way through.
    const first = createFetchStub([ok({ credit: "12.34" })]);
    const credit = await makeAdapter(first).checkAccountCredit();
    expect(credit).toBe("12.34");
    expect(typeof credit).toBe("string");

    for (const value of ["0.00", "-1.50", "1000.000"]) {
      const stub = createFetchStub([ok({ credit: value })]);
      expect(await makeAdapter(stub).checkAccountCredit()).toBe(value);
    }
  });

  it("fails loudly when the provider sends a numeric credit", async () => {
    // Rather than coercing it: a number here means the response shape changed,
    // and silently accepting it is how the numeric discipline erodes.
    const stub = createFetchStub([ok({ credit: 12.34 })]);
    const error = await rejection(makeAdapter(stub).checkAccountCredit());
    expect(error.kind).toBe("provider_unavailable");
    expect(error.detail["field"]).toBe("credit");
  });
});

describe("capabilities()", () => {
  it("describes what this provider can and cannot do, honestly", () => {
    expect(makeAdapter(createFetchStub([])).capabilities()).toEqual({
      provider: "purelymail",
      // Aliases and catch-alls are routing rules here, not accounts.
      routingRules: true,
      catchAll: true,
      // The provider does NOT assign the password; Loxep mints and supplies it,
      // which is precisely why a minted password exists to contain.
      suppliesMailboxPassword: false,
      ownershipCodeScope: "account",
      maxListedUsers: 1000,
      requiredRecordCount: 7,
    });
  });

  it("exposes the record set locally, and agrees with its own count", () => {
    // `requiredRecords` is pure: the DNS side of a mail domain can be planned
    // before the provider is contacted at all, which is what lets DNS
    // propagation and the ownership fetch overlap.
    const stub = createFetchStub([]);
    const adapter = makeAdapter(stub);
    expect(
      adapter.requiredRecords({ domainName: TEST_DOMAIN, ownershipCode: null }),
    ).toHaveLength(6);
    expect(adapter.capabilities().requiredRecordCount).toBe(
      adapter.requiredRecords({
        domainName: TEST_DOMAIN,
        ownershipCode: TEST_OWNERSHIP_CODE,
      }).length,
    );
    expect(stub.calls).toHaveLength(0);
  });
});

describe("the rate budget is acquired BEFORE the network", () => {
  it("throws rate_limited from the local budget and makes ZERO fetch calls", async () => {
    // The ordering is the whole point: a request the local budget refuses must
    // never reach the provider, so an exhausted budget cannot itself become the
    // thing that trips a provider limit. The budget here is drained OUTSIDE the
    // adapter, so the stub is untouched and `calls` is unambiguous.
    const stub = createFetchStub([]);
    const budget = createRateBudget({
      capacity: 1,
      refillPerSecond: 0.01,
      maxWaitMs: 10,
    });
    expect(budget.tryAcquire()).toBe(true);
    const error = await rejection(
      makeAdapter(stub, { rateBudget: budget }).listDomains(),
    );
    expect(error.kind).toBe("rate_limited");
    expect(error.detail["source"]).toBe("local_rate_budget");
    expect(stub.calls).toHaveLength(0);
  });

  it("spends exactly one token per request, including findDomainByName", async () => {
    // `findDomainByName` is a LIST underneath, not a get — Purelymail has no
    // "get one domain" operation — so it costs one request, not zero and not
    // two.
    const budget = createRateBudget({ capacity: 6, refillPerSecond: 0.001 });
    const stub = createFetchStub([
      ok({ users: [] }),
      ok({ users: [] }),
      ok({ domains: [domainPayload()] }),
    ]);
    const adapter = makeAdapter(stub, { rateBudget: budget });
    await adapter.listUsers();
    await adapter.listUsers();
    await adapter.findDomainByName(TEST_DOMAIN);
    expect(stub.calls).toHaveLength(3);
    expect(budget.stats().acquired).toBe(3);
    expect(budget.stats().available).toBeCloseTo(3, 1);
  });
});

describe("stats()", () => {
  it("counts requests that reached the network, and exposes nothing else", async () => {
    const stub = createFetchStub([ok({ users: [] }), ok({ domains: [] })]);
    const adapter = makeAdapter(stub);
    expect(adapter.stats().requests).toBe(0);
    await adapter.listUsers();
    await adapter.listDomains();
    expect(adapter.stats().requests).toBe(2);
    // The closure holding the token is not reachable from this shape at all —
    // there is no field it could occupy.
    expect(Object.keys(adapter.stats()).sort()).toEqual([
      "baseUrl",
      "rateBudget",
      "requests",
      "sourceAccountKey",
    ]);
  });

  it("keys the source account by host, since Purelymail has no account id", async () => {
    // The token IS the account here: no endpoint takes or returns an account
    // identifier. Two connections holding two different tokens for the same
    // host therefore produce the SAME key, and the connection id remains the
    // only discriminator. Asserted so nobody later treats the key as unique.
    const a = makeAdapter(createFetchStub([]));
    const b = makeAdapter(createFetchStub([]), { apiToken: "another_fake_token" });
    expect(a.sourceAccountKey).toBe("purelymail:purelymail.com");
    expect(b.sourceAccountKey).toBe(a.sourceAccountKey);
    expect(a.stats().sourceAccountKey).toBe("purelymail:purelymail.com");
  });
});
