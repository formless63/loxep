/**
 * The boundary modules on their own: **credential containment** first, then the
 * error taxonomy, config, the rate budget, the redactors, and the dev
 * credential loader.
 *
 * The containment block is what the design's pre-implementation item 8
 * requires, in its own words:
 *
 * > confirm no adapter can place a token value, a mailbox password, or an
 * > `Authorization` header into `reconcile_run_steps` or a job payload — **a
 * > test per adapter, not a code review**.
 *
 * ## Why this milestone's risk is a REQUEST, not a response
 *
 * Cloudflare's highest-risk value was a response body — the token-create call
 * returns a long-lived credential once and never again. Purelymail's is a
 * REQUEST: `createUser` carries `password`, a value Loxep minted seconds
 * earlier, and the run step recording that call is exactly where a debugging
 * instinct would dump the body. So the assertions below drive a **failing**
 * `createUser` with a distinctively marked fake password and then look for the
 * marker in everything the failure produces.
 *
 * Every check here is a programmatic containment comparison over serialized
 * output. No secret-shaped value is ever printed, and none of the constants in
 * this file is real.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PURELYMAIL_ALREADY_EXISTS_ERROR_CODES,
  PURELYMAIL_AUTH_ERROR_CODES,
  PURELYMAIL_DEFAULT_TIMEOUT_MS,
  PURELYMAIL_ERROR_KINDS,
  PURELYMAIL_NOT_FOUND_ERROR_CODES,
  PurelymailAdapterError,
  createPurelymailAdapter,
  createRateBudget,
  defaultPurelymailEnvFilePath,
  loadPurelymailCredentialsFromEnvFile,
  normalizePurelymailBaseUrl,
  parsePurelymailAdapterConfig,
  purelymailKindFromEnvelope,
  purelymailSourceAccountKey,
  readPurelymailEnvelope,
  redactPurelymailDomain,
  redactPurelymailOwnershipCode,
  redactPurelymailRequest,
  redactPurelymailRoutingRule,
  redactPurelymailUserCreate,
} from "../src/index.ts";
import type { PurelymailAdapter } from "../src/index.ts";
import {
  createFailingFetchStub,
  createFetchStub,
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

/**
 * A fake minted mailbox password. The marker is deliberately distinctive so a
 * containment assertion over serialized output cannot match by accident, and so
 * a failure names the thing that leaked without printing anything real.
 */
const MINTED_PASSWORD = "pw-MARKER-3f9a2c7e-DO-NOT-LEAK";
const MARKER = "MARKER-3f9a2c7e";

function makeAdapter(stub: FetchStub): PurelymailAdapter {
  return createPurelymailAdapter({
    apiToken: TEST_TOKEN,
    fetchImpl: stub.impl,
    rateBudget: createRateBudget({ capacity: 100, refillPerSecond: 1000 }),
  });
}

/**
 * The redactor's `subject` type, so a test can hand it a deliberately junky
 * object through one explicit cast rather than several inline ones. Casting is
 * the point: production callers cannot pass these fields, and the assertion is
 * that a caller who forced them through still gets nothing out.
 */
type RedactSubject = NonNullable<
  Parameters<typeof redactPurelymailRequest>[0]["subject"]
>;

function junkySubject(fields: Record<string, unknown>): RedactSubject {
  return fields as unknown as RedactSubject;
}

/** Everything an error could carry into a log line, a run step, or a job. */
function serializeError(error: PurelymailAdapterError): string {
  return JSON.stringify({
    name: error.name,
    kind: error.kind,
    message: error.message,
    detail: error.detail,
    stack: error.stack ?? null,
  });
}

async function failingCreateUser(
  stub: FetchStub,
): Promise<PurelymailAdapterError> {
  return rejection(
    makeAdapter(stub).createUser({
      userName: "postmaster",
      domainName: TEST_DOMAIN,
      password: MINTED_PASSWORD,
      sendWelcomeEmail: false,
    }),
  );
}

describe("a minted mailbox password never leaves the request body", () => {
  it("is genuinely in the request, so these assertions are not vacuous", async () => {
    // The negative control. If the adapter stopped sending the password at all,
    // every containment assertion below would pass while creating mailboxes
    // nobody could log into — so the marker's presence in the OUTBOUND body is
    // asserted first, once.
    const stub = createFetchStub([ok({})]);
    await makeAdapter(stub).createUser({
      userName: "postmaster",
      domainName: TEST_DOMAIN,
      password: MINTED_PASSWORD,
    });
    expect(stub.rawBodyOf(0)?.includes(MARKER)).toBe(true);
    // And `createUser` resolves to nothing, so the value cannot travel back out
    // the way it came in. That `void` is a containment decision, not a
    // reflection of the provider's empty response.
    const second = createFetchStub([ok({})]);
    expect(
      await makeAdapter(second).createUser({
        userName: "postmaster",
        domainName: TEST_DOMAIN,
        password: MINTED_PASSWORD,
      }),
    ).toBeUndefined();
  });

  it("never reaches a thrown error when the provider refuses the create", async () => {
    // The realistic leak: a create fails, the error is logged with its detail,
    // and the body went along for the ride. Nothing in `errors.ts` reads a
    // request body, and this asserts that structural fact from the outside —
    // across the envelope refusal at HTTP 200 and the HTML 404 that a wrong
    // operation name produces.
    const refused = createFetchStub([
      fail("userExists", "That user already exists."),
    ]);
    const first = await failingCreateUser(refused);
    expect(first.kind).toBe("invalid_request");
    expect(serializeError(first).includes(MARKER)).toBe(false);

    const html = createFetchStub([htmlNotFound()]);
    expect(serializeError(await failingCreateUser(html)).includes(MARKER)).toBe(
      false,
    );
  });

  it("never reaches a thrown error when the transport fails mid-flight", async () => {
    // `fetch` rejections can carry the whole `Request` — body and headers — on
    // a property. `normalizePurelymailError` reduces an unknown Error to
    // name/message/code and drops its properties for exactly this reason.
    const stub = createFailingFetchStub(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNRESET" },
        request: {
          headers: { "Purelymail-Api-Token": TEST_TOKEN },
          body: JSON.stringify({ password: MINTED_PASSWORD }),
        },
      }),
    );
    const error = await failingCreateUser(stub);
    expect(error.kind).toBe("provider_unavailable");
    expect(serializeError(error).includes(MARKER)).toBe(false);
    expect(serializeError(error).includes(TEST_TOKEN)).toBe(false);
  });

  it("never reaches a thrown error when the local budget refuses the call", async () => {
    // This one throws before `fetch` is even reached, and the password is a
    // live local argument at that moment.
    const budget = createRateBudget({
      capacity: 1,
      refillPerSecond: 0.01,
      maxWaitMs: 10,
    });
    expect(budget.tryAcquire()).toBe(true);
    const adapter = createPurelymailAdapter({
      apiToken: TEST_TOKEN,
      fetchImpl: createFetchStub([]).impl,
      rateBudget: budget,
    });
    const error = await rejection(
      adapter.createUser({
        userName: "postmaster",
        domainName: TEST_DOMAIN,
        password: MINTED_PASSWORD,
      }),
    );
    expect(error.detail["source"]).toBe("local_rate_budget");
    expect(serializeError(error).includes(MARKER)).toBe(false);
  });

  it("never reaches the adapter's stats object", async () => {
    // `stats()` is the shape most likely to be dumped into a health endpoint or
    // an observability field, and it is built from a closure that holds both
    // secrets.
    const stub = createFetchStub([fail("userExists", "exists")]);
    const adapter = makeAdapter(stub);
    await adapter
      .createUser({
        userName: "postmaster",
        domainName: TEST_DOMAIN,
        password: MINTED_PASSWORD,
      })
      .catch(() => undefined);
    const stats = JSON.stringify(adapter.stats());
    expect(stats.includes(MARKER)).toBe(false);
    expect(stats.includes(TEST_TOKEN)).toBe(false);
  });

  it("never reaches a redactor, because no redactor takes one", async () => {
    // The structural half of the rule: `redactPurelymailUserCreate` accepts an
    // identity pair and nothing else, so there is no argument position a
    // password could arrive in.
    const summary = redactPurelymailUserCreate({
      userName: "postmaster",
      domainName: TEST_DOMAIN,
    });
    expect(JSON.stringify(summary).includes(MARKER)).toBe(false);
    expect(summary).toEqual({
      userName: "postmaster",
      domainName: TEST_DOMAIN,
      created: true,
      // Stated positively so a reader of a run step knows the omission is
      // deliberate rather than a gap.
      passwordOmitted: true,
    });
  });

  it("cannot be smuggled through the request redactor's subject", () => {
    const summary = redactPurelymailRequest({
      operation: "user.create",
      path: "/api/v0/createUser",
      // Junk, including the one field that must never survive.
      subject: junkySubject({
        userName: "postmaster",
        domainName: TEST_DOMAIN,
        password: MINTED_PASSWORD,
        body: { password: MINTED_PASSWORD },
      }),
    });
    expect(JSON.stringify(summary).includes(MARKER)).toBe(false);
  });

  it("createUser returns nothing, so it cannot echo the password back", async () => {
    const stub = createFetchStub([ok({})]);
    const result = await makeAdapter(stub).createUser({
      userName: "postmaster",
      domainName: TEST_DOMAIN,
      password: MINTED_PASSWORD,
    });
    expect(result).toBeUndefined();
  });
});

describe("the API token is a header and nothing else", () => {
  it("appears in no thrown error, whatever the failure mode", async () => {
    const scenarios: Array<[string, () => Promise<PurelymailAdapterError>]> = [
      [
        "envelope error at HTTP 200",
        () =>
          rejection(
            makeAdapter(
              createFetchStub([fail("invalidToken", "Token not valid.")]),
            ).listDomains(),
          ),
      ],
      [
        "HTML 404",
        () => rejection(makeAdapter(createFetchStub([htmlNotFound()])).listUsers()),
      ],
      [
        "HTTP 500",
        () =>
          rejection(
            makeAdapter(createFetchStub([{ status: 500, body: {} }])).listUsers(),
          ),
      ],
      [
        "transport rejection",
        () =>
          rejection(
            makeAdapter(
              createFailingFetchStub(new TypeError("fetch failed")),
            ).listUsers(),
          ),
      ],
      [
        "malformed response",
        () =>
          rejection(
            makeAdapter(createFetchStub([ok({ domains: 7 })])).listDomains(),
          ),
      ],
    ];
    for (const [, run] of scenarios) {
      expect(serializeError(await run()).includes(TEST_TOKEN)).toBe(false);
    }
  });

  it("appears in no recorded request URL", async () => {
    const stub = createFetchStub([ok({ users: [] })]);
    await makeAdapter(stub).listUsers();
    for (const call of stub.calls) {
      expect(call.url.includes(TEST_TOKEN)).toBe(false);
      expect(new URL(call.url).search).toBe("");
      expect(new URL(call.url).username).toBe("");
    }
  });

  it("appears in no zod issue when the configuration is rejected", () => {
    // The received value IS the credential here, so config errors report paths
    // and issue codes only.
    let thrown: PurelymailAdapterError | null = null;
    try {
      parsePurelymailAdapterConfig({ apiToken: "" });
    } catch (error) {
      thrown = error as PurelymailAdapterError;
    }
    expect(thrown?.kind).toBe("invalid_request");
    expect(thrown?.message).toContain("apiToken");
    expect(thrown?.message).not.toContain("received");
  });

  it("appears in no error thrown for an unusable base URL", () => {
    let thrown: PurelymailAdapterError | null = null;
    try {
      createPurelymailAdapter({ apiToken: TEST_TOKEN, baseUrl: "not-a-url" });
    } catch (error) {
      thrown = error as PurelymailAdapterError;
    }
    expect(thrown?.kind).toBe("invalid_request");
    expect(serializeError(thrown as PurelymailAdapterError).includes(TEST_TOKEN)).toBe(
      false,
    );
  });
});

describe("error detail carries evidence, never headers or bodies", () => {
  /**
   * Everything `errors.ts`, `config.ts`, `rate-budget.ts`, and the adapter's
   * own field checks are allowed to put in a `detail`. A key outside this set
   * is a new disclosure surface and should be reviewed, not merged.
   */
  const ALLOWED_DETAIL_KEYS = new Set([
    "httpStatus",
    "operation",
    "path",
    "providerCode",
    "providerMessage",
    "providerBodyShape",
    "envelopeFailureOnSuccessStatus",
    "field",
    "source",
    "retryAfterSeconds",
    "errorName",
    "errorMessage",
    "errorCode",
    "causeCode",
    "requiredWaitMs",
    "maxWaitMs",
    "cost",
    "capacity",
    "protocol",
  ]);

  it("uses only the allow-listed keys across every failure mode", async () => {
    const errors = [
      await rejection(
        makeAdapter(
          createFetchStub([fail("invalidToken", "Token not valid.")]),
        ).listDomains(),
      ),
      await rejection(makeAdapter(createFetchStub([htmlNotFound()])).listUsers()),
      await rejection(
        makeAdapter(
          createFetchStub([{ status: 429, body: {}, headers: { "retry-after": "9" } }]),
        ).listUsers(),
      ),
      await rejection(
        makeAdapter(createFailingFetchStub(new TypeError("boom"))).listUsers(),
      ),
      await rejection(
        makeAdapter(createFetchStub([ok({})])).getOwnershipCode(),
      ),
    ];
    for (const error of errors) {
      for (const key of Object.keys(error.detail)) {
        expect(ALLOWED_DETAIL_KEYS.has(key)).toBe(true);
      }
    }
  });

  it("records the PATH, never the URL", async () => {
    const error = await rejection(
      makeAdapter(createFetchStub([fail("nope", "no")])).addDomain(TEST_DOMAIN),
    );
    expect(error.detail["path"]).toBe("/api/v0/addDomain");
    expect(String(error.detail["path"]).startsWith("https://")).toBe(false);
  });

  it("never carries the raw body of an HTML error page", async () => {
    const error = await rejection(
      makeAdapter(createFetchStub([htmlNotFound()])).listDomains(),
    );
    const serialized = serializeError(error);
    expect(serialized.includes("<html")).toBe(false);
    expect(serialized.includes("404 Not Found")).toBe(false);
    // Only the SHAPE is reported, which is all a diagnosis needs.
    expect(error.detail["providerBodyShape"]).toBe("not-a-purelymail-envelope");
  });

  it("never carries a header name or value from the request", async () => {
    const error = await rejection(
      makeAdapter(createFetchStub([{ status: 500, body: {} }])).listUsers(),
    );
    const serialized = serializeError(error).toLowerCase();
    expect(serialized.includes("purelymail-api-token")).toBe(false);
    expect(serialized.includes("content-type")).toBe(false);
    expect(serialized.includes("authorization")).toBe(false);
  });
});

describe("error taxonomy", () => {
  it("carries exactly the five kinds every Loxep adapter carries", () => {
    expect([...PURELYMAIL_ERROR_KINDS]).toEqual([
      "auth",
      "rate_limited",
      "not_found",
      "invalid_request",
      "provider_unavailable",
    ]);
  });

  it("reads the LIVE envelope, discriminator and all", () => {
    expect(
      readPurelymailEnvelope({
        type: "error",
        code: "invalidToken",
        message: "Token not valid.",
      }),
    ).toEqual({
      type: "error",
      code: "invalidToken",
      message: "Token not valid.",
      result: null,
    });
  });

  it("also reads the DOCUMENTED shape, a `result` with no discriminator", () => {
    // The published OpenAPI document models every 200 as `{result: ...}` and
    // never mentions `type`. Tolerating both means a future removal of the
    // discriminator degrades to the documented contract instead of failing
    // every call — and `hasOwn`, not truthiness, so `{"result": null}` is a
    // success with nothing in it rather than a missing envelope.
    const envelope = readPurelymailEnvelope({ result: { credit: "1.00" } });
    expect(envelope.type).toBe("success");
    expect(envelope.result).toEqual({ credit: "1.00" });
    expect(readPurelymailEnvelope({ result: null }).type).toBe("success");
  });

  it("reports type: null for anything that is not envelope-shaped", () => {
    // An HTML 404 page, a proxy error, an empty body, a discriminator nobody
    // has seen. Never a throw: the reader runs on the failure path.
    for (const body of [
      null,
      "text",
      42,
      ["a"],
      undefined,
      { type: "partial", result: {} },
    ]) {
      expect(readPurelymailEnvelope(body).type).toBeNull();
    }
  });

  it("classifies by envelope code first, then by status", () => {
    // `invalidToken` at HTTP 200 is the case this whole design turns on.
    expect(purelymailKindFromEnvelope(200, readPurelymailEnvelope({
      type: "error",
      code: "invalidToken",
    }))).toBe("auth");
    expect(purelymailKindFromEnvelope(200, readPurelymailEnvelope({
      type: "error",
      code: "noSuchDomain",
    }))).toBe("not_found");
    // Understood and refused: a retry would fail identically.
    expect(purelymailKindFromEnvelope(200, readPurelymailEnvelope({
      type: "error",
      code: "whateverElse",
    }))).toBe("invalid_request");
    expect(purelymailKindFromEnvelope(401, readPurelymailEnvelope({}))).toBe("auth");
    expect(purelymailKindFromEnvelope(403, readPurelymailEnvelope({}))).toBe("auth");
    expect(purelymailKindFromEnvelope(429, readPurelymailEnvelope({}))).toBe(
      "rate_limited",
    );
    expect(purelymailKindFromEnvelope(404, readPurelymailEnvelope({}))).toBe(
      "not_found",
    );
    expect(purelymailKindFromEnvelope(422, readPurelymailEnvelope({}))).toBe(
      "invalid_request",
    );
    expect(purelymailKindFromEnvelope(503, readPurelymailEnvelope({}))).toBe(
      "provider_unavailable",
    );
    // A 2xx whose body is not an envelope: nothing about the request is known
    // to be wrong, so it is not blamed on the caller.
    expect(purelymailKindFromEnvelope(200, readPurelymailEnvelope({}))).toBe(
      "provider_unavailable",
    );
    expect(purelymailKindFromEnvelope(undefined, readPurelymailEnvelope({}))).toBe(
      "provider_unavailable",
    );
  });

  it("keeps every code set small: one observed, the rest UNVERIFIED", () => {
    // Purelymail publishes no consolidated error-code table, so the auth set is
    // widened only from a live response — never from a guess — and the live
    // leg's standing job is to record any other code the API really returns.
    expect([...PURELYMAIL_AUTH_ERROR_CODES]).toEqual(["invalidToken"]);
    // The other two sets are guesses, and nothing depends on them for
    // correctness: an unrecognized code still classifies as `invalid_request`,
    // and the read-back paths that care about absence answer from a LIST call
    // rather than from an error code.
    expect([...PURELYMAIL_NOT_FOUND_ERROR_CODES].sort()).toEqual([
      "noSuchDomain",
      "noSuchUser",
    ]);
    expect([...PURELYMAIL_ALREADY_EXISTS_ERROR_CODES].sort()).toEqual([
      "domainExists",
      "userExists",
    ]);
  });

  it("does not swallow an already-exists code, unlike the Cloudflare sibling", async () => {
    // A mailbox create is BILLABLE, and "already exists" is not a claim worth
    // trusting an unverified code string with. Convergence is decided by
    // reading the provider back, not by interpreting this error.
    const error = await rejection(
      makeAdapter(createFetchStub([fail("userExists", "exists")])).createUser({
        userName: "postmaster",
        domainName: TEST_DOMAIN,
        password: MINTED_PASSWORD,
      }),
    );
    expect(error).toBeInstanceOf(PurelymailAdapterError);
    expect(error.kind).toBe("invalid_request");
  });
});

describe("config", () => {
  it("defaults to the provider's published server and timeout", () => {
    const config = parsePurelymailAdapterConfig({ apiToken: TEST_TOKEN });
    expect(config.baseUrl).toBe("https://purelymail.com");
    expect(config.timeoutMs).toBe(PURELYMAIL_DEFAULT_TIMEOUT_MS);
    // Trailing slashes are stripped so a path separator is never doubled.
    expect(normalizePurelymailBaseUrl("https://purelymail.com///")).toBe(
      "https://purelymail.com",
    );
  });

  it("refuses anything that is not an absolute http(s) URL", () => {
    for (const bad of [
      "not-a-url",
      "purelymail.com",
      "ftp://purelymail.com",
      "file:///etc/passwd",
      "",
    ]) {
      expect(() => normalizePurelymailBaseUrl(bad)).toThrow(
        PurelymailAdapterError,
      );
    }
  });

  it("allows http, deliberately, for a self-hosted or proxied deployment", () => {
    // Looser than the Cloudflare adapter's https-only rule, and on purpose: the
    // published document's servers[1] is `https://localhost:1443`, and a proxy
    // in front of this API is a supported deployment.
    expect(normalizePurelymailBaseUrl("http://localhost:1443")).toBe(
      "http://localhost:1443",
    );
  });

  it("rejects an empty token, an unknown field, and a nonsense timeout", () => {
    // `strictObject`: an unknown key is a mistake, not something to ignore —
    // `accountId` in particular would be a caller assuming this provider has
    // one, which it does not.
    expect(() => parsePurelymailAdapterConfig({ apiToken: "" })).toThrow(
      PurelymailAdapterError,
    );
    expect(() =>
      parsePurelymailAdapterConfig({ apiToken: TEST_TOKEN, accountId: "acct" }),
    ).toThrow(PurelymailAdapterError);
    for (const timeoutMs of [0, -1, 1.5]) {
      expect(() =>
        parsePurelymailAdapterConfig({ apiToken: TEST_TOKEN, timeoutMs }),
      ).toThrow(PurelymailAdapterError);
    }
  });

  it("derives the source account key from the host, and only the host", () => {
    // Purelymail exposes NO account identifier — the token is the account. Two
    // connections holding different tokens for the same host therefore share a
    // key, which is a documented limitation rather than a bug, and the
    // connection id remains the only discriminator.
    expect(purelymailSourceAccountKey("https://purelymail.com")).toBe(
      "purelymail:purelymail.com",
    );
    expect(purelymailSourceAccountKey("https://mail.internal.test:8443")).toBe(
      "purelymail:mail.internal.test:8443",
    );
    expect(purelymailSourceAccountKey("garbage")).toBe("purelymail:unknown");
  });
});

describe("rate budget", () => {
  it("acquires from a full bucket without waiting", async () => {
    // The suggested default is deliberately SMALL — a burst of six at one per
    // second sustained. Neither the OpenAPI document nor the docs index
    // mentions an API request limit, a throttling header, or a 429, and an
    // undocumented limit is one nobody can design against; this domain's call
    // volume is tiny anyway (roughly five calls per domain, once, plus one
    // cheap read per bounded poll).
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

  it("distinguishes a local refusal from a provider 429 by detail.source", async () => {
    // A reconciler treats them differently: the local one is self-inflicted and
    // resolves on its own; the provider one carries the provider's own advice.
    const budget = createRateBudget({
      capacity: 1,
      refillPerSecond: 0.01,
      maxWaitMs: 1,
    });
    await budget.acquire();
    const local = await rejection(budget.acquire());
    expect(local.detail["source"]).toBe("local_rate_budget");
    expect(local.detail["requiredWaitMs"]).toBeGreaterThan(1);

    const provider = await rejection(
      makeAdapter(
        createFetchStub([{ status: 429, body: {}, headers: { "retry-after": "1" } }]),
      ).listUsers(),
    );
    expect(provider.detail["source"]).toBe("provider");
  });

  it("validates its own construction and cost arguments", () => {
    expect(() => createRateBudget({ capacity: 0, refillPerSecond: 1 })).toThrow(
      PurelymailAdapterError,
    );
    expect(() => createRateBudget({ capacity: 1, refillPerSecond: 0 })).toThrow(
      PurelymailAdapterError,
    );
    const budget = createRateBudget({ capacity: 2, refillPerSecond: 1 });
    expect(() => budget.tryAcquire(3)).toThrow(PurelymailAdapterError);
  });

  it("refills over time up to the capacity and no further", async () => {
    const budget = createRateBudget({ capacity: 2, refillPerSecond: 1000 });
    expect(budget.tryAcquire(2)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(budget.stats().available).toBeLessThanOrEqual(2);
    expect(budget.tryAcquire(2)).toBe(true);
  });
});

describe("redactors", () => {
  it("projects a domain down to identity and the DNS verdict", () => {
    // The DNS booleans are the whole reason the reconciler reads a domain back,
    // so they survive redaction.
    expect(redactPurelymailDomain(domainPayload({ isShared: false }))).toEqual({
      name: TEST_DOMAIN,
      isShared: false,
      allowAccountReset: false,
      symbolicSubaddressing: false,
      passesMx: true,
      passesSpf: true,
      passesDkim: true,
      passesDmarc: true,
    });
    // And an unknown verdict is null, not false: a SUMMARY must not claim the
    // provider said "no" when it said nothing. (The adapter's FACT resolves the
    // same absence to false, because a fact has to make a decision and "not
    // proven" is never "fine" — the two are different jobs.)
    const sparse = redactPurelymailDomain({ name: TEST_DOMAIN });
    expect(sparse["passesMx"]).toBeNull();
    expect(sparse["passesDmarc"]).toBeNull();
  });

  it("summarizes a routing rule by identity and target COUNT", () => {
    expect(redactPurelymailRoutingRule(routingRulePayload())).toEqual({
      routingRuleId: 4_815_162_342,
      domainName: TEST_DOMAIN,
      matchUser: "abuse",
      prefix: false,
      catchall: false,
      targetCount: 1,
    });
  });

  it("INCLUDES the ownership code, deliberately", () => {
    // This looks like a leak and is not. The code's entire purpose is to be
    // published in a public TXT record — `purelymailOwnershipRecord` puts it in
    // one — and the design says so explicitly "so the argument is not had
    // twice". Redacting it would make a half-published mail domain
    // undiagnosable from the run history: the operator's first question is
    // "which code did we publish", and the answer is public data.
    const summary = redactPurelymailOwnershipCode({ code: TEST_OWNERSHIP_CODE });
    expect(summary).toEqual({
      ownershipCode: TEST_OWNERSHIP_CODE,
      // Carried alongside so a reader of a run step does not have to know the
      // above to be sure the inclusion was intentional.
      ownershipCodeIsPublic: true,
    });
  });

  it("is an allow-list, so junk beside a known field is dropped", () => {
    // The failure mode an omit-list has and an allow-list does not: a renamed
    // or newly added secret field cannot escape a redactor that never copies an
    // unknown key.
    const summary = redactPurelymailRequest({
      operation: "user.create",
      path: "/api/v0/createUser",
      subject: junkySubject({
        domainName: TEST_DOMAIN,
        userName: "postmaster",
        password: MINTED_PASSWORD,
        apiToken: TEST_TOKEN,
        headers: { "Purelymail-Api-Token": TEST_TOKEN },
        rawBody: { password: MINTED_PASSWORD },
      }),
    });
    expect(summary).toEqual({
      operation: "user.create",
      method: "POST",
      path: "/api/v0/createUser",
      domainName: TEST_DOMAIN,
      userName: "postmaster",
    });
    const serialized = JSON.stringify(summary);
    expect(serialized.includes(MARKER)).toBe(false);
    expect(serialized.includes(TEST_TOKEN)).toBe(false);
  });

  it("summarizes a request by operation and PATH, never by URL", () => {
    // Never the URL, because a full request URL is what carries credentials in
    // a query string at providers that put them there — and never the body,
    // which at THIS provider is where the password lives. Absent subject fields
    // are omitted rather than emitted as null, so a summary states only what
    // was actually known.
    expect(
      redactPurelymailRequest({
        operation: "account.credit",
        path: "/api/v0/checkAccountCredit",
      }),
    ).toEqual({
      operation: "account.credit",
      method: "POST",
      path: "/api/v0/checkAccountCredit",
    });
    expect(
      Object.keys(
        redactPurelymailRequest({
          operation: "routing.delete",
          path: "/api/v0/deleteRoutingRule",
          subject: { routingRuleId: 7 },
        }),
      ).sort(),
    ).toEqual(["method", "operation", "path", "routingRuleId"]);
  });

  it("survives null and undefined input without throwing", () => {
    // Redactors run on a failure path, where the value being summarized is the
    // least trustworthy thing in the process.
    expect(redactPurelymailDomain(null)["name"]).toBeNull();
    expect(redactPurelymailRoutingRule(undefined)["routingRuleId"]).toBeNull();
    expect(redactPurelymailOwnershipCode(null)["ownershipCode"]).toBeNull();
  });
});

describe("dev credential loader", () => {
  it("names the documented path and returns null when it is absent", () => {
    // The absent case is the state TODAY: no Purelymail API key exists yet, so
    // `test/live-purelymail.test.ts` must skip rather than fail.
    expect(defaultPurelymailEnvFilePath()).toMatch(
      /\.config\/loxep\/purelymail\.env$/,
    );
    expect(
      loadPurelymailCredentialsFromEnvFile(
        join(tmpdir(), "loxep-absent-purelymail-env-file"),
      ),
    ).toBeNull();
  });

  it("parses tokens, comments, quotes, and the short PM_ aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "loxep-pm-"));
    const good = join(dir, "good.env");
    writeFileSync(
      good,
      [
        "# a comment",
        "",
        'PURELYMAIL_API_TOKEN="fake_token_value"',
        `PURELYMAIL_BASE_URL=https://purelymail.com`,
        `PURELYMAIL_TEST_DOMAIN=${TEST_DOMAIN}`,
      ].join("\n"),
    );
    expect(loadPurelymailCredentialsFromEnvFile(good)).toEqual({
      apiToken: "fake_token_value",
      baseUrl: "https://purelymail.com",
      testDomain: TEST_DOMAIN,
    });

    const aliased = join(dir, "aliased.env");
    writeFileSync(aliased, "PM_API_TOKEN=fake_token_value\n");
    expect(loadPurelymailCredentialsFromEnvFile(aliased)).toEqual({
      apiToken: "fake_token_value",
    });
  });

  it("requires a token and says so without echoing the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "loxep-pm-"));
    const missing = join(dir, "missing.env");
    writeFileSync(missing, `PURELYMAIL_TEST_DOMAIN=${TEST_DOMAIN}\n`);
    expect(() => loadPurelymailCredentialsFromEnvFile(missing)).toThrow(
      /missing PURELYMAIL_API_TOKEN/,
    );
  });

  it("reports a malformed line by POSITION, never by content", () => {
    const dir = mkdtempSync(join(tmpdir(), "loxep-pm-"));
    const malformed = join(dir, "bad.env");
    writeFileSync(
      malformed,
      ["PURELYMAIL_API_TOKEN=fake_token_value", "this is not a key=value line"].join(
        "\n",
      ),
    );
    let thrown: PurelymailAdapterError | null = null;
    try {
      loadPurelymailCredentialsFromEnvFile(malformed);
    } catch (error) {
      thrown = error as PurelymailAdapterError;
    }
    expect(thrown?.detail["line"]).toBe(2);
    expect(JSON.stringify(thrown?.detail).includes("not a key")).toBe(false);
  });
});
