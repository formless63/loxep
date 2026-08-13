/**
 * Etsy adapter factory for the worker pipeline (loxep-g4t.1).
 *
 * The Etsy sibling of `ebay.ts`/`woo.ts`, with ONE structural difference
 * that is the entire reason this module exists rather than being a
 * copy-paste of `ebay.ts`: Etsy's rate limit is per APPLICATION, not per
 * connection (see `@loxep/integration-etsy`'s `rate-budget.ts` module doc
 * and the binding design's "Rate budget — the one place NOT to copy eBay's
 * wiring verbatim"). Concretely:
 *
 * ```text
 * ebay.ts / woo.ts:  ONE RateBudget PER CONNECTION (a Map<connectionId, budget>)
 * etsy.ts:           ONE RateBudget for the WHOLE INSTALLATION, shared by
 *                     every Etsy connection's adapter — there is no
 *                     per-connection budget map here at all.
 * ```
 *
 * A copy-paste of the eBay/Woo per-connection wiring pattern would silently
 * multiply the app's real Etsy quota by the number of connected shops (a
 * two-shop install would believe it has 2x the actual 10 QPS / 10 000-per-
 * day quota) and would get rate-limited in a way that looks like a bug in
 * the budget rather than the wiring mistake it would be — flagged as the
 * single highest-risk copy-paste error in the design document.
 *
 * ONE consequence follows from Etsy having no connection-specific base URL
 * either (unlike WooCommerce/Medusa): the shared, keyset-bound
 * `EtsyAdapter` returned by `createEtsyAdapter()` is ALSO shared across
 * every connection — public-auth calls (`getListing`, `getShopListingsActive`,
 * `getShop`, `ping`) carry no connection-specific state at all, only a
 * `shopId` supplied per call. Only the OPTIONAL private-auth view
 * (`.withUserToken(bundle)`) is connection-specific, because only the OAuth
 * bundle differs per connection.
 *
 * ## Keyset precedence (identical to eBay's)
 *
 * 1. application secret `integration.etsy.keyset` (purpose `etsy_keyset`,
 *    ADR-0019) — the real runtime path;
 * 2. the local dev file `~/.config/loxep/etsy-sandbox.env` — ONLY when no
 *    secret exists (Etsy has no sandbox at all, so this file is named for
 *    parity with eBay's, not because an isolated environment exists — see
 *    `@loxep/integration-etsy/credentials.ts`'s module doc).
 *
 * ## WIRING CAVEAT — no declared workspace dependency (yet)
 *
 * `packages/app/package.json` does not yet declare
 * `@loxep/integration-etsy` (this change's write fence excludes every
 * package.json). It is reached through a workspace-relative import
 * the package name —
 * the same caveat `apps/web/src/server/ebay-oauth.ts`'s module doc records
 * for its own dependency. Declaring the proper `workspace:*` dependency
 * (and updating this import to the package-name form) is a one-line
 * follow-up once a package.json change is in scope.
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
  createEtsyAdapter,
  createRateBudget,
  bundleFromCredential,
  credentialWriteForBundle,
  loadDevKeysetFromEnvFile,
  refreshTokenBundleIfNeeded,
} from "@loxep/integration-etsy";
import type {
  EtsyAdapter,
  EtsyUserAdapter,
  EtsyUserTokenBundle,
  RateBudget,
} from "@loxep/integration-etsy";
import { EtsyKeysetMissingError } from "./errors.ts";

/** Application-secret key holding the Etsy application keyset (ADR-0019). */
export const ETSY_KEYSET_SECRET_KEY = "integration.etsy.keyset";
/** `connections.provider` value the Etsy pipeline accepts. */
export const ETSY_CONNECTION_PROVIDER = "etsy";
/** Registered credential purpose reused for the conceptual 'etsy_oauth' slot. */
export const ETSY_OAUTH_CREDENTIAL_TYPE = "oauth_tokens";
/** Non-secret block on `connections.config` holding consent facts. */
export const ETSY_CONNECTION_CONFIG_KEY = "etsyOAuth";
/** Non-secret block on `connections.config` holding the connected shop's id. */
export const ETSY_SHOP_CONFIG_KEY = "etsy";

/**
 * SHARED-PER-APPLICATION token-bucket defaults — see the module doc. Etsy's
 * documented default new-app allocation is 10 000 queries/24h and 10
 * queries/second (`etsy-integration-design.md`, "Rate limits"); the refill
 * rate below models the QPS figure directly, and the daily cap is left to
 * Etsy's own server-side enforcement (a 10 QPS bucket exhausts the daily
 * figure only after ~16.6 continuous minutes of saturation, far more
 * sustained traffic than an observation-only m1 poll schedule generates).
 */
export const ETSY_RATE_BUDGET_CAPACITY = 10;
export const ETSY_RATE_BUDGET_REFILL_PER_SECOND = 10;
/** Politeness floor; matches eBay's `EBAY_ABSOLUTE_MIN_INTERVAL_SECONDS`. */
export const ETSY_ABSOLUTE_MIN_INTERVAL_SECONDS = 30;
/**
 * Targets the shared budget is sized to carry concurrently ACROSS THE WHOLE
 * INSTALLATION (not per connection, unlike eBay's analogous constant) —
 * every Etsy monitor target, on every connection, draws from this one
 * budget.
 */
export const ETSY_BUDGET_TARGETS_PER_INSTALLATION = 20;

export type EtsyKeysetSource = "secret" | "dev-file";

export interface EtsyKeyset {
  keystring: string;
  sharedSecret: string;
}

/** Token-bucket parameters: burst size and sustained calls per second. */
export interface EtsyRateBudgetConfig {
  capacity: number;
  refillPerSecond: number;
}

/**
 * Per-connection interval floor derived from the SHARED token bucket — the
 * same formula shape as eBay's `rateBudgetIntervalFloorSeconds`, but the
 * budget it is derived from is one instance shared by every connection, so
 * every Etsy connection gets the SAME floor (there is no per-connection
 * variance the way a per-connection budget could produce).
 */
export function etsyRateBudgetIntervalFloorSeconds(budget: {
  refillPerSecond: number;
}): number {
  return Math.max(
    ETSY_ABSOLUTE_MIN_INTERVAL_SECONDS,
    Math.ceil(ETSY_BUDGET_TARGETS_PER_INSTALLATION / budget.refillPerSecond),
  );
}

/**
 * Resolve the keyset by the documented precedence. Returns `null` when
 * neither source is configured.
 */
export async function loadEtsyKeyset(
  secrets: SecretsService,
): Promise<{ keyset: EtsyKeyset; source: EtsyKeysetSource } | null> {
  try {
    const { payload } = await secrets.getSecretPayload(
      ETSY_KEYSET_SECRET_KEY,
      "etsy_keyset",
    );
    return { keyset: payload, source: "secret" };
  } catch (error) {
    if (!(error instanceof SecretNotFoundError)) throw error;
  }
  const devCredentials = loadDevKeysetFromEnvFile();
  return devCredentials === null
    ? null
    : { keyset: devCredentials, source: "dev-file" };
}

/** Read the non-secret shop id from `connections.config.etsy.shopExternalId`. */
export function readEtsyShopId(config: Record<string, unknown>): string | null {
  const block = config[ETSY_SHOP_CONFIG_KEY];
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return null;
  }
  const shopExternalId = (block as Record<string, unknown>)["shopExternalId"];
  return typeof shopExternalId === "string" && shopExternalId !== ""
    ? shopExternalId
    : null;
}

/**
 * The per-connection handle the poll executor works with. `application` is
 * the ONE shared adapter for the whole installation (see the module doc);
 * `user` is connection-specific because only the OAuth bundle differs.
 */
export interface EtsyConnectionAdapter {
  connectionId: string;
  shopExternalId: string;
  keysetSource: EtsyKeysetSource;
  /** The shared, keyset-bound adapter — identical object across every connection. */
  application: EtsyAdapter;
  /** User-context view, or null when the connection has no consent yet. */
  user: EtsyUserAdapter | null;
  /** The interval floor implied by the shared budget, in whole seconds. */
  minIntervalSeconds: number;
  requireUser: () => EtsyUserAdapter;
}

export interface EtsyAdapterFactory {
  (connectionId: string): Promise<EtsyConnectionAdapter>;
}

/** How the shared provider client is constructed from a resolved keyset + budget. */
export type EtsyAdapterConstructor = (input: {
  keyset: EtsyKeyset;
  rateBudget: RateBudget;
  logger: JobsLogger | undefined;
}) => EtsyAdapter;

const defaultAdapterConstructor: EtsyAdapterConstructor = ({
  keyset,
  rateBudget,
  logger,
}) =>
  createEtsyAdapter({
    keystring: keyset.keystring,
    sharedSecret: keyset.sharedSecret,
    rateBudget,
    ...(logger !== undefined ? { logger } : {}),
  });

export interface CreateEtsyAdapterFactoryOptions {
  db: LoxepDb;
  secrets: SecretsService;
  connections: ConnectionsService;
  connectionCredentials: ConnectionCredentialsService;
  logger?: JobsLogger;
  /**
   * Override the token-bucket defaults (tests, tight deployments). An
   * explicit value WINS over {@link resolveRateBudget}.
   */
  rateBudget?: EtsyRateBudgetConfig;
  /**
   * Read the budget from a resolver at adapter-build time (mirrors eBay's
   * `resolveRateBudget` seam; Etsy has no registered application setting
   * for this yet — a documented follow-up, see this module's doc — so
   * production always falls back to the documented defaults today).
   */
  resolveRateBudget?: () => Promise<EtsyRateBudgetConfig>;
  /** Provider-client constructor seam (tests inject a fake adapter). */
  createAdapter?: EtsyAdapterConstructor;
}

interface SharedAdapterEntry {
  adapter: EtsyAdapter;
  /** The SAME instance handed to `constructAdapter`; reused for the OAuth token endpoint too. */
  rateBudget: RateBudget;
  keyset: EtsyKeyset;
  keysetSource: EtsyKeysetSource;
  budgetConfig: EtsyRateBudgetConfig;
}

interface CacheEntry {
  adapter: EtsyConnectionAdapter;
  /** Epoch ms the cached user token stops being usable; Infinity when none. */
  expiresAtMs: number;
  /** The shared budget config this entry was built against; a change forces a rebuild. */
  budgetConfig: EtsyRateBudgetConfig;
}

/** Rebuild a cached entry this many seconds before its access token dies. */
const ADAPTER_CACHE_SKEW_SECONDS = 60;

interface EtsyConnectionOAuthConfig {
  etsyUserId?: unknown;
  scopes?: unknown;
  refreshTokenExpiresAt?: unknown;
  [key: string]: unknown;
}

function readOAuthConfig(
  config: Record<string, unknown>,
): EtsyConnectionOAuthConfig {
  const raw = config[ETSY_CONNECTION_CONFIG_KEY];
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as EtsyConnectionOAuthConfig)
    : {};
}

function readScopes(oauth: EtsyConnectionOAuthConfig): string[] | undefined {
  return Array.isArray(oauth.scopes) &&
    oauth.scopes.every((scope) => typeof scope === "string")
    ? (oauth.scopes as string[])
    : undefined;
}

function readRefreshTokenExpiresAt(
  oauth: EtsyConnectionOAuthConfig,
): string | null {
  return typeof oauth.refreshTokenExpiresAt === "string"
    ? oauth.refreshTokenExpiresAt
    : null;
}

/**
 * Build the Etsy adapter factory. UNLIKE eBay's/Woo's factory, there is no
 * per-connection budget map: {@link sharedAdapterFor} builds ONE
 * `{RateBudget, EtsyAdapter}` pair for the whole factory instance and every
 * connection reuses it, rebuilding only when the resolved budget
 * configuration or the keyset itself actually changes.
 */
export function createEtsyAdapterFactory(
  options: CreateEtsyAdapterFactoryOptions,
): {
  getAdapterForConnection: EtsyAdapterFactory;
  invalidate: (connectionId: string) => void;
  /** The interval floor implied by the configured/default budget. */
  intervalFloorSeconds: number;
} {
  const { secrets, connections, connectionCredentials, logger } = options;
  const constructAdapter = options.createAdapter ?? defaultAdapterConstructor;
  const staticBudgetConfig = options.rateBudget ?? {
    capacity: ETSY_RATE_BUDGET_CAPACITY,
    refillPerSecond: ETSY_RATE_BUDGET_REFILL_PER_SECOND,
  };
  const intervalFloorSeconds = etsyRateBudgetIntervalFloorSeconds(
    staticBudgetConfig,
  );

  // THE ONE SHARED BUDGET + THE ONE SHARED ADAPTER for the whole
  // installation — see the module doc. NOT a Map<connectionId, ...>.
  let shared: SharedAdapterEntry | null = null;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<EtsyConnectionAdapter>>();

  async function resolveBudgetConfig(): Promise<EtsyRateBudgetConfig> {
    if (options.rateBudget !== undefined || options.resolveRateBudget === undefined) {
      return staticBudgetConfig;
    }
    try {
      return await options.resolveRateBudget();
    } catch (error) {
      logger?.error(
        { err: error instanceof Error ? error.message : String(error) },
        "failed to resolve the Etsy rate-budget config; using the documented defaults",
      );
      return staticBudgetConfig;
    }
  }

  /**
   * Resolve (or rebuild) the ONE shared `{adapter, budget}` pair for the
   * whole installation. Rebuilds only when the keyset or the budget config
   * actually changed — a routine call must not mint a fresh, full-capacity
   * bucket on every poll.
   */
  async function sharedAdapterFor(
    budgetConfig: EtsyRateBudgetConfig,
  ): Promise<SharedAdapterEntry> {
    const resolved = await loadEtsyKeyset(secrets);
    if (resolved === null) {
      throw new EtsyKeysetMissingError(
        `no Etsy application keyset is configured; store one as the application secret "${ETSY_KEYSET_SECRET_KEY}" or, for local development, create ~/.config/loxep/etsy-sandbox.env`,
      );
    }
    const { keyset, source } = resolved;
    if (
      shared !== null &&
      shared.keyset.keystring === keyset.keystring &&
      shared.keyset.sharedSecret === keyset.sharedSecret &&
      shared.budgetConfig.capacity === budgetConfig.capacity &&
      shared.budgetConfig.refillPerSecond === budgetConfig.refillPerSecond
    ) {
      return shared;
    }
    if (shared !== null) {
      logger?.info(
        {},
        "Etsy keyset or shared rate budget changed; rebuilding the installation-wide adapter",
      );
    }
    const rateBudget = createRateBudget({
      capacity: budgetConfig.capacity,
      refillPerSecond: budgetConfig.refillPerSecond,
      ...(logger !== undefined ? { logger } : {}),
    });
    const adapter = constructAdapter({ keyset, rateBudget, logger });
    shared = { adapter, rateBudget, keyset, keysetSource: source, budgetConfig };
    return shared;
  }

  function invalidate(connectionId: string): void {
    cache.delete(connectionId);
  }

  async function persistBundle(
    connectionId: string,
    bundle: EtsyUserTokenBundle,
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
    const existing = readOAuthConfig(connectionConfig);
    const sameUserId = existing.etsyUserId === write.connectionConfig.etsyUserId;
    const sameScopes =
      JSON.stringify(readScopes(existing) ?? null) ===
      JSON.stringify(write.connectionConfig.scopes);
    const sameRefreshExpiry =
      readRefreshTokenExpiresAt(existing) ===
      write.connectionConfig.refreshTokenExpiresAt;
    if (sameUserId && sameScopes && sameRefreshExpiry) return;
    await connections.updateConnection(connectionId, {
      config: {
        ...connectionConfig,
        [ETSY_CONNECTION_CONFIG_KEY]: { ...existing, ...write.connectionConfig },
      },
    });
  }

  async function build(
    connectionId: string,
    budgetConfig: EtsyRateBudgetConfig,
  ): Promise<EtsyConnectionAdapter> {
    const connection = await connections.getConnection(connectionId);
    if (connection.provider !== ETSY_CONNECTION_PROVIDER) {
      throw new EtsyKeysetMissingError(
        `connection ${connectionId} has provider "${connection.provider}"; the Etsy pipeline needs an "${ETSY_CONNECTION_PROVIDER}" connection`,
      );
    }
    const shopExternalId = readEtsyShopId(connection.config);
    if (shopExternalId === null) {
      throw new EtsyKeysetMissingError(
        `connection ${connectionId} has no shop id; set config.${ETSY_SHOP_CONFIG_KEY}.shopExternalId (the non-secret half of an Etsy connection)`,
      );
    }
    const { adapter: application, keysetSource } =
      await sharedAdapterFor(budgetConfig);

    const oauth = readOAuthConfig(connection.config);
    let bundle: EtsyUserTokenBundle | null = null;
    try {
      const credential = await connectionCredentials.getCredentialPayload(
        connectionId,
        ETSY_OAUTH_CREDENTIAL_TYPE,
      );
      const metadata = (
        await connectionCredentials.listCredentials(connectionId)
      ).find((entry) => entry.credentialType === ETSY_OAUTH_CREDENTIAL_TYPE);
      const etsyUserId = oauth.etsyUserId;
      bundle = bundleFromCredential({
        payload: credential.payload,
        expiresAt: metadata?.expiresAt ?? null,
        etsyUserId: typeof etsyUserId === "string" ? etsyUserId : "",
        scopes: readScopes(oauth),
        refreshTokenExpiresAt: readRefreshTokenExpiresAt(oauth),
      });
    } catch (error) {
      if (!(error instanceof SecretNotFoundError)) throw error;
      // No consent yet: public-auth operations still work.
      bundle = null;
    }

    let user: EtsyUserAdapter | null = null;
    let expiresAtMs = Number.POSITIVE_INFINITY;
    if (bundle !== null) {
      const refreshed = await refreshTokenBundleIfNeeded({
        bundle,
        keystring: shared!.keyset.keystring,
        sharedSecret: shared!.keyset.sharedSecret,
        // The refresh POST is one more call against the SHARED per-app
        // budget — same discipline as every other Etsy request.
        rateBudget: shared!.rateBudget,
      });
      if (refreshed.refreshed) {
        await persistBundle(connectionId, refreshed.bundle, connection.config);
        logger?.info({ connectionId }, "refreshed Etsy user token during adapter build");
      }
      const current = refreshed.bundle;
      expiresAtMs = Date.parse(current.accessTokenExpiresAt);
      user = application.withUserToken(current);
    }

    const adapter: EtsyConnectionAdapter = {
      connectionId,
      shopExternalId,
      keysetSource,
      application,
      user,
      minIntervalSeconds: etsyRateBudgetIntervalFloorSeconds(budgetConfig),
      requireUser: () => {
        if (user === null) {
          throw new EtsyKeysetMissingError(
            `Etsy connection ${connectionId} has no stored user token; complete the consent flow before polling private-auth targets`,
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
  ): Promise<EtsyConnectionAdapter> {
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
