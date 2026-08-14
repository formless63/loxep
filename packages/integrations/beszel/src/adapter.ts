/**
 * The Beszel read adapter (ADR-0009, loxep-9j6).
 *
 * Beszel is the fleet's metrics hub. Loxep reads **one row per system: is it
 * up, and how fresh is that claim** — and nothing else. It does not read, store,
 * or chart CPU/memory/disk series, because
 * [rule 13](../../../../apps/docs/src/content/docs/architecture/domain-boundaries.md)
 * permits *"a companion's latest observed status"* and forbids *"its metric
 * history"*, and because the fleet-observability design's enforcement test is
 * blunt: a milestone that ships a chart of CPU over time *"has started
 * rebuilding Beszel"*.
 *
 * **No provider response type is exported from this package.** Everything
 * crossing the boundary is a Loxep-owned fact, so a consumer re-declares the
 * shapes it needs structurally and takes no dependency here — the discipline
 * `@loxep/commerce` applies to the eBay fact types and `@loxep/infrastructure`
 * applies to Cloudflare's.
 *
 * ## Verification trail, 2026-08-13
 *
 * The owner supplied https://beszel.dev/guide/rest-api as the primary source
 * and it is the reason this package exists at all — the fleet-observability
 * design's Beszel verdict predates it. Three findings, in order of weight:
 *
 * 1. **The design's blocking claim is false.** It stated *"a read consumer needs
 *    a superuser credential… there is no scoped read-only token"*. Upstream
 *    documents a `readonly` role in the ordinary `users` collection —
 *    *"Read-only users cannot create systems but can view any system shared
 *    with them by an admin and create alerts"*
 *    (https://beszel.dev/guide/user-accounts) — and states that *"regular user
 *    accounts and PocketBase superuser accounts are entirely separate"*. The
 *    REST guide's own first example authenticates *"as regular user"*. This
 *    adapter therefore authenticates against the `users` collection and a
 *    boundary test asserts `_superusers` never appears in a URL.
 * 2. **The wire contract is PocketBase's, wholesale**: *"Because Beszel is
 *    built on PocketBase, you can use the PocketBase web APIs and client-side
 *    SDKs to read or update data from outside Beszel itself."* Paging,
 *    filtering, the `{page, perPage, totalItems, totalPages, items}` envelope,
 *    and the `{status, message, data}` error shape all come from
 *    https://pocketbase.io/docs/api-records/.
 * 3. **The shape warning stands and is designed around**: *"the structure and
 *    content of data returned by the API may change in minor releases."* Every
 *    field except `id` is therefore OPTIONAL at this boundary, and a record
 *    that loses a field degrades to `null` on one fact instead of failing a
 *    whole fleet read.
 * 4. **Live-run confirmation, 2026-08-14.** A run against a real hub (v0.18.x)
 *    confirmed point 1 empirically, not just from reading docs: the adapter
 *    authenticated and listed systems using the ordinary `users`-collection
 *    credential, never touching `_superusers` — the readonly PocketBase role
 *    this package relies on actually works against a live hub. The same run
 *    is also the source of the field-presence observation below.
 *
 * ## Which system fields are documented, which were UNVERIFIED, and what one live hub showed
 *
 * Beszel publishes no schema for the `systems` collection. Two fields are
 * confirmed from the REST guide's own examples — `status` (its filter example
 * is `status = "up"`) and `users` (its second example selects
 * `fields: 'id,users'` and updates the array) — plus `id`, which PocketBase
 * guarantees for every record. `name`, `host`, `port`, and `updated` had no
 * such documentation and were carried as UNVERIFIED guesses at the names a
 * PocketBase collection of monitored hosts would plausibly use.
 *
 * **Now OBSERVED, not just guessed**: a live run against one real hub
 * (v0.18.x, 2026-08-14) reported every one of those fields present —
 * `{ name: true, host: true, port: true, status: true, observedAt: true }`
 * (`test/live-beszel.test.ts`, whose standing job was exactly this
 * replacement). That is real evidence the names are right, from the hub that
 * was actually asked.
 *
 * **What this does and does not prove**: one hub confirming a field is
 * present today is not a schema guarantee from an upstream that publishes
 * none — the REST guide's own shape warning (point 3 above) still applies to
 * a different hub, a future Beszel release, or a system record under
 * different settings. Nothing here has been loosened on the strength of this
 * observation: every field but `id` remains OPTIONAL at this boundary and the
 * parsing still degrades to `null` on absence exactly as it did before this
 * paragraph was rewritten. Treat this as "confirmed observed, still
 * defensively parsed," not "now guaranteed."
 *
 * ## Read-only by construction
 *
 * PocketBase exposes `PATCH` and `DELETE` on `systems` and the
 * fleet-observability design names the risk directly: *"Beszel can update a
 * system record. Those calls exist and are reachable."* This adapter exports no
 * function that mutates anything, `operations.ts` lists no mutating path, and
 * `test/boundary.test.ts` asserts that every request the adapter made used
 * `GET` apart from the single login `POST`.
 */
import { z } from "zod";
import {
  BESZEL_ALLOWED_NON_GET_PATHS,
  BESZEL_AUTH_PATH,
  BESZEL_HEALTH_PATH,
  BESZEL_LIST_PER_PAGE,
  BESZEL_MAX_LIST_PAGES,
  BESZEL_SYSTEMS_PATH,
} from "./operations.ts";
import {
  BeszelAdapterError,
  beszelErrorFromResponse,
  normalizeBeszelError,
  readBeszelErrorEnvelope,
} from "./errors.ts";
import {
  type BeszelAdapterConfig,
  type BeszelAdapterConfigInput,
  parseBeszelAdapterConfig,
} from "./config.ts";
import {
  BESZEL_SUGGESTED_CAPACITY,
  BESZEL_SUGGESTED_REFILL_PER_SECOND,
  type BeszelAdapterLogger,
  type RateBudget,
  type RateBudgetStats,
  createRateBudget,
} from "./rate-budget.ts";

/** The injected `fetch`. Every test passes a stub; nothing here calls global. */
export type BeszelFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/**
 * One monitored machine, in Loxep's vocabulary.
 *
 * `status` is the hub's **own string, verbatim** — the same discipline
 * `ProviderZone.status` applies to Cloudflare. Beszel's guide demonstrates the
 * value `"up"` and publishes no enumeration of the rest, so mapping unknown
 * values onto a Loxep union would invent a fact. A consumer branches on `"up"`
 * and renders anything else as-is.
 */
export interface BeszelSystemFact {
  /** The PocketBase record id. The only field upstream guarantees. */
  externalSystemId: string;
  /** Field name observed present on a live hub (2026-08-14, see module doc); not a schema guarantee — `null` when absent. */
  name: string | null;
  /** Field name observed present on a live hub (2026-08-14, see module doc); not a schema guarantee — `null` when absent. */
  host: string | null;
  /** Field name observed present on a live hub (2026-08-14, see module doc); not a schema guarantee — `null` when absent or unparseable. */
  port: number | null;
  /** Verbatim. `""` when the record carried no status at all. */
  status: string;
  /** The record's own last-write time; field name observed present on a live hub (2026-08-14, see module doc), not a schema guarantee. */
  observedAt: string | null;
  /** How many accounts this system is shared with. Never the ids. */
  sharedWithCount: number;
}

/** The unauthenticated reachability probe — Beszel's whole tier-2 surface. */
export interface BeszelHealthFact {
  reachable: boolean;
  httpStatus: number;
  /** PocketBase's own message, e.g. `"API is healthy."`. */
  message: string | null;
}

export interface BeszelCapabilities {
  provider: "beszel";
  /** Structural, not a policy flag: no mutating member exists on the adapter. */
  readOnly: true;
  /** An unauthenticated health path exists (tier 2 without a credential). */
  unauthenticatedHealthProbe: true;
  /** Loxep reads current status only. Rule 13 forbids the history. */
  metricHistory: false;
  /** Upstream warns record shapes may change in minor releases. */
  stableRecordShapes: false;
}

export interface BeszelAdapterStats {
  rateBudget: RateBudgetStats;
  /** Login exchanges performed since creation. Should stay very small. */
  authExchanges: number;
  /** Requests retried once after a mid-run token expiry. */
  reauthRetries: number;
}

export interface BeszelAdapter {
  /** Unauthenticated. Safe to call before any credential is stored. */
  health(): Promise<BeszelHealthFact>;
  /** Every system the authenticated readonly user can see. */
  listSystems(options?: { filter?: string }): Promise<BeszelSystemFact[]>;
  capabilities(): BeszelCapabilities;
  stats(): BeszelAdapterStats;
}

export interface CreateBeszelAdapterInput {
  config: BeszelAdapterConfigInput;
  credentials: { email: string; password: string };
  fetchImpl: BeszelFetch;
  logger?: BeszelAdapterLogger;
  rateBudget?: RateBudget;
}

/**
 * The list envelope. **PB** — https://pocketbase.io/docs/api-records/.
 *
 * `z.object` STRIPS unknown keys, which is the boundary behaviour ADR-0009
 * wants: an upstream addition is dropped here rather than propagating into a
 * Loxep fact by accident.
 */
const listEnvelopeSchema = z.object({
  page: z.number().optional(),
  perPage: z.number().optional(),
  totalItems: z.number().optional(),
  totalPages: z.number().optional(),
  items: z.array(z.unknown()),
});

/**
 * One `systems` record. Only `id` is required — see the module doc on which
 * field names are documented and which are inferred.
 */
const systemRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  host: z.string().optional(),
  port: z.union([z.string(), z.number()]).optional(),
  status: z.string().optional(),
  updated: z.string().optional(),
  users: z.array(z.unknown()).optional(),
});

/** The login response. `token` is read and never stored beyond memory. */
const authResponseSchema = z.object({
  token: z.string().min(1),
});

const healthResponseSchema = z.object({
  status: z.number().optional(),
  message: z.string().optional(),
});

function toPort(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
    ? parsed
    : null;
}

export function createBeszelAdapter(
  input: CreateBeszelAdapterInput,
): BeszelAdapter {
  const config: BeszelAdapterConfig = parseBeszelAdapterConfig(input.config);
  const { fetchImpl, logger } = input;
  const email = input.credentials.email;
  const password = input.credentials.password;
  if (email === "" || password === "") {
    throw new BeszelAdapterError(
      "invalid_request",
      "Beszel credentials require both an email and a password",
    );
  }

  const rateBudget =
    input.rateBudget ??
    createRateBudget({
      capacity: BESZEL_SUGGESTED_CAPACITY,
      refillPerSecond: BESZEL_SUGGESTED_REFILL_PER_SECOND,
      ...(logger === undefined ? {} : { logger }),
    });

  /**
   * The cached auth token. In memory, for the life of this adapter instance,
   * and deliberately not persisted: PocketBase tokens are short-lived, a stored
   * one would be a second credential to protect for no benefit, and re-logging
   * in costs one request.
   */
  let authToken: string | null = null;
  let authExchanges = 0;
  let reauthRetries = 0;

  const request = async (
    path: string,
    init: {
      method: "GET" | "POST";
      query?: Record<string, string>;
      body?: unknown;
      token?: string | null;
    },
    operation: string,
  ): Promise<unknown> => {
    const context = { operation, path };
    if (
      init.method !== "GET" &&
      !BESZEL_ALLOWED_NON_GET_PATHS.includes(
        path as (typeof BESZEL_ALLOWED_NON_GET_PATHS)[number],
      )
    ) {
      // Unreachable through the exported surface. It exists so that a future
      // edit adding a mutating call fails here rather than at the provider.
      throw new BeszelAdapterError(
        "invalid_request",
        "Beszel adapter refused a non-GET request outside the login exchange",
        { operation, path, method: init.method },
      );
    }

    await rateBudget.acquire(1);

    const url = new URL(`${config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.token != null) {
      // PocketBase documents the bare token, not a `Bearer` prefix:
      // https://pocketbase.io/docs/api-records/ shows `Authorization:TOKEN`.
      headers["authorization"] = init.token;
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: init.method,
        headers,
        signal: AbortSignal.timeout(config.timeoutMs),
        ...(init.body === undefined
          ? {}
          : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      throw normalizeBeszelError(error, context);
    }

    let parsed: unknown = null;
    let parseFailed = false;
    try {
      const text = await response.text();
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parseFailed = true;
    }

    if (!response.ok || parseFailed) {
      throw beszelErrorFromResponse(
        response.status,
        parseFailed
          ? { status: null, message: null }
          : readBeszelErrorEnvelope(parsed),
        context,
      );
    }
    return parsed;
  };

  const login = async (): Promise<string> => {
    const body = await request(
      BESZEL_AUTH_PATH,
      {
        method: "POST",
        // PocketBase names the field `identity`; for Beszel it is the email.
        body: { identity: email, password },
      },
      "auth.login",
    );
    const result = authResponseSchema.safeParse(body);
    if (!result.success) {
      throw new BeszelAdapterError(
        "provider_unavailable",
        "Beszel login succeeded but returned no usable token",
        { operation: "auth.login", path: BESZEL_AUTH_PATH },
      );
    }
    authExchanges += 1;
    authToken = result.data.token;
    return result.data.token;
  };

  /**
   * Run an authenticated read, logging in first if needed and **exactly once**
   * more if the hub rejects the cached token mid-run.
   *
   * The retry is bounded to one attempt on purpose. A token that expired
   * between two pages of the same read is an ordinary race and re-logging in
   * fixes it; a login that yields a token the very next call rejects means the
   * account was disabled or its permissions changed, and retrying that in a
   * loop would spend the login rate limit against a credential that will not
   * start working.
   */
  const authenticated = async <T>(
    run: (token: string) => Promise<T>,
  ): Promise<T> => {
    const token = authToken ?? (await login());
    try {
      return await run(token);
    } catch (error) {
      if (error instanceof BeszelAdapterError && error.kind === "auth") {
        authToken = null;
        reauthRetries += 1;
        logger?.debug?.(
          { operation: "auth.retry" },
          "Beszel rejected the cached token; re-authenticating once",
        );
        return await run(await login());
      }
      throw error;
    }
  };

  return {
    async health() {
      const body = await request(
        BESZEL_HEALTH_PATH,
        { method: "GET" },
        "hub.health",
      );
      const parsed = healthResponseSchema.safeParse(body);
      return {
        reachable: true,
        httpStatus: parsed.success ? (parsed.data.status ?? 200) : 200,
        message: parsed.success ? (parsed.data.message ?? null) : null,
      };
    },

    async listSystems(options) {
      return await authenticated(async (token) => {
        const facts: BeszelSystemFact[] = [];
        for (let page = 1; page <= BESZEL_MAX_LIST_PAGES; page++) {
          const query: Record<string, string> = {
            page: String(page),
            perPage: String(BESZEL_LIST_PER_PAGE),
          };
          if (options?.filter !== undefined) query["filter"] = options.filter;

          const body = await request(
            BESZEL_SYSTEMS_PATH,
            { method: "GET", query, token },
            "systems.list",
          );
          const envelope = listEnvelopeSchema.safeParse(body);
          if (!envelope.success) {
            throw new BeszelAdapterError(
              "invalid_request",
              "Beszel systems list did not match the PocketBase list envelope",
              { operation: "systems.list", path: BESZEL_SYSTEMS_PATH },
            );
          }

          for (const item of envelope.data.items) {
            const record = systemRecordSchema.safeParse(item);
            if (!record.success) {
              // One unreadable record must not lose the rest of the fleet.
              // Upstream warns shapes change in minor releases; a fleet view
              // missing one host is recoverable, a failed read is not.
              logger?.warn?.(
                { operation: "systems.list" },
                "Beszel returned a system record Loxep could not read; skipping it",
              );
              continue;
            }
            const value = record.data;
            facts.push({
              externalSystemId: value.id,
              name: value.name ?? null,
              host: value.host ?? null,
              port: toPort(value.port),
              status: value.status ?? "",
              observedAt: value.updated ?? null,
              sharedWithCount: value.users?.length ?? 0,
            });
          }

          const totalPages = envelope.data.totalPages ?? 1;
          if (page >= totalPages || envelope.data.items.length === 0) break;
        }
        return facts;
      });
    },

    capabilities() {
      return {
        provider: "beszel",
        readOnly: true,
        unauthenticatedHealthProbe: true,
        metricHistory: false,
        stableRecordShapes: false,
      };
    },

    stats() {
      return { rateBudget: rateBudget.stats(), authExchanges, reauthRetries };
    },
  };
}
