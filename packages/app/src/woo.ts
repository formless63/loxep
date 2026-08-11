/**
 * WooCommerce adapter factory for the worker pipeline (loxep-xh9.7.1).
 *
 * The Woo sibling of `ebay.ts`: one place resolves everything a live order
 * sync needs and hands back a ready-to-use, per-connection adapter.
 *
 * ```text
 * connections.config.woo.baseUrl        (non-secret store URL)  ─┐
 * per-connection rate budget (token bucket)                      ├─→ WooAdapter
 * connection credential 'woo_credentials' (ck/cs, ADR-0019)     ─┘
 * ```
 *
 * ## Where each half of the configuration lives, and why
 *
 * `packages/integrations/woo/src/connection.ts` decided this contract before
 * any of it was wired, and this module implements it unchanged:
 *
 * ```text
 * provider           'woocommerce'
 * credential_type    'woo_credentials'   ADR-0019 bundle: { consumerKey, consumerSecret }
 * connections.config  woo: { baseUrl }   NON-secret; a shop URL is public
 * ```
 *
 * The split is deliberate. `baseUrl` must be readable to render the
 * connection, to run a health check, and to compute the commerce design's
 * `source_account_key`, none of which should require a decryption round-trip
 * against the root key; and a key pair is atomically useful or useless
 * without it, which is the property ADR-0019 bundles exist to protect. This
 * is the documented CONTRAST with `ebay_keyset`, which does bundle its
 * non-secret `environment`/`ruName` because a sandbox keyset pointed at
 * production fails like credential corruption. Woo has no such coupling: a
 * key pair pointed at the wrong store returns a clean HTTP 401.
 *
 * ## Rate budget and the derived interval floor
 *
 * Each connection gets ONE {@link RateBudget}, created once per connection
 * and REUSED across adapter rebuilds, exactly like the eBay factory — a
 * rebuilt adapter must never hand a store a fresh full bucket. The parameters
 * come from the registered `integration.woo.rate_budget` setting (see
 * `settings.ts`), and an explicit constructor value still wins so tests are
 * not at the mercy of stored state.
 *
 * From the budget comes the per-connection **interval floor** the adaptive
 * scheduler must never poll below:
 *
 * ```text
 * floorSeconds = max(
 *   WOO_ABSOLUTE_MIN_INTERVAL_SECONDS,                  // politeness
 *   ceil(WOO_PAGES_PER_SYNC / refillPerSecond)          // budget share
 * )
 * ```
 *
 * The second term reserves sustained throughput for one whole sync walk
 * ({@link WOO_PAGES_PER_SYNC} = Commerce's `DEFAULT_SYNC_MAX_PAGES` pages,
 * one request each): if the target polled at the floor, a full-budget walk
 * would still fit inside the bucket's refill. With the defaults that is
 * `ceil(10 / 1) = 10 s`, so the politeness floor wins by a wide margin — and
 * it should. {@link WOO_ABSOLUTE_MIN_INTERVAL_SECONDS} is 300 s rather than
 * eBay's 30 s because the thing on the other end is not a marketplace API
 * built for polling, it is somebody's WordPress install on one PHP-FPM pool,
 * and an order that arrived four minutes ago is not more useful for having
 * been fetched four minutes ago.
 *
 * ## Caching
 *
 * The built adapter is cached per connection for
 * {@link WOO_ADAPTER_CACHE_TTL_MS}, and — unlike eBay — the cache is a
 * convenience rather than a correctness mechanism: there is no token to
 * refresh, so a rebuild costs one connection read plus one credential
 * decryption. The short TTL is what makes an operator's baseUrl or key
 * rotation take effect without a restart, while the per-connection budget
 * lives OUTSIDE the cache and survives every rebuild. {@link invalidate}
 * drops an entry immediately (used after an `auth`-class provider failure, so
 * a re-keyed connection recovers on the next poll rather than after the TTL).
 *
 * ABSOLUTE RULE honored here: no consumer key or secret is ever logged, put
 * in an error message, or returned to a caller. The adapter keeps the pair in
 * a closure and exposes only `baseUrl`, `namespace`, `sourceAccountKey`, and
 * budget statistics.
 */
import { DEFAULT_SYNC_MAX_PAGES } from "@loxep/commerce";
import type { ConnectionCredentialsService, ConnectionsService } from "@loxep/domain";
import { SecretNotFoundError } from "@loxep/domain";
import type { JobsLogger } from "@loxep/jobs";
import { createRateBudget, createWooAdapter } from "@loxep/integration-woo";
import type { RateBudget, WooAdapter } from "@loxep/integration-woo";
import { AppConfigurationError } from "./errors.ts";

/** `connections.provider` value the WooCommerce pipeline accepts. */
export const WOO_CONNECTION_PROVIDER = "woocommerce";
/** Registered credential purpose holding the store's REST key pair. */
export const WOO_CREDENTIAL_TYPE = "woo_credentials";
/** Non-secret block on `connections.config` holding the store URL. */
export const WOO_CONNECTION_CONFIG_KEY = "woo";

/** Per-connection token-bucket defaults (see the module doc). */
export const WOO_RATE_BUDGET_CAPACITY = 5;
export const WOO_RATE_BUDGET_REFILL_PER_SECOND = 1;
/** Requests one full sync walk may spend; Commerce's own page budget. */
export const WOO_PAGES_PER_SYNC = DEFAULT_SYNC_MAX_PAGES;
/** Politeness floor for polling a self-hosted store: five minutes. */
export const WOO_ABSOLUTE_MIN_INTERVAL_SECONDS = 300;
/** How long a built adapter is reused before it is rebuilt from storage. */
export const WOO_ADAPTER_CACHE_TTL_MS = 300_000;

/** The store's REST key pair is missing, or its connection is misconfigured. */
export class WooCredentialsMissingError extends AppConfigurationError {}

/** Token-bucket parameters: burst size and sustained calls per second. */
export interface WooRateBudgetConfig {
  capacity: number;
  refillPerSecond: number;
}

/** The per-connection handle the commerce sync executor works with. */
export interface WooConnectionAdapter {
  connectionId: string;
  /** The normalized store root URL (non-secret). */
  baseUrl: string;
  /** `woocommerce:<siteUrl>` — the commerce design's `source_account_key`. */
  sourceAccountKey: string;
  /** The read-only REST adapter. */
  adapter: WooAdapter;
  /** The per-connection rate-budget floor, in whole seconds. */
  minIntervalSeconds: number;
}

export interface WooAdapterFactory {
  (connectionId: string): Promise<WooConnectionAdapter>;
}

/** How a provider client is constructed from resolved config + budget. */
export type WooAdapterConstructor = (input: {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  rateBudget: RateBudget;
  logger: JobsLogger | undefined;
}) => WooAdapter;

const defaultAdapterConstructor: WooAdapterConstructor = ({
  baseUrl,
  consumerKey,
  consumerSecret,
  rateBudget,
  logger,
}) =>
  createWooAdapter({
    baseUrl,
    consumerKey,
    consumerSecret,
    rateBudget,
    ...(logger !== undefined ? { logger } : {}),
  });

export interface CreateWooAdapterFactoryOptions {
  connections: ConnectionsService;
  connectionCredentials: ConnectionCredentialsService;
  logger?: JobsLogger;
  /**
   * Override the token-bucket defaults (tests, deliberately gentle
   * deployments). An explicit value WINS over {@link resolveRateBudget}.
   */
  rateBudget?: WooRateBudgetConfig;
  /**
   * Read the budget from the registered `integration.woo.rate_budget` setting
   * at adapter-build time. Consulted only when `rateBudget` is absent; a
   * failure falls back to the documented defaults rather than taking the
   * pipeline down.
   */
  resolveRateBudget?: () => Promise<WooRateBudgetConfig>;
  /** Provider-client constructor seam (tests inject a fake adapter). */
  createAdapter?: WooAdapterConstructor;
}

/**
 * Per-connection interval floor derived from a token bucket — see the module
 * doc for the formula. Exported so tests and documentation share one source.
 */
export function wooRateBudgetIntervalFloorSeconds(budget: {
  refillPerSecond: number;
}): number {
  return Math.max(
    WOO_ABSOLUTE_MIN_INTERVAL_SECONDS,
    Math.ceil(WOO_PAGES_PER_SYNC / budget.refillPerSecond),
  );
}

/**
 * Read the non-secret store URL from `connections.config.woo.baseUrl`.
 * Exported because the same block is what a connection-management surface
 * writes, and both sides should agree on its shape in one place.
 */
export function readWooBaseUrl(
  config: Record<string, unknown>,
): string | null {
  const block = config[WOO_CONNECTION_CONFIG_KEY];
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return null;
  }
  const baseUrl = (block as Record<string, unknown>)["baseUrl"];
  return typeof baseUrl === "string" && baseUrl !== "" ? baseUrl : null;
}

interface CacheEntry {
  adapter: WooConnectionAdapter;
  /** Epoch ms the entry stops being reused. */
  expiresAtMs: number;
  /** The budget the entry was built with; a change forces a rebuild. */
  budgetConfig: WooRateBudgetConfig;
}

/**
 * Build the connection-scoped WooCommerce adapter factory.
 */
export function createWooAdapterFactory(
  options: CreateWooAdapterFactoryOptions,
): {
  getAdapterForConnection: WooAdapterFactory;
  invalidate: (connectionId: string) => void;
  /** The interval floor implied by the configured budget (all connections). */
  intervalFloorSeconds: number;
} {
  const { connections, connectionCredentials, logger } = options;
  const constructAdapter = options.createAdapter ?? defaultAdapterConstructor;
  const staticBudgetConfig = options.rateBudget ?? {
    capacity: WOO_RATE_BUDGET_CAPACITY,
    refillPerSecond: WOO_RATE_BUDGET_REFILL_PER_SECOND,
  };
  const intervalFloorSeconds =
    wooRateBudgetIntervalFloorSeconds(staticBudgetConfig);

  // Budgets outlive adapters on purpose: rebuilding an adapter after a TTL
  // expiry or a credential rotation must not hand the store a fresh full
  // bucket. The parameters are remembered alongside, so a settings change
  // replaces the bucket instead of leaving the connection on the old limit.
  const budgets = new Map<
    string,
    { budget: RateBudget; config: WooRateBudgetConfig }
  >();
  const cache = new Map<string, CacheEntry>();
  // One in-flight build per connection: concurrent callers must not each run
  // the credential-decryption path.
  const inFlight = new Map<string, Promise<WooConnectionAdapter>>();

  async function resolveBudgetConfig(): Promise<WooRateBudgetConfig> {
    if (
      options.rateBudget !== undefined ||
      options.resolveRateBudget === undefined
    ) {
      return staticBudgetConfig;
    }
    try {
      return await options.resolveRateBudget();
    } catch (error) {
      logger?.error(
        { err: error instanceof Error ? error.message : String(error) },
        "failed to read the WooCommerce rate-budget setting; using the documented defaults",
      );
      return staticBudgetConfig;
    }
  }

  function budgetFor(
    connectionId: string,
    config: WooRateBudgetConfig,
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
        "WooCommerce rate budget reconfigured; replacing the connection's token bucket",
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

  async function build(
    connectionId: string,
    budgetConfig: WooRateBudgetConfig,
  ): Promise<WooConnectionAdapter> {
    const connection = await connections.getConnection(connectionId);
    if (connection.provider !== WOO_CONNECTION_PROVIDER) {
      throw new WooCredentialsMissingError(
        `connection ${connectionId} has provider "${connection.provider}"; the WooCommerce pipeline needs a "${WOO_CONNECTION_PROVIDER}" connection`,
      );
    }
    const baseUrl = readWooBaseUrl(connection.config);
    if (baseUrl === null) {
      throw new WooCredentialsMissingError(
        `connection ${connectionId} has no store URL; set config.${WOO_CONNECTION_CONFIG_KEY}.baseUrl (the non-secret half of a WooCommerce connection)`,
      );
    }

    let payload: { consumerKey: string; consumerSecret: string };
    try {
      const credential = await connectionCredentials.getCredentialPayload(
        connectionId,
        WOO_CREDENTIAL_TYPE,
      );
      payload = credential.payload;
    } catch (error) {
      if (!(error instanceof SecretNotFoundError)) throw error;
      throw new WooCredentialsMissingError(
        `connection ${connectionId} has no stored "${WOO_CREDENTIAL_TYPE}" credential; add the store's read-only REST key pair before polling order targets`,
        { cause: error },
      );
    }

    const budget = budgetFor(connectionId, budgetConfig);
    const adapter = constructAdapter({
      baseUrl,
      consumerKey: payload.consumerKey,
      consumerSecret: payload.consumerSecret,
      rateBudget: budget,
      logger,
    });

    const resolved: WooConnectionAdapter = {
      connectionId,
      baseUrl: adapter.baseUrl,
      sourceAccountKey: adapter.sourceAccountKey,
      adapter,
      minIntervalSeconds: wooRateBudgetIntervalFloorSeconds(budgetConfig),
    };
    cache.set(connectionId, {
      adapter: resolved,
      expiresAtMs: Date.now() + WOO_ADAPTER_CACHE_TTL_MS,
      budgetConfig,
    });
    return resolved;
  }

  async function getAdapterForConnection(
    connectionId: string,
  ): Promise<WooConnectionAdapter> {
    const budgetConfig = await resolveBudgetConfig();
    const cached = cache.get(connectionId);
    if (
      cached !== undefined &&
      Date.now() < cached.expiresAtMs &&
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
