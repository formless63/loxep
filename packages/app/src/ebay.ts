/**
 * eBay adapter factory for the worker pipeline (loxep-62y.2).
 *
 * One place resolves everything a live eBay poll needs and hands back a
 * ready-to-use, per-connection adapter pair:
 *
 * ```text
 * keyset (application secret → dev file)      ─┐
 * per-connection rate budget (token bucket)    ├─→ EbayConnectionAdapter
 * oauth_tokens credential → refresh → persist ─┘
 * ```
 *
 * ## Keyset precedence (documented, deliberate)
 *
 * 1. application secret `integration.ebay.keyset` (purpose `ebay_keyset`,
 *    ADR-0019) — the real runtime path;
 * 2. the local dev file `~/.config/loxep/ebay-sandbox.env` — ONLY when no
 *    secret exists, a sandbox bring-up convenience that is never consulted
 *    once the secret is configured.
 *
 * This mirrors `apps/web/src/server/ebay-oauth.ts` exactly, so the web
 * consent flow and the worker poller always agree about which keyset is in
 * use. Nothing here reads provider credentials from environment variables
 * (ADR-0016).
 *
 * ## Rate budget and the derived interval floor
 *
 * Each connection gets ONE {@link RateBudget} (capacity
 * {@link EBAY_RATE_BUDGET_CAPACITY} = 10 tokens, refill
 * {@link EBAY_RATE_BUDGET_REFILL_PER_SECOND} = 1.5 tokens/s ⇒ 90 sustained
 * calls/minute), created once per connection and REUSED across adapter
 * rebuilds so a token refresh never resets the bucket. Both the
 * application-token adapter and the user-context adapter share it, because
 * eBay's limits are per application/user pair rather than per client object.
 *
 * From that budget the factory derives the per-connection **interval floor**
 * the adaptive scheduler must never poll below:
 *
 * ```text
 * floorSeconds = max(
 *   EBAY_ABSOLUTE_MIN_INTERVAL_SECONDS,                       // politeness
 *   ceil(EBAY_BUDGET_TARGETS_PER_CONNECTION / refillPerSecond) // budget share
 * )
 * ```
 *
 * The second term reserves sustained throughput for
 * {@link EBAY_BUDGET_TARGETS_PER_CONNECTION} targets sharing one connection:
 * if every target polled at the floor, their combined call rate would still
 * fit inside the bucket's refill. With the defaults that is
 * `ceil(20 / 1.5) = 14 s`, so the politeness floor (30 s, matching
 * @loxep/market's `DEFAULT_ADAPTIVE_MIN_SECONDS`) wins; a deliberately tight
 * budget makes the budget term win instead. The value is passed to
 * `recordPollSuccess` as `bounds.minSeconds`, which @loxep/market applies
 * LAST — a rate budget is a safety constraint, not a preference.
 *
 * The capacity/refill pair is OPERATOR-CONFIGURABLE through the registered
 * application setting `integration.ebay.rate_budget` (loxep-62y.2.3): the
 * factory takes a `resolveRateBudget` callback, consults it on every adapter
 * lookup, and rebuilds the connection's bucket — and with it the derived
 * floor — as soon as the stored value changes. An explicit `rateBudget`
 * option still wins, so tests and deliberately tight deployments are not at
 * the mercy of stored state.
 *
 * ## Token lifecycle
 *
 * The stored `oauth_tokens` credential is read, run through
 * `refreshTokenBundleIfNeeded`, and — when it actually refreshed — written
 * back through the connection-credentials service using the integration
 * boundary's own `credentialWriteForBundle` split (ciphertext for the two
 * token strings; scopes/refresh-token expiry on the connection's non-secret
 * config). The adapter also registers `onTokenRefreshed`, so a mid-call
 * library auto-refresh is persisted too — the previous access token is dead
 * once that fires.
 *
 * ABSOLUTE RULE honored here: no token or keyset value is ever logged, put in
 * an error message, or returned to a caller other than the persistence path.
 */
import type { LoxepDb } from "@loxep/db";
import type {
  ConnectionCredentialsService,
  ConnectionsService,
  SecretsService,
} from "@loxep/domain";
import { SecretNotFoundError } from "@loxep/domain";
import type { JobsLogger } from "@loxep/jobs";
import {
  createEbayAdapter,
  createRateBudget,
  bundleFromCredential,
  credentialWriteForBundle,
  loadSandboxCredentialsFromEnvFile,
  refreshTokenBundleIfNeeded,
} from "@loxep/integration-ebay";
import type {
  EbayAdapter,
  EbayUserAdapter,
  EbayUserTokenBundle,
  RateBudget,
} from "@loxep/integration-ebay";
import { EbayKeysetMissingError } from "./errors.ts";

/** Application-secret key holding the eBay application keyset (ADR-0019). */
export const EBAY_KEYSET_SECRET_KEY = "integration.ebay.keyset";
/** `connections.provider` value the eBay pipeline accepts. */
export const EBAY_CONNECTION_PROVIDER = "ebay";
/** Registered credential purpose used for the conceptual 'ebay_oauth' slot. */
export const EBAY_OAUTH_CREDENTIAL_TYPE = "oauth_tokens";
/** Non-secret block on `connections.config` holding consent facts. */
export const EBAY_CONNECTION_CONFIG_KEY = "ebayOAuth";

/** Per-connection token-bucket defaults (see the module doc). */
export const EBAY_RATE_BUDGET_CAPACITY = 10;
export const EBAY_RATE_BUDGET_REFILL_PER_SECOND = 1.5;
/** Targets one connection's budget is sized to carry concurrently. */
export const EBAY_BUDGET_TARGETS_PER_CONNECTION = 20;
/** Politeness floor; matches @loxep/market's `DEFAULT_ADAPTIVE_MIN_SECONDS`. */
export const EBAY_ABSOLUTE_MIN_INTERVAL_SECONDS = 30;

/** Rebuild a cached adapter this many seconds before its access token dies. */
const ADAPTER_CACHE_SKEW_SECONDS = 60;

export type EbayKeysetSource = "secret" | "dev-file";

export interface EbayKeyset {
  appId: string;
  certId: string;
  devId: string;
  ruName?: string;
  environment: "sandbox" | "production";
}

/**
 * The per-connection handle the poll executor works with.
 *
 * `application` and `user` are two provider clients sharing one rate budget.
 * Browse item snapshots deliberately use the APPLICATION token: a public
 * listing needs no user context, so item monitors keep working before (and
 * regardless of) consent, and a poll never spends the connected buyer's
 * token. The Trading watchlist call has no application-token form and
 * REQUIRES `user` — see {@link EbayConnectionAdapter.requireUser}.
 */
export interface EbayConnectionAdapter {
  connectionId: string;
  environment: "sandbox" | "production";
  marketplaceId: string;
  keysetSource: EbayKeysetSource;
  /** Application (client-credentials) adapter; always present. */
  application: EbayAdapter;
  /** User-context adapter, or null when the connection has no consent yet. */
  user: EbayUserAdapter | null;
  /** The per-connection rate-budget floor, in whole seconds. */
  minIntervalSeconds: number;
  /** The user adapter, or a clear domain error explaining what is missing. */
  requireUser: () => EbayUserAdapter;
}

export interface EbayAdapterFactory {
  (connectionId: string): Promise<EbayConnectionAdapter>;
}

/** How a provider client is constructed from a resolved keyset + budget. */
export type EbayAdapterConstructor = (input: {
  keyset: EbayKeyset;
  rateBudget: RateBudget;
  logger: JobsLogger | undefined;
}) => EbayAdapter;

const defaultAdapterConstructor: EbayAdapterConstructor = ({
  keyset,
  rateBudget,
  logger,
}) =>
  createEbayAdapter({
    appId: keyset.appId,
    certId: keyset.certId,
    devId: keyset.devId,
    ...(keyset.ruName !== undefined ? { ruName: keyset.ruName } : {}),
    environment: keyset.environment,
    rateBudget,
    ...(logger !== undefined ? { logger } : {}),
  });

/** Token-bucket parameters: burst size and sustained calls per second. */
export interface EbayRateBudgetConfig {
  capacity: number;
  refillPerSecond: number;
}

export interface CreateEbayAdapterFactoryOptions {
  db: LoxepDb;
  secrets: SecretsService;
  connections: ConnectionsService;
  connectionCredentials: ConnectionCredentialsService;
  logger?: JobsLogger;
  /**
   * Override the token-bucket defaults (tests, tight deployments). An
   * explicit value WINS over {@link resolveRateBudget}: a caller that names a
   * budget means it, and a test must not depend on stored settings.
   */
  rateBudget?: EbayRateBudgetConfig;
  /**
   * Read the budget from the registered application setting
   * (`integration.ebay.rate_budget`) at adapter-build time. Consulted only
   * when `rateBudget` is absent; a failure falls back to the documented
   * defaults rather than taking the pipeline down.
   */
  resolveRateBudget?: () => Promise<EbayRateBudgetConfig>;
  /**
   * Provider-client constructor seam. Defaults to `createEbayAdapter`; tests
   * inject a client whose OAuth exchange is stubbed so the refresh-and-
   * PERSIST path can be exercised without network I/O.
   */
  createAdapter?: EbayAdapterConstructor;
}

/**
 * Per-connection interval floor derived from a token bucket — see the module
 * doc for the formula. Exported so tests and documentation share one source.
 */
export function rateBudgetIntervalFloorSeconds(budget: {
  refillPerSecond: number;
}): number {
  return Math.max(
    EBAY_ABSOLUTE_MIN_INTERVAL_SECONDS,
    Math.ceil(EBAY_BUDGET_TARGETS_PER_CONNECTION / budget.refillPerSecond),
  );
}

/**
 * Resolve the keyset by the documented precedence. Returns `null` when
 * neither source is configured — callers turn that into an actionable
 * message, never a stack trace.
 */
export async function loadEbayKeyset(
  secrets: SecretsService,
): Promise<{ keyset: EbayKeyset; source: EbayKeysetSource } | null> {
  try {
    const { payload } = await secrets.getSecretPayload(
      EBAY_KEYSET_SECRET_KEY,
      "ebay_keyset",
    );
    return { keyset: payload, source: "secret" };
  } catch (error) {
    if (!(error instanceof SecretNotFoundError)) throw error;
  }
  const devCredentials = loadSandboxCredentialsFromEnvFile();
  return devCredentials === null
    ? null
    : { keyset: devCredentials, source: "dev-file" };
}

interface CacheEntry {
  adapter: EbayConnectionAdapter;
  /** Epoch ms the cached user token stops being usable; Infinity when none. */
  expiresAtMs: number;
  /** The budget the entry was built with; a change forces a rebuild. */
  budgetConfig: EbayRateBudgetConfig;
}

/** Non-secret consent facts stored on `connections.config.ebayOAuth`. */
interface EbayConnectionOAuthConfig {
  scopes?: unknown;
  refreshTokenExpiresAt?: unknown;
  [key: string]: unknown;
}

function readOAuthConfig(
  config: Record<string, unknown>,
): EbayConnectionOAuthConfig {
  const raw = config[EBAY_CONNECTION_CONFIG_KEY];
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as EbayConnectionOAuthConfig)
    : {};
}

function readScopes(oauth: EbayConnectionOAuthConfig): string[] | undefined {
  return Array.isArray(oauth.scopes) &&
    oauth.scopes.every((scope) => typeof scope === "string")
    ? (oauth.scopes as string[])
    : undefined;
}

function readRefreshTokenExpiresAt(
  oauth: EbayConnectionOAuthConfig,
): string | null {
  return typeof oauth.refreshTokenExpiresAt === "string"
    ? oauth.refreshTokenExpiresAt
    : null;
}

/**
 * Build the connection-scoped eBay adapter factory.
 *
 * Adapters are cached per connection with expiry-aware invalidation: a cached
 * entry is discarded once its user access token is within
 * {@link ADAPTER_CACHE_SKEW_SECONDS} of expiry, which forces a rebuild
 * through the refresh-and-persist path. {@link invalidate} drops an entry
 * immediately (used after an `auth`-class provider failure).
 *
 * A cached entry is ALSO discarded when the resolved rate budget no longer
 * matches the one it was built with. Without that, an operator tightening
 * `integration.ebay.rate_budget` would wait for a token expiry — or, on a
 * connection with no user consent at all, forever — before the new limit and
 * its derived interval floor took effect.
 */
export function createEbayAdapterFactory(
  options: CreateEbayAdapterFactoryOptions,
): {
  getAdapterForConnection: EbayAdapterFactory;
  invalidate: (connectionId: string) => void;
  /** The interval floor implied by the configured budget (all connections). */
  intervalFloorSeconds: number;
} {
  const { secrets, connections, connectionCredentials, logger } = options;
  const constructAdapter = options.createAdapter ?? defaultAdapterConstructor;
  const staticBudgetConfig = options.rateBudget ?? {
    capacity: EBAY_RATE_BUDGET_CAPACITY,
    refillPerSecond: EBAY_RATE_BUDGET_REFILL_PER_SECOND,
  };
  /**
   * The floor implied by the CONFIGURED-AT-CONSTRUCTION budget. When the
   * setting-backed resolver is in use the authoritative floor is the one on
   * each built adapter (`minIntervalSeconds`), which is recomputed whenever
   * the stored budget changes; this value stays the static view for
   * diagnostics and for callers that never build an adapter.
   */
  const intervalFloorSeconds = rateBudgetIntervalFloorSeconds(
    staticBudgetConfig,
  );

  // Budgets outlive adapters on purpose: rebuilding an adapter after a token
  // refresh must not hand the connection a fresh full bucket. The parameters
  // are remembered alongside, so a settings change replaces the bucket
  // instead of leaving the connection on the old limit forever.
  const budgets = new Map<
    string,
    { budget: RateBudget; config: EbayRateBudgetConfig }
  >();
  const cache = new Map<string, CacheEntry>();
  // One in-flight build per connection: concurrent polls of the same
  // connection must not each run the refresh/persist path.
  const inFlight = new Map<string, Promise<EbayConnectionAdapter>>();

  /** The budget parameters this build must use (setting, or the default). */
  async function resolveBudgetConfig(): Promise<EbayRateBudgetConfig> {
    if (options.rateBudget !== undefined || options.resolveRateBudget === undefined) {
      return staticBudgetConfig;
    }
    try {
      return await options.resolveRateBudget();
    } catch (error) {
      logger?.error(
        { err: error instanceof Error ? error.message : String(error) },
        "failed to read the eBay rate-budget setting; using the documented defaults",
      );
      return staticBudgetConfig;
    }
  }

  function budgetFor(
    connectionId: string,
    config: EbayRateBudgetConfig,
  ): RateBudget {
    const existing = budgets.get(connectionId);
    if (
      existing !== undefined &&
      existing.config.capacity === config.capacity &&
      existing.config.refillPerSecond === config.refillPerSecond
    ) {
      return existing.budget;
    }
    if (existing !== undefined) {
      logger?.info(
        { connectionId, ...config },
        "eBay rate budget reconfigured; replacing the connection's token bucket",
      );
    }
    const budget = createRateBudget({
      capacity: config.capacity,
      refillPerSecond: config.refillPerSecond,
      ...(logger !== undefined ? { logger } : {}),
    });
    budgets.set(connectionId, { budget, config });
    return budget;
  }

  function invalidate(connectionId: string): void {
    cache.delete(connectionId);
  }

  /** Persist a bundle: ciphertext for tokens, plain facts on the connection. */
  async function persistBundle(
    connectionId: string,
    bundle: EbayUserTokenBundle,
    connectionConfig: Record<string, unknown>,
  ): Promise<void> {
    const write = credentialWriteForBundle(bundle);
    await connectionCredentials.setCredential({
      connectionId,
      credentialType: write.credentialType,
      payload: write.payload,
      expiresAt: write.expiresAt,
      refreshAfter: write.refreshAfter,
    });
    // Non-secret half: only written when it actually changed, so a routine
    // access-token refresh does not churn the connection row or its audit
    // trail every two hours.
    const existing = readOAuthConfig(connectionConfig);
    const sameScopes =
      JSON.stringify(readScopes(existing) ?? null) ===
      JSON.stringify(write.connectionConfig.scopes);
    const sameRefreshExpiry =
      readRefreshTokenExpiresAt(existing) ===
      write.connectionConfig.refreshTokenExpiresAt;
    if (sameScopes && sameRefreshExpiry) return;
    await connections.updateConnection(connectionId, {
      config: {
        ...connectionConfig,
        [EBAY_CONNECTION_CONFIG_KEY]: {
          ...existing,
          ...write.connectionConfig,
        },
      },
    });
  }

  async function build(
    connectionId: string,
    budgetConfig: EbayRateBudgetConfig,
  ): Promise<EbayConnectionAdapter> {
    const connection = await connections.getConnection(connectionId);
    if (connection.provider !== EBAY_CONNECTION_PROVIDER) {
      throw new EbayKeysetMissingError(
        `connection ${connectionId} has provider "${connection.provider}"; the eBay pipeline needs an "${EBAY_CONNECTION_PROVIDER}" connection`,
      );
    }
    const resolved = await loadEbayKeyset(secrets);
    if (resolved === null) {
      throw new EbayKeysetMissingError(
        `no eBay application keyset is configured; store one as the application secret "${EBAY_KEYSET_SECRET_KEY}" or, for local sandbox development, create ~/.config/loxep/ebay-sandbox.env`,
      );
    }
    const { keyset, source } = resolved;
    const budget = budgetFor(connectionId, budgetConfig);
    const minIntervalSeconds = rateBudgetIntervalFloorSeconds(budgetConfig);
    const application = constructAdapter({
      keyset,
      rateBudget: budget,
      logger,
    });

    // --- user context -------------------------------------------------
    const oauth = readOAuthConfig(connection.config);
    let bundle: EbayUserTokenBundle | null = null;
    try {
      const credential = await connectionCredentials.getCredentialPayload(
        connectionId,
        EBAY_OAUTH_CREDENTIAL_TYPE,
      );
      const metadata = (
        await connectionCredentials.listCredentials(connectionId)
      ).find((entry) => entry.credentialType === EBAY_OAUTH_CREDENTIAL_TYPE);
      bundle = bundleFromCredential({
        payload: credential.payload,
        expiresAt: metadata?.expiresAt ?? null,
        scopes: readScopes(oauth),
        refreshTokenExpiresAt: readRefreshTokenExpiresAt(oauth),
      });
    } catch (error) {
      if (!(error instanceof SecretNotFoundError)) throw error;
      // No consent yet: application-token operations still work.
      bundle = null;
    }

    let user: EbayUserAdapter | null = null;
    let expiresAtMs = Number.POSITIVE_INFINITY;
    if (bundle !== null) {
      const refreshed = await refreshTokenBundleIfNeeded({
        bundle,
        adapter: application,
      });
      if (refreshed.refreshed) {
        await persistBundle(connectionId, refreshed.bundle, connection.config);
        logger?.info(
          { connectionId },
          "refreshed eBay user token during adapter build",
        );
      }
      const current = refreshed.bundle;
      expiresAtMs = Date.parse(current.accessTokenExpiresAt);
      user = application.withUserToken(current, {
        // The library auto-refreshes an expired IAF token mid-call; persist
        // immediately, because the previous access token is dead once this
        // fires. Fire-and-forget: the call itself must not fail on a
        // persistence hiccup, and the next build re-reads storage anyway.
        onTokenRefreshed: (next) => {
          expiresAtMs = Date.parse(next.accessTokenExpiresAt);
          void persistBundle(connectionId, next, connection.config).catch(
            (error: unknown) => {
              logger?.error(
                {
                  connectionId,
                  err: error instanceof Error ? error.message : String(error),
                },
                "failed to persist auto-refreshed eBay user token",
              );
            },
          );
        },
      });
    }

    const adapter: EbayConnectionAdapter = {
      connectionId,
      environment: keyset.environment,
      marketplaceId: application.marketplaceId,
      keysetSource: source,
      application,
      user,
      minIntervalSeconds,
      requireUser: () => {
        if (user === null) {
          throw new EbayKeysetMissingError(
            `eBay connection ${connectionId} has no stored user token; complete the consent flow before polling watchlist targets`,
          );
        }
        return user;
      },
    };
    cache.set(connectionId, { adapter, expiresAtMs, budgetConfig });
    return adapter;
  }

  async function getAdapterForConnection(
    connectionId: string,
  ): Promise<EbayConnectionAdapter> {
    const budgetConfig = await resolveBudgetConfig();
    const cached = cache.get(connectionId);
    if (
      cached !== undefined &&
      Date.now() < cached.expiresAtMs - ADAPTER_CACHE_SKEW_SECONDS * 1000 &&
      cached.budgetConfig.capacity === budgetConfig.capacity &&
      cached.budgetConfig.refillPerSecond === budgetConfig.refillPerSecond
    ) {
      return cached.adapter;
    }
    cache.delete(connectionId);
    let pending = inFlight.get(connectionId);
    if (pending === undefined) {
      pending = build(connectionId, budgetConfig).finally(() => {
        inFlight.delete(connectionId);
      });
      inFlight.set(connectionId, pending);
    }
    return pending;
  }

  return { getAdapterForConnection, invalidate, intervalFloorSeconds };
}
