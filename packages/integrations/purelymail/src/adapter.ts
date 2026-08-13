/**
 * Purelymail adapter (loxep-lmy.2): a Loxep-owned boundary over the Purelymail
 * API, implemented on **native `fetch`** with no client dependency (ADR-0009).
 *
 * Why no library: there is no official client, and the protocol work one would
 * save is (a) one header, (b) unwrapping a `{type, result}` envelope. The whole
 * API is one shape.
 *
 * ## Verified upstream facts
 *
 * From the provider's own OpenAPI document — `window.swaggerSpec` in
 * `https://news.purelymail.com/api/swagger-spec.js` (`info.title` "Purelymail
 * API", `info.version` "0.0.1") — retrieved 2026-08-13, plus two live probes:
 *
 * ```text
 * base            https://purelymail.com                  servers[0].url
 * transport       POST /api/v0/<operation>, JSON body, ALWAYS. No GET, no
 *                 path parameters, no query strings, no pagination parameters
 * auth            Purelymail-Api-Token: <token>           LIVE-VERIFIED
 * envelope        {"type":"success","result":{...}}
 *                 {"type":"error","code":"...","message":"..."}   at HTTP 200
 *                 LIVE-VERIFIED: an unauthenticated call answers HTTP 200 with
 *                 {"type":"error","code":"invalidToken",...}
 * unknown path    HTTP 404 with an HTML page, not an envelope   LIVE-VERIFIED
 * rate limit      none published for the API (see rate-budget.ts)
 * listUser        up to 1000 users, no paging parameter of any kind
 * ownership code  getOwnershipCode takes an EMPTY body — the code is per
 *                 ACCOUNT, not per domain
 * ```
 *
 * **Every operation NAME is marked UNVERIFIED in `operations.ts`** and stays so
 * until exercised against a live account, following the Medusa and eBay
 * precedent. Because the API is RPC-shaped, a wrong name is a one-line fix in
 * that one map — and it presents unmistakably as the HTML 404 above rather than
 * as a subtle misbehavior.
 *
 * ## Boundary rules enforced here
 *
 * - the API token goes into the `Purelymail-Api-Token` header ONLY. Never a
 *   URL, query string, or body, so no error, log field, or thrown value
 *   reachable from this module can structurally contain it;
 * - **a minted mailbox password is a write-only argument.** It enters
 *   {@link PurelymailAdapter.createUser}, is placed in the request body, and is
 *   never stored on the adapter, echoed in a return value, or passed to a
 *   redactor. `createUser` returns `void` for that reason and not because the
 *   provider's response is empty (though it is);
 * - every request acquires from the per-connection rate budget BEFORE touching
 *   the network;
 * - **the envelope is checked on every response, not just non-2xx ones** — and
 *   here that is not defensive, it is the primary path;
 * - every failure is normalized to `PurelymailAdapterError` with
 *   credential-free `detail`;
 * - no provider response type is exported. Everything crossing this boundary is
 *   a Loxep-owned fact, so `@loxep/infrastructure` can re-declare the shapes
 *   structurally and take no dependency on this package.
 */
import {
  PURELYMAIL_LIST_USER_LIMIT,
  PURELYMAIL_TOKEN_HEADER,
  parsePurelymailAdapterConfig,
  purelymailFullAddress,
  purelymailSourceAccountKey,
  type PurelymailAdapterConfig,
  type PurelymailAdapterConfigInput,
} from "./config.ts";
import {
  PurelymailAdapterError,
  normalizePurelymailError,
  purelymailErrorFromResponse,
  readPurelymailEnvelope,
  type PurelymailEnvelope,
  type PurelymailErrorContext,
} from "./errors.ts";
import {
  PURELYMAIL_SUGGESTED_CAPACITY,
  PURELYMAIL_SUGGESTED_REFILL_PER_SECOND,
  createRateBudget,
  type PurelymailAdapterLogger,
  type RateBudget,
  type RateBudgetStats,
} from "./rate-budget.ts";
import {
  PURELYMAIL_OPERATIONS,
  purelymailPath,
  type PurelymailOperation,
} from "./operations.ts";
import {
  purelymailRequiredRecords,
  type PurelymailDnsRecord,
} from "./records.ts";

/* ------------------------------------------------------- Loxep-owned facts */

/** The provider's own DNS verdict for a domain. Evidence, not intent. */
export interface PurelymailDnsSummaryFact {
  passesMx: boolean;
  passesSpf: boolean;
  passesDkim: boolean;
  passesDmarc: boolean;
}

/** A mail domain as Loxep understands it. No provider type is exported. */
export interface PurelymailDomainFact {
  name: string;
  /**
   * Whether this domain may be used to reset the Purelymail ACCOUNT's password.
   * Purelymail's own documentation warns that *"anyone with control over the
   * DNS for that domain can perform password recovery for your account's admin
   * user and gain control over the account"*. Loxep never turns this on; it is
   * surfaced so an operator can see that it is off.
   */
  allowAccountReset: boolean;
  symbolicSubaddressing: boolean;
  /** True for a Purelymail-owned shared domain, which Loxep never manages. */
  isShared: boolean;
  dns: PurelymailDnsSummaryFact;
}

/** A routing rule — how an alias or catch-all is expressed at this provider. */
export interface PurelymailRoutingRuleFact {
  /** `int64` in the provider's schema; the delete call's only parameter. */
  id: number;
  domainName: string;
  /** Whether `matchUser` is a prefix match rather than an exact one. */
  prefix: boolean;
  /** Local part, e.g. `abuse`. */
  matchUser: string;
  targetAddresses: string[];
  /** A rule that does not fire when the address maps to a real user. */
  catchall: boolean;
}

/** What this provider can and cannot do, so callers degrade honestly. */
export interface MailProviderCapabilities {
  provider: "purelymail";
  /** Aliases and catch-alls are routing rules, not accounts. */
  routingRules: boolean;
  catchAll: boolean;
  /** The provider assigns the password; Loxep mints and supplies it. */
  suppliesMailboxPassword: boolean;
  /**
   * Ownership is proved by a published TXT record whose code is per ACCOUNT.
   * A caller can therefore fetch the code once and reuse it for every domain.
   */
  ownershipCodeScope: "account" | "domain";
  /** `listUser` returns at most this many addresses, with no paging. */
  maxListedUsers: number;
  /** How many records {@link PurelymailAdapter.requiredRecords} emits. */
  requiredRecordCount: number;
}

export interface PurelymailAdapterStats {
  baseUrl: string;
  sourceAccountKey: string;
  rateBudget: RateBudgetStats;
  /** Requests that reached the network (successful or not). */
  requests: number;
}

/* ------------------------------------------------------------ the adapter */

export type PurelymailFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type CreatePurelymailAdapterInput = PurelymailAdapterConfigInput & {
  /**
   * Test seam only. Production code leaves this undefined and the adapter uses
   * the runtime's native `fetch`.
   */
  fetchImpl?: PurelymailFetch;
};

export interface CreateUserInput {
  /** LOCAL PART only — the provider takes the domain separately here. */
  userName: string;
  domainName: string;
  /**
   * A password Loxep MINTED. Write-only: it goes into the request body and
   * nowhere else. Never logged, never returned, never redacted (there is
   * nothing to redact — no code path reads it back).
   */
  password: string;
  enablePasswordReset?: boolean;
  enableSearchIndexing?: boolean;
  sendWelcomeEmail?: boolean;
}

export interface CreateRoutingRuleInput {
  domainName: string;
  /** Local part to match, e.g. `abuse`. */
  matchUser: string;
  targetAddresses: readonly string[];
  /** Prefix rather than exact match. */
  prefix?: boolean;
  /** A catch-all does not fire when the address maps to a real user. */
  catchall?: boolean;
}

export interface PurelymailAdapter {
  readonly baseUrl: string;
  readonly sourceAccountKey: string;

  /** The account's ownership code, published as TXT to prove ownership. */
  getOwnershipCode(): Promise<string>;

  /**
   * Register a domain. **Fails until the ownership TXT resolves publicly**,
   * which is why the reconciler gates this call on delegation.
   */
  addDomain(domainName: string): Promise<void>;

  /** Every domain on the account. `includeShared` defaults to false. */
  listDomains(options?: { includeShared?: boolean }): Promise<
    PurelymailDomainFact[]
  >;

  /**
   * One domain by name, or `null`. The READ-BACK path that resolves a `pending`
   * `addDomain` in `provider_operations` without a blind retry.
   */
  findDomainByName(name: string): Promise<PurelymailDomainFact | null>;

  /** Ask the provider to re-check a domain's DNS records now. */
  recheckDomainDns(domainName: string): Promise<void>;

  /** Create a mailbox. BILLABLE and not idempotent — ledger it. */
  createUser(input: CreateUserInput): Promise<void>;

  /** Delete a mailbox. Takes the FULL address. Destructive: takes the mail. */
  deleteUser(fullAddress: string): Promise<void>;

  /**
   * Every address on the ACCOUNT (not per domain), up to
   * {@link PURELYMAIL_LIST_USER_LIMIT}. The read-back path for a `pending`
   * `createUser`.
   */
  listUsers(): Promise<string[]>;

  listRoutingRules(): Promise<PurelymailRoutingRuleFact[]>;
  createRoutingRule(input: CreateRoutingRuleInput): Promise<void>;
  deleteRoutingRule(routingRuleId: number): Promise<void>;

  /** Account credit as the provider's own string. The cheapest health check. */
  checkAccountCredit(): Promise<string>;

  /** The DNS records this provider requires for a domain. See `records.ts`. */
  requiredRecords(input: {
    domainName: string;
    ownershipCode: string | null;
  }): PurelymailDnsRecord[];

  capabilities(): MailProviderCapabilities;
  stats(): PurelymailAdapterStats;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(
  value: unknown,
  field: string,
  context: PurelymailErrorContext,
): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new PurelymailAdapterError(
    "provider_unavailable",
    `Purelymail response is missing the required field "${field}"`,
    { operation: context.operation, path: context.path, field },
  );
}

/** Provider domain object -> Loxep fact. Nothing else reads the raw shape. */
function toDomainFact(
  raw: unknown,
  context: PurelymailErrorContext,
): PurelymailDomainFact {
  const record = asRecord(raw);
  if (record === null) {
    throw new PurelymailAdapterError(
      "provider_unavailable",
      "Purelymail domain result was not an object",
      { operation: context.operation, path: context.path },
    );
  }
  const dns = asRecord(record["dnsSummary"]) ?? {};
  return {
    name: requiredString(record["name"], "name", context),
    allowAccountReset: record["allowAccountReset"] === true,
    symbolicSubaddressing: record["symbolicSubaddressing"] === true,
    isShared: record["isShared"] === true,
    dns: {
      passesMx: dns["passesMx"] === true,
      passesSpf: dns["passesSpf"] === true,
      passesDkim: dns["passesDkim"] === true,
      passesDmarc: dns["passesDmarc"] === true,
    },
  };
}

function toRoutingRuleFact(
  raw: unknown,
  context: PurelymailErrorContext,
): PurelymailRoutingRuleFact {
  const record = asRecord(raw);
  if (record === null) {
    throw new PurelymailAdapterError(
      "provider_unavailable",
      "Purelymail routing rule result was not an object",
      { operation: context.operation, path: context.path },
    );
  }
  const id = record["id"];
  if (typeof id !== "number" || !Number.isFinite(id)) {
    throw new PurelymailAdapterError(
      "provider_unavailable",
      'Purelymail routing rule is missing the required field "id"',
      { operation: context.operation, path: context.path, field: "id" },
    );
  }
  const targets = record["targetAddresses"];
  return {
    id,
    domainName: requiredString(record["domainName"], "domainName", context),
    prefix: record["prefix"] === true,
    matchUser: typeof record["matchUser"] === "string" ? record["matchUser"] : "",
    targetAddresses: Array.isArray(targets)
      ? targets.filter((entry): entry is string => typeof entry === "string")
      : [],
    catchall: record["catchall"] === true,
  };
}

export function createPurelymailAdapter(
  input: CreatePurelymailAdapterInput,
): PurelymailAdapter {
  const { logger, rateBudget, fetchImpl, ...rest } = input;
  const config: PurelymailAdapterConfig = parsePurelymailAdapterConfig(rest);
  const budget: RateBudget =
    rateBudget ??
    createRateBudget({
      capacity: PURELYMAIL_SUGGESTED_CAPACITY,
      refillPerSecond: PURELYMAIL_SUGGESTED_REFILL_PER_SECOND,
      ...(logger === undefined ? {} : { logger }),
    });
  const doFetch: PurelymailFetch =
    fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const sourceAccountKey = purelymailSourceAccountKey(config.baseUrl);

  // Held in this closure. Never read back out, never logged, never attached to
  // an error or a stats object.
  const apiToken = config.apiToken;
  let requests = 0;

  /**
   * **The one generic call.** Every operation in the API is this function with
   * a different name and body — which is the point of `operations.ts`.
   *
   * Returns the envelope's `result` for a successful call and throws a taxonomy
   * error otherwise, including for the HTTP 200 that carries
   * `{"type":"error",...}` — which, unlike at Cloudflare, is the normal way
   * this API reports failure.
   */
  const call = async (
    operation: PurelymailOperation,
    body: Record<string, unknown>,
  ): Promise<unknown> => {
    const path = purelymailPath(operation);
    const context: PurelymailErrorContext = { operation, path };
    await budget.acquire(1);

    const url = `${config.baseUrl}${path}`;
    let response: Response;
    requests += 1;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          [PURELYMAIL_TOKEN_HEADER]: apiToken,
          accept: "application/json",
          "content-type": "application/json",
        },
        // Every operation takes a body, and the several that take no arguments
        // take `{}` rather than nothing — `EmptyRequest` in the document.
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      throw normalizePurelymailError(error, context);
    }

    let parsed: unknown = null;
    try {
      const text = await response.text();
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      // An HTML 404 page (a wrong operation name) lands here, and the envelope
      // reader turns it into `type: null` rather than a crash.
      parsed = null;
    }
    const envelope: PurelymailEnvelope = readPurelymailEnvelope(parsed);

    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new PurelymailAdapterError(
        "rate_limited",
        "Purelymail rate limit exceeded",
        {
          source: "provider",
          operation,
          path,
          httpStatus: 429,
          ...(retryAfter === null ? {} : { retryAfterSeconds: retryAfter }),
        },
      );
    }

    // Envelope first, status second. A 200 proves nothing here.
    if (envelope.type !== "success") {
      throw purelymailErrorFromResponse(response.status, envelope, context);
    }
    if (!response.ok) {
      // `type: "success"` on a non-2xx has never been observed and would mean
      // the response cannot be trusted either way.
      throw purelymailErrorFromResponse(response.status, envelope, context);
    }
    return envelope.result;
  };

  const expectArray = (
    result: unknown,
    field: string,
    context: PurelymailErrorContext,
  ): unknown[] => {
    const record = asRecord(result);
    const value = record?.[field];
    if (!Array.isArray(value)) {
      throw new PurelymailAdapterError(
        "provider_unavailable",
        `Purelymail response field "${field}" was not an array`,
        { operation: context.operation, path: context.path, field },
      );
    }
    return value;
  };

  /**
   * Hoisted out of the returned object because `findDomainByName` calls it.
   *
   * Written as a closure rather than as `this.listDomains()` deliberately: it
   * is the READ-BACK path that resolves a `pending` `provider_operations` row,
   * so it must keep working when a caller destructures the adapter or forwards
   * a bare method reference — the shape `@loxep/app`'s port wrapper takes care
   * to avoid, and which nothing should have to take care to avoid.
   */
  const listDomains = async (
    options: { includeShared?: boolean } = {},
  ): Promise<PurelymailDomainFact[]> => {
    const operation: PurelymailOperation = "domain.list";
    const context: PurelymailErrorContext = {
      operation,
      path: purelymailPath(operation),
    };
    const result = await call(operation, {
      includeShared: options.includeShared ?? false,
    });
    return expectArray(result, "domains", context).map((entry) =>
      toDomainFact(entry, context),
    );
  };

  return {
    baseUrl: config.baseUrl,
    sourceAccountKey,

    async getOwnershipCode() {
      const operation: PurelymailOperation = "domain.ownershipCode";
      const context: PurelymailErrorContext = {
        operation,
        path: purelymailPath(operation),
      };
      // Empty body on purpose: the code is per ACCOUNT, not per domain.
      const result = await call(operation, {});
      return requiredString(asRecord(result)?.["code"], "code", context);
    },

    async addDomain(domainName) {
      await call("domain.add", { domainName });
    },

    listDomains,

    async findDomainByName(name) {
      // A LIST rather than a get: Purelymail has no "get one domain" operation,
      // and reading absence from a list is more trustworthy than reading it
      // from an unverified error code.
      const domains = await listDomains();
      return domains.find((domain) => domain.name === name) ?? null;
    },

    async recheckDomainDns(domainName) {
      // `name`, not `domainName` — this is the one operation in the API that
      // calls the field `name`, and getting it wrong would silently no-op.
      await call("domain.updateSettings", { name: domainName, recheckDns: true });
    },

    async createUser(userInput) {
      await call("user.create", {
        userName: userInput.userName,
        domainName: userInput.domainName,
        password: userInput.password,
        ...(userInput.enablePasswordReset === undefined
          ? {}
          : { enablePasswordReset: userInput.enablePasswordReset }),
        ...(userInput.enableSearchIndexing === undefined
          ? {}
          : { enableSearchIndexing: userInput.enableSearchIndexing }),
        ...(userInput.sendWelcomeEmail === undefined
          ? {}
          : { sendWelcomeEmail: userInput.sendWelcomeEmail }),
      });
      // Deliberately returns nothing. The minted password must not travel back
      // out of this function, even though the caller supplied it.
    },

    async deleteUser(fullAddress) {
      await call("user.delete", { userName: fullAddress });
    },

    async listUsers() {
      const operation: PurelymailOperation = "user.list";
      const context: PurelymailErrorContext = {
        operation,
        path: purelymailPath(operation),
      };
      const result = await call(operation, {});
      return expectArray(result, "users", context).filter(
        (entry): entry is string => typeof entry === "string",
      );
    },

    async listRoutingRules() {
      const operation: PurelymailOperation = "routing.list";
      const context: PurelymailErrorContext = {
        operation,
        path: purelymailPath(operation),
      };
      const result = await call(operation, {});
      return expectArray(result, "rules", context).map((entry) =>
        toRoutingRuleFact(entry, context),
      );
    },

    async createRoutingRule(ruleInput) {
      await call("routing.create", {
        domainName: ruleInput.domainName,
        // Both are REQUIRED by the document even though they have obvious
        // defaults, so they are always sent rather than conditionally spread.
        prefix: ruleInput.prefix ?? false,
        matchUser: ruleInput.matchUser,
        targetAddresses: [...ruleInput.targetAddresses],
        catchall: ruleInput.catchall ?? false,
      });
    },

    async deleteRoutingRule(routingRuleId) {
      await call("routing.delete", { routingRuleId });
    },

    async checkAccountCredit() {
      const operation: PurelymailOperation = "account.credit";
      const context: PurelymailErrorContext = {
        operation,
        path: purelymailPath(operation),
      };
      const result = await call(operation, {});
      // A STRING, per the document — never parsed to a number here. Money is
      // `numeric` in Loxep and never JS `number` arithmetic.
      return requiredString(asRecord(result)?.["credit"], "credit", context);
    },

    requiredRecords(recordInput) {
      return purelymailRequiredRecords(recordInput);
    },

    capabilities() {
      return {
        provider: "purelymail",
        routingRules: true,
        catchAll: true,
        suppliesMailboxPassword: false,
        ownershipCodeScope: "account",
        maxListedUsers: PURELYMAIL_LIST_USER_LIMIT,
        requiredRecordCount: purelymailRequiredRecords({
          domainName: "example.test",
          ownershipCode: "probe",
        }).length,
      };
    },

    stats() {
      return {
        baseUrl: config.baseUrl,
        sourceAccountKey,
        rateBudget: budget.stats(),
        requests,
      };
    },
  };
}

// `purelymailFullAddress` and `PURELYMAIL_OPERATIONS` are deliberately NOT
// re-exported from here. They belong to `config.ts` and `operations.ts`, and
// `index.ts` publishes them from there — one export path per symbol, so a
// reader looking for where the operation map lives finds exactly one answer.
