/**
 * The Gatus read adapter (Phase 8 milestone 4, loxep-ovj.4).
 *
 * Spec: `apps/docs/src/content/docs/architecture/fleet-observability-design.md`,
 * section "Gatus, in detail". **gatus.io/docs is a client-rendered SPA and
 * returns an empty body to a fetcher — every fact this module relies on is
 * verified against the upstream Go SOURCE**, `github.com/TwiN/gatus`, tag
 * `v5.36.0` (2026-05-19, Apache-2.0). File-level citations live in
 * `operations.ts` and `errors.ts`; this module documents the BEHAVIOR built
 * on top of them.
 *
 * Scope: read the fleet's endpoint statuses when reachable, and Gatus's own
 * process liveness. No metric history, no suites, no alerts, no writes — see
 * "Read-only by construction" below for why the surface enforces that
 * structurally rather than by convention.
 *
 * **No provider response type is exported from this package.** Everything
 * crossing the boundary is a Loxep-owned fact, matching every sibling
 * integration's discipline (`@loxep/integration-beszel` is the closest
 * fleet-observability precedent).
 *
 * ## THE AUTH BRANCH — the reason this package exists
 *
 * `GET /api/v1/config` is the ONLY route this adapter may call without first
 * knowing whether a credential will even be accepted. It answers
 * `{oidc, authenticated}` (`api/config.go`, quoted in full in
 * `operations.ts`), and `oidc === true` is the entire branch:
 *
 * - **`oidc: false`** — either no `security` block at all (the API is fully
 *   open — verified structurally: `api/api.go` only ever attaches auth
 *   middleware to `protectedAPIRouter` `if cfg.Security != nil`) or Basic
 *   auth is configured. Both cases are handled identically: attempt
 *   `GET /api/v1/endpoints/statuses`, attaching `Authorization: Basic
 *   base64(username:password)` when a credential is configured. Sending that
 *   header against a genuinely open instance is harmless — no middleware is
 *   registered to inspect it there.
 * - **`oidc: true`** — `security/oidc.go` proves OIDC has no server-to-server
 *   bearer path at all: a session is minted only by
 *   `POST /authorization-code/callback` after a full browser redirect
 *   through the identity provider, stored server-side (`security/sessions.go`,
 *   an in-memory `gocache`), and presented back only as an HttpOnly cookie
 *   Loxep's own adapter can never hold. **A server-to-server reader cannot
 *   authenticate against `/api/v1/endpoints/statuses` at all.**
 *   `listEndpointStatuses` refuses to even attempt the call in this mode —
 *   it throws `auth` immediately, spending zero network calls, rather than
 *   attempting a request that is provably unwinnable. The caller degrades to
 *   {@link GatusAdapter.endpointUptime}/{@link GatusAdapter.endpointResponseTime}
 *   against endpoint keys it already knows (the `external_resources` rows an
 *   operator registered), which sit on the UNPROTECTED route group and need
 *   no credential in any security mode.
 *
 * **THE UI MUST SAY WHICH MODE IT IS IN.** Silent degradation to a partial
 * view is the failure the design calls out by name: it is what makes an
 * operator trust a green dashboard that is not looking at everything. Every
 * consumer of this adapter surfaces {@link GatusAuthProbeFact.mode}
 * (`capabilities()`/`probeConfig()`) rather than quietly falling back.
 * `probeConfig()`/`capabilities()` issue a FRESH probe on every call rather
 * than caching one — Gatus's own config directory hot-reloads every 30
 * seconds (the design doc's own fact), so a cached mode could tell an
 * operator who just added `security.oidc` that Loxep is still reading
 * everything when it no longer can.
 *
 * ## Read-only by construction
 *
 * `api/api.go`'s entire route table has exactly one non-`GET` entry:
 * `POST /api/v1/endpoints/:key/external`, gated on its own bearer token and
 * reserved for the OUTWARD push (`@loxep/app`'s `gatus-push.ts`, shipped
 * separately as milestone 2 — a Loxep-owned endpoint, never a fleet tool's).
 * This module exports no function that could reach it: every exported read
 * issues a `GET`, and `test/boundary.test.ts` asserts that directly rather
 * than allowing an exception list.
 *
 * ## No metric history, ever
 *
 * `endpointUptime`/`endpointResponseTime` return the CURRENT aggregate over
 * one duration bucket, overwritten in place on every call — never a series.
 * Rule 13 and this design's own enforcement test both name a chart of
 * response time over time as "rebuilding Gatus," and nothing here returns
 * one.
 */
import { z } from "zod";
import {
  GATUS_CONFIG_PATH,
  GATUS_ENDPOINT_STATUSES_PATH,
  GATUS_HEALTH_PATH,
  type GatusUptimeDuration,
  assertGatusUptimeDuration,
  gatusEndpointResponseTimePath,
  gatusEndpointUptimePath,
} from "./operations.ts";
import {
  GatusAdapterError,
  gatusErrorFromResponse,
  normalizeGatusError,
} from "./errors.ts";
import {
  type GatusAdapterConfig,
  type GatusAdapterConfigInput,
  parseGatusAdapterConfig,
} from "./config.ts";
import {
  GATUS_SUGGESTED_CAPACITY,
  GATUS_SUGGESTED_REFILL_PER_SECOND,
  type GatusAdapterLogger,
  type RateBudget,
  type RateBudgetStats,
  createRateBudget,
} from "./rate-budget.ts";

export type { GatusUptimeDuration } from "./operations.ts";

/** The injected `fetch`. Every test passes a stub; nothing here calls global. */
export type GatusFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/** `direct` reads the bulk statuses endpoint; `oidc_degraded` cannot. */
export type GatusAuthMode = "direct" | "oidc_degraded";

/** The result of probing `GET /api/v1/config` — see the module doc's auth branch. */
export interface GatusAuthProbeFact {
  oidc: boolean;
  /**
   * Verbatim from Gatus, but see the module/`operations.ts` doc: this field
   * only ever reflects an OIDC session cookie already being valid on THIS
   * request, never whether Basic auth would be accepted.
   */
  authenticated: boolean;
  mode: GatusAuthMode;
}

/** Gatus's own process-liveness probe (`GET /health`, unauthenticated). */
export interface GatusHealthFact {
  reachable: boolean;
  /** Verbatim `"UP"`/`"DOWN"`, or `null` if the body carried neither. */
  status: string | null;
  httpStatus: number;
}

/**
 * One endpoint's current status, in Loxep's vocabulary. Derived from the
 * LATEST entry in Gatus's own `results` array — never the array itself, per
 * "no metric history, ever" above.
 */
export interface GatusEndpointStatusFact {
  /** Gatus's own `<group>_<name>` key (`config/key/key.go`'s `ConvertGroupAndNameToKey`). */
  key: string;
  name: string | null;
  group: string | null;
  /** The latest evaluation's outcome, or `null` when Gatus has none recorded yet. */
  success: boolean | null;
  httpStatus: number | null;
  /** The latest evaluation's own timestamp, ISO 8601 verbatim from Gatus. */
  observedAt: string | null;
  /** Count only — see `redact.ts` for why condition-failure text never crosses this boundary raw. */
  errorCount: number;
}

/** `GET /api/v1/endpoints/:key/uptimes/:duration` — a fraction, 0..1, NOT a percentage. */
export interface GatusUptimeFact {
  key: string;
  duration: GatusUptimeDuration;
  uptime: number | null;
}

/** `GET /api/v1/endpoints/:key/response-times/:duration` — milliseconds. */
export interface GatusResponseTimeFact {
  key: string;
  duration: GatusUptimeDuration;
  averageMs: number | null;
}

export interface GatusCapabilities {
  provider: "gatus";
  /** Structural, not a policy flag: no mutating member exists on the adapter. */
  readOnly: true;
  /** From the freshest `/api/v1/config` probe — see the module doc. */
  mode: GatusAuthMode;
  oidc: boolean;
  /** `GET /health` needs no credential in any security mode. */
  unauthenticatedHealthProbe: true;
  /** The two per-endpoint routes need no credential in any security mode. */
  perEndpointUptimeAvailable: true;
  /** `false` exactly when `mode === "oidc_degraded"`. */
  endpointStatusesAvailable: boolean;
  /** Loxep reads current status only. Rule 13 forbids the history. */
  metricHistory: false;
}

export interface GatusAdapterStats {
  rateBudget: RateBudgetStats;
  /** `GET /api/v1/config` calls made since creation — one per probe/capabilities call. */
  configProbes: number;
}

export interface GatusAdapter {
  /** Unauthenticated. Always the first call — decides which reads are reachable. */
  probeConfig(): Promise<GatusAuthProbeFact>;
  /** Unauthenticated. Gatus's own process liveness, independent of `security`. */
  health(): Promise<GatusHealthFact>;
  /**
   * `GET /api/v1/endpoints/statuses`. Throws `auth` immediately, with no
   * network call, when the freshest probe reports `oidc: true` — see the
   * module doc's auth branch.
   */
  listEndpointStatuses(options?: {
    page?: number;
    pageSize?: number;
  }): Promise<GatusEndpointStatusFact[]>;
  /** Unauthenticated in every security mode — the OIDC-degraded fallback. */
  endpointUptime(
    key: string,
    duration: GatusUptimeDuration,
  ): Promise<GatusUptimeFact>;
  /** Unauthenticated in every security mode — the OIDC-degraded fallback. */
  endpointResponseTime(
    key: string,
    duration: GatusUptimeDuration,
  ): Promise<GatusResponseTimeFact>;
  /** Re-probes `/api/v1/config` on every call — see the module doc's freshness note. */
  capabilities(): Promise<GatusCapabilities>;
  stats(): GatusAdapterStats;
}

export interface CreateGatusAdapterInput {
  config: GatusAdapterConfigInput;
  /**
   * OPTIONAL, unlike every sibling's login: Gatus may run fully open, or
   * OIDC-secured with no bearer path a reader could hold at all — see
   * `gatus_credentials` in `@loxep/domain` and the module doc's auth branch.
   */
  credentials?: { username: string; password: string };
  fetchImpl: GatusFetch;
  logger?: GatusAdapterLogger;
  rateBudget?: RateBudget;
}

const configProbeResponseSchema = z.object({
  oidc: z.boolean(),
  authenticated: z.boolean(),
});

const healthResponseSchema = z.object({
  status: z.string().optional(),
  reason: z.string().optional(),
});

const conditionResultSchema = z.unknown();

const resultSchema = z.object({
  status: z.number().optional(),
  success: z.boolean().optional(),
  timestamp: z.string().optional(),
  errors: z.array(z.string()).optional(),
  conditionResults: z.array(conditionResultSchema).optional(),
});

/** `config/endpoint/status.go`'s `Status` DTO. Only `key` is unconditional. */
const endpointStatusSchema = z.object({
  key: z.string().min(1),
  name: z.string().optional(),
  group: z.string().optional(),
  results: z.array(resultSchema).optional(),
});

const endpointStatusesResponseSchema = z.array(z.unknown());

function basicAuthHeader(credentials?: {
  username: string;
  password: string;
}): string | null {
  if (credentials === undefined) return null;
  const encoded = Buffer.from(
    `${credentials.username}:${credentials.password}`,
    "utf8",
  ).toString("base64");
  return `Basic ${encoded}`;
}

export function createGatusAdapter(
  input: CreateGatusAdapterInput,
): GatusAdapter {
  const config: GatusAdapterConfig = parseGatusAdapterConfig(input.config);
  const { fetchImpl, logger, credentials } = input;
  if (
    credentials !== undefined &&
    (credentials.username === "" || credentials.password === "")
  ) {
    throw new GatusAdapterError(
      "invalid_request",
      "Gatus credentials, if supplied, require both a username and a password",
    );
  }

  const rateBudget =
    input.rateBudget ??
    createRateBudget({
      capacity: GATUS_SUGGESTED_CAPACITY,
      refillPerSecond: GATUS_SUGGESTED_REFILL_PER_SECOND,
      ...(logger === undefined ? {} : { logger }),
    });

  let configProbes = 0;

  const rawRequest = async (
    path: string,
    init: {
      query?: Record<string, string>;
      authorize?: boolean;
    },
    operation: string,
  ): Promise<{ status: number; text: string }> => {
    const context = { operation, path };
    await rateBudget.acquire(1);

    const url = new URL(`${config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = { accept: "*/*" };
    if (init.authorize === true) {
      const header = basicAuthHeader(credentials);
      if (header !== null) headers["authorization"] = header;
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      throw normalizeGatusError(error, context);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw normalizeGatusError(error, context);
    }
    return { status: response.status, text };
  };

  const requestJson = async (
    path: string,
    init: { query?: Record<string, string>; authorize?: boolean },
    operation: string,
  ): Promise<unknown> => {
    const context = { operation, path };
    const { status, text } = await rawRequest(path, init, operation);
    if (status < 200 || status >= 300) {
      throw gatusErrorFromResponse(status, text, context);
    }
    try {
      return text === "" ? null : JSON.parse(text);
    } catch {
      throw new GatusAdapterError(
        "provider_unavailable",
        "Gatus returned a 2xx response that was not valid JSON",
        { operation, path, httpStatus: status },
      );
    }
  };

  const runProbe = async (): Promise<GatusAuthProbeFact> => {
    const body = await requestJson(GATUS_CONFIG_PATH, {}, "config.probe");
    configProbes += 1;
    const parsed = configProbeResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new GatusAdapterError(
        "invalid_request",
        "Gatus config probe did not match the documented {oidc, authenticated} shape",
        { operation: "config.probe", path: GATUS_CONFIG_PATH },
      );
    }
    return {
      oidc: parsed.data.oidc,
      authenticated: parsed.data.authenticated,
      mode: parsed.data.oidc ? "oidc_degraded" : "direct",
    };
  };

  return {
    async probeConfig() {
      return await runProbe();
    },

    async health() {
      // Deliberately NOT routed through requestJson: health.go maps a DOWN
      // status to HTTP 500 with a well-formed JSON body — a genuine health
      // fact, not a provider failure — so this path treats the body as
      // authoritative whenever it parses, regardless of HTTP status.
      const { status, text } = await rawRequest(
        GATUS_HEALTH_PATH,
        {},
        "hub.health",
      );
      let parsedBody: unknown = null;
      try {
        parsedBody = text === "" ? null : JSON.parse(text);
      } catch {
        // Falls through: an unparseable body at this path means something
        // other than Gatus answered (a proxy error page), not a DOWN status.
        throw new GatusAdapterError(
          "provider_unavailable",
          "Gatus /health did not return a JSON body",
          { operation: "hub.health", path: GATUS_HEALTH_PATH, httpStatus: status },
        );
      }
      const parsed = healthResponseSchema.safeParse(parsedBody);
      return {
        reachable: true,
        status: parsed.success ? (parsed.data.status ?? null) : null,
        httpStatus: status,
      };
    },

    async listEndpointStatuses(options) {
      const probe = await runProbe();
      if (probe.mode === "oidc_degraded") {
        throw new GatusAdapterError(
          "auth",
          "Gatus is OIDC-secured; a server-to-server reader cannot authenticate " +
            "against /api/v1/endpoints/statuses because OIDC resolves a client " +
            "from a session cookie only. Use endpointUptime/endpointResponseTime " +
            "against known endpoint keys instead.",
          { operation: "endpoints.statuses", mode: probe.mode },
        );
      }
      const query: Record<string, string> = {};
      if (options?.page !== undefined) query["page"] = String(options.page);
      if (options?.pageSize !== undefined) {
        query["pageSize"] = String(options.pageSize);
      }
      const body = await requestJson(
        GATUS_ENDPOINT_STATUSES_PATH,
        { query, authorize: true },
        "endpoints.statuses",
      );
      const envelope = endpointStatusesResponseSchema.safeParse(body);
      if (!envelope.success) {
        throw new GatusAdapterError(
          "invalid_request",
          "Gatus endpoint statuses did not return a JSON array",
          { operation: "endpoints.statuses", path: GATUS_ENDPOINT_STATUSES_PATH },
        );
      }
      const facts: GatusEndpointStatusFact[] = [];
      for (const item of envelope.data) {
        const record = endpointStatusSchema.safeParse(item);
        if (!record.success) {
          logger?.warn?.(
            { operation: "endpoints.statuses" },
            "Gatus returned an endpoint status Loxep could not read; skipping it",
          );
          continue;
        }
        const value = record.data;
        const latest = value.results?.at(-1);
        facts.push({
          key: value.key,
          name: value.name ?? null,
          group: value.group ?? null,
          success: latest?.success ?? null,
          httpStatus: latest?.status ?? null,
          observedAt: latest?.timestamp ?? null,
          errorCount: latest?.errors?.length ?? 0,
        });
      }
      return facts;
    },

    async endpointUptime(key, duration) {
      assertGatusUptimeDuration(duration);
      const path = gatusEndpointUptimePath(key, duration);
      const { status, text } = await rawRequest(path, {}, "endpoints.uptime");
      if (status < 200 || status >= 300) {
        throw gatusErrorFromResponse(status, text, {
          operation: "endpoints.uptime",
          path,
        });
      }
      const value = Number.parseFloat(text.trim());
      if (!Number.isFinite(value)) {
        throw new GatusAdapterError(
          "invalid_request",
          "Gatus uptime response was not a parseable number",
          { operation: "endpoints.uptime", path },
        );
      }
      return { key, duration, uptime: value };
    },

    async endpointResponseTime(key, duration) {
      assertGatusUptimeDuration(duration);
      const path = gatusEndpointResponseTimePath(key, duration);
      const { status, text } = await rawRequest(
        path,
        {},
        "endpoints.responseTime",
      );
      if (status < 200 || status >= 300) {
        throw gatusErrorFromResponse(status, text, {
          operation: "endpoints.responseTime",
          path,
        });
      }
      const value = Number.parseInt(text.trim(), 10);
      if (!Number.isFinite(value)) {
        throw new GatusAdapterError(
          "invalid_request",
          "Gatus response-time response was not a parseable integer",
          { operation: "endpoints.responseTime", path },
        );
      }
      return { key, duration, averageMs: value };
    },

    async capabilities() {
      const probe = await runProbe();
      return {
        provider: "gatus",
        readOnly: true,
        mode: probe.mode,
        oidc: probe.oidc,
        unauthenticatedHealthProbe: true,
        perEndpointUptimeAvailable: true,
        endpointStatusesAvailable: probe.mode === "direct",
        metricHistory: false,
      };
    },

    stats() {
      return { rateBudget: rateBudget.stats(), configProbes };
    },
  };
}
