/**
 * Pangolin adapter factory for the worker pipeline (Pangolin chain design
 * milestone 2 composition-root wiring, loxep-acj.2; the M1 catalog entry
 * that named this shape was `loxep-acj.1`).
 *
 * The Pangolin sibling of `purelymail.ts`: a static, non-OAuth bearer key
 * pair (`apiKeyId`/`apiKeySecret`) plus a non-secret base URL and org id,
 * resolved per connection and handed back as a ready-to-use adapter.
 *
 * ```text
 * connections.config.pangolin.{baseUrl, orgId}   (non-secret)          ─┐
 * per-connection rate budget (token bucket)                             ├─→ PangolinAdapter
 * connection credential 'pangolin_credentials' (apiKeyId/apiKeySecret,  ─┘
 *   ADR-0019)
 * ```
 *
 * ## Where each half of the configuration lives, and why
 *
 * `@loxep/integration-pangolin`'s `config.ts` module doc states the split
 * this factory implements: base URL and org id are non-secret connection
 * configuration, kept out of the ADR-0019 bundle for the same reason
 * `cloudflare_credentials`/`woo_credentials` keep their own account
 * identifiers out — it must stay readable without a decryption round-trip,
 * to render the connection and to compute `pangolinSourceAccountKey`. It is
 * namespaced here under `config.pangolin`, matching every sibling factory's
 * own namespaced block (`config.cloudflare`, `config.beszel`).
 *
 * ## Rate budget — per CONNECTION, and deliberately small
 *
 * Pangolin publishes NO documented rate limit on its Integration API server
 * and one was verified ABSENT in source (`@loxep/integration-pangolin`'s own
 * module doc). An undocumented limit is one nobody can design against, so
 * this factory adopts the SAME numbers `@loxep/integration-pangolin`
 * suggests (`PANGOLIN_SUGGESTED_CAPACITY`/`_REFILL_PER_SECOND`, which are
 * themselves Purelymail's numbers, for the identical reason): "the absence
 * of a published limit is an argument for a smaller default, not a larger
 * one."
 *
 * ## The interval floor is an HOUR, matching Cloudflare's
 *
 * Proxy-resource intent changes rarely and this milestone's reconciler is
 * CHECK MODE ONLY — there is no latency-sensitive apply waiting on a faster
 * cadence. `PANGOLIN_ABSOLUTE_MIN_INTERVAL_SECONDS` encodes the same
 * politeness floor `cloudflare.ts`/`purelymail.ts` use.
 *
 * ## Caching
 *
 * The built adapter is cached per connection for
 * {@link PANGOLIN_ADAPTER_CACHE_TTL_MS}, mirroring every other static-credential
 * factory in this package: no token to refresh, so a rebuild costs one
 * connection read plus one credential decryption, and the short TTL is what
 * makes an operator's key rotation take effect without a restart. The
 * per-connection budget lives OUTSIDE the cache and survives every rebuild.
 *
 * ABSOLUTE RULE honored here: the API key secret is never logged, put in an
 * error message, or returned to a caller. The adapter keeps it in a closure
 * and exposes only `baseUrl`, `orgId`, `sourceAccountKey`, and budget
 * statistics.
 */
import type { ConnectionCredentialsService, ConnectionsService } from "@loxep/domain";
import { SecretNotFoundError } from "@loxep/domain";
import type { JobsLogger } from "@loxep/jobs";
import {
  PANGOLIN_SUGGESTED_CAPACITY,
  PANGOLIN_SUGGESTED_REFILL_PER_SECOND,
  createPangolinAdapter,
  createRateBudget,
  pangolinSourceAccountKey,
} from "@loxep/integration-pangolin";
import type { PangolinAdapter, RateBudget } from "@loxep/integration-pangolin";
import { AppConfigurationError } from "./errors.ts";

/** `connections.provider` value the Pangolin/proxy pipeline accepts. */
export const PANGOLIN_CONNECTION_PROVIDER = "pangolin";
/** Registered credential purpose holding the bearer key pair (ADR-0019). */
export const PANGOLIN_CREDENTIAL_TYPE = "pangolin_credentials";
/** Non-secret block on `connections.config` holding the base URL and org id. */
export const PANGOLIN_CONNECTION_CONFIG_KEY = "pangolin";

/** Per-connection token-bucket defaults (see the module doc). */
export const PANGOLIN_RATE_BUDGET_CAPACITY = PANGOLIN_SUGGESTED_CAPACITY;
export const PANGOLIN_RATE_BUDGET_REFILL_PER_SECOND =
  PANGOLIN_SUGGESTED_REFILL_PER_SECOND;
/** Provider calls one check-mode reconcile spends: one `listResources`. */
export const PANGOLIN_CALLS_PER_SYNC = 1;
/** Politeness floor for a proxy-resource check-mode reconcile: one hour. */
export const PANGOLIN_ABSOLUTE_MIN_INTERVAL_SECONDS = 3600;
/** How long a built adapter is reused before it is rebuilt from storage. */
export const PANGOLIN_ADAPTER_CACHE_TTL_MS = 300_000;

/** The Pangolin credential or connection config is missing or malformed. */
export class PangolinCredentialsMissingError extends AppConfigurationError {}

/** Token-bucket parameters: burst size and sustained calls per second. */
export interface PangolinRateBudgetConfig {
  capacity: number;
  refillPerSecond: number;
}

/** The per-connection handle the proxy reconcile executor works with. */
export interface PangolinConnectionAdapter {
  connectionId: string;
  /** Non-secret base URL. */
  baseUrl: string;
  /** Non-secret org id this connection is bound to, or `null` for a root key. */
  orgId: string | null;
  /** `pangolinSourceAccountKey(baseUrl)`. */
  sourceAccountKey: string;
  adapter: PangolinAdapter;
  /** The per-connection rate-budget floor, in whole seconds. */
  minIntervalSeconds: number;
}

export interface PangolinAdapterFactory {
  (connectionId: string): Promise<PangolinConnectionAdapter>;
}

/** How a provider client is constructed from resolved config + budget. */
export type PangolinAdapterConstructor = (input: {
  baseUrl: string;
  orgId: string | undefined;
  apiKeyId: string;
  apiKeySecret: string;
  rateBudget: RateBudget;
  logger: JobsLogger | undefined;
}) => PangolinAdapter;

const defaultAdapterConstructor: PangolinAdapterConstructor = ({
  baseUrl,
  orgId,
  apiKeyId,
  apiKeySecret,
  rateBudget,
  logger,
}) =>
  createPangolinAdapter({
    config: { baseUrl, ...(orgId !== undefined ? { orgId } : {}) },
    credentials: { apiKeyId, apiKeySecret },
    fetchImpl: (input, init) => globalThis.fetch(input, init),
    rateBudget,
    ...(logger !== undefined ? { logger } : {}),
  });

export interface CreatePangolinAdapterFactoryOptions {
  connections: ConnectionsService;
  connectionCredentials: ConnectionCredentialsService;
  logger?: JobsLogger;
  /** Override the token-bucket defaults (tests, gentle deployments). */
  rateBudget?: PangolinRateBudgetConfig;
  /** Provider-client constructor seam (tests inject a fake adapter). */
  createAdapter?: PangolinAdapterConstructor;
}

/** Per-connection interval floor derived from a token bucket. */
export function pangolinRateBudgetIntervalFloorSeconds(budget: {
  refillPerSecond: number;
}): number {
  return Math.max(
    PANGOLIN_ABSOLUTE_MIN_INTERVAL_SECONDS,
    Math.ceil(PANGOLIN_CALLS_PER_SYNC / budget.refillPerSecond),
  );
}

/** Reads `connections.config.pangolin.{baseUrl, orgId}`. Neither is required to be present here — absence is a configuration error surfaced when a build is actually attempted. */
export function readPangolinConnectionConfig(
  config: Record<string, unknown>,
): { baseUrl: string | null; orgId: string | null } {
  const block = config[PANGOLIN_CONNECTION_CONFIG_KEY];
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return { baseUrl: null, orgId: null };
  }
  const record = block as Record<string, unknown>;
  const baseUrl = record["baseUrl"];
  const orgId = record["orgId"];
  return {
    baseUrl: typeof baseUrl === "string" && baseUrl !== "" ? baseUrl : null,
    orgId: typeof orgId === "string" && orgId !== "" ? orgId : null,
  };
}

interface CacheEntry {
  adapter: PangolinConnectionAdapter;
  expiresAtMs: number;
  budgetConfig: PangolinRateBudgetConfig;
}

/** Build the connection-scoped Pangolin adapter factory. */
export function createPangolinAdapterFactory(
  options: CreatePangolinAdapterFactoryOptions,
): {
  getAdapterForConnection: PangolinAdapterFactory;
  invalidate: (connectionId: string) => void;
  intervalFloorSeconds: number;
} {
  const { connections, connectionCredentials, logger } = options;
  const constructAdapter = options.createAdapter ?? defaultAdapterConstructor;
  const budgetConfig = options.rateBudget ?? {
    capacity: PANGOLIN_RATE_BUDGET_CAPACITY,
    refillPerSecond: PANGOLIN_RATE_BUDGET_REFILL_PER_SECOND,
  };
  const intervalFloorSeconds =
    pangolinRateBudgetIntervalFloorSeconds(budgetConfig);

  // Budgets outlive adapters on purpose — see purelymail.ts's identical note.
  const budgets = new Map<string, RateBudget>();
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<PangolinConnectionAdapter>>();

  function budgetFor(connectionId: string): RateBudget {
    const existing = budgets.get(connectionId);
    if (existing !== undefined) return existing;
    const budget = createRateBudget({
      capacity: budgetConfig.capacity,
      refillPerSecond: budgetConfig.refillPerSecond,
      ...(logger !== undefined ? { logger } : {}),
    });
    budgets.set(connectionId, budget);
    return budget;
  }

  function invalidate(connectionId: string): void {
    cache.delete(connectionId);
  }

  async function build(connectionId: string): Promise<PangolinConnectionAdapter> {
    const connection = await connections.getConnection(connectionId);
    if (connection.provider !== PANGOLIN_CONNECTION_PROVIDER) {
      throw new PangolinCredentialsMissingError(
        `connection ${connectionId} has provider "${connection.provider}"; the proxy pipeline needs a "${PANGOLIN_CONNECTION_PROVIDER}" connection`,
      );
    }

    const { baseUrl, orgId } = readPangolinConnectionConfig(
      connection.config as Record<string, unknown>,
    );
    if (baseUrl === null) {
      throw new PangolinCredentialsMissingError(
        `connection ${connectionId} has no "${PANGOLIN_CONNECTION_CONFIG_KEY}.baseUrl" in its config; add the Pangolin Integration API base URL before reconciling proxy resources`,
      );
    }

    let payload: { apiKeyId: string; apiKeySecret: string };
    try {
      const credential = await connectionCredentials.getCredentialPayload(
        connectionId,
        PANGOLIN_CREDENTIAL_TYPE,
      );
      payload = credential.payload;
    } catch (error) {
      if (!(error instanceof SecretNotFoundError)) throw error;
      throw new PangolinCredentialsMissingError(
        `connection ${connectionId} has no stored "${PANGOLIN_CREDENTIAL_TYPE}" credential; add a Pangolin Integration API key before reconciling proxy resources`,
        { cause: error },
      );
    }

    const adapter = constructAdapter({
      baseUrl,
      orgId: orgId ?? undefined,
      apiKeyId: payload.apiKeyId,
      apiKeySecret: payload.apiKeySecret,
      rateBudget: budgetFor(connectionId),
      logger,
    });

    const resolved: PangolinConnectionAdapter = {
      connectionId,
      baseUrl,
      orgId,
      sourceAccountKey: pangolinSourceAccountKey(baseUrl),
      adapter,
      minIntervalSeconds: intervalFloorSeconds,
    };
    cache.set(connectionId, {
      adapter: resolved,
      expiresAtMs: Date.now() + PANGOLIN_ADAPTER_CACHE_TTL_MS,
      budgetConfig,
    });
    return resolved;
  }

  async function getAdapterForConnection(
    connectionId: string,
  ): Promise<PangolinConnectionAdapter> {
    const cached = cache.get(connectionId);
    if (cached !== undefined && Date.now() < cached.expiresAtMs) {
      return cached.adapter;
    }
    cache.delete(connectionId);
    let pending = inFlight.get(connectionId);
    if (pending === undefined) {
      pending = build(connectionId).finally(() => {
        inFlight.delete(connectionId);
      });
      inFlight.set(connectionId, pending);
    }
    return pending;
  }

  return { getAdapterForConnection, invalidate, intervalFloorSeconds };
}
