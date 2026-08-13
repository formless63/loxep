/**
 * Cloudflare adapter factory for the worker pipeline (Phase 7 milestone 1
 * composition-root wiring, loxep-lmy.1).
 *
 * The Cloudflare sibling of `woo.ts`: a static, non-OAuth credential (a
 * scoped API token) plus a non-secret account identifier, resolved per
 * connection and handed back as a ready-to-use adapter. Structurally closer
 * to `woo.ts` than to `ebay.ts`/`etsy.ts` — there is no user token to
 * refresh, so the cache is a convenience rather than a correctness
 * mechanism, exactly as Woo's module doc explains.
 *
 * ```text
 * connections.config.cloudflare.accountId  (non-secret, optional)     ─┐
 * per-connection rate budget (token bucket)                            ├─→ CloudflareAdapter
 * connection credential 'cloudflare_credentials' (apiToken, ADR-0019) ─┘
 * ```
 *
 * ## Where each half of the configuration lives, and why
 *
 * `packages/domain/src/bundles.ts`'s `cloudflare_credentials` doc and
 * `packages/integrations/cloudflare/src/config.ts`'s module doc both state
 * the split this factory implements: the account identifier is
 * "non-secret provider account identity that must stay readable without a
 * decryption round-trip" — the same reasoning `woo.ts` gives for
 * `config.woo.baseUrl`. It is namespaced here under `config.cloudflare`,
 * matching every sibling factory's own namespaced block
 * (`config.woo`, `config.etsy`).
 *
 * `accountId` is OPTIONAL, unlike Woo's `baseUrl`: a zone-scoped API token
 * can list its own zones with no account identifier at all (the adapter
 * only sends `account.id` when it has one — see `config.ts`), so its
 * absence is not a configuration error.
 *
 * ## Rate budget — per CONNECTION, not per installation
 *
 * Unlike Etsy's shared-per-application budget, Cloudflare's real limit
 * (1200 requests / 5 minutes, i.e. 4/s, verified in
 * `@loxep/integration-cloudflare/rate-budget.ts`) is scoped **per Cloudflare
 * user account, shared with that account's own dashboard use** — not per
 * Loxep installation. Two connections almost always belong to two different
 * Cloudflare accounts (two different tokens), so a per-connection budget map
 * — the same shape `ebay.ts`/`woo.ts` use — is the correct default, and
 * pooling several connections onto one shared budget (for the case where
 * they really do share one Cloudflare account) is left to an explicit
 * `rateBudget` override rather than assumed.
 *
 * The default budget below is deliberately a small FRACTION of Cloudflare's
 * real ceiling (1/s against a 4/s limit), matching
 * `@loxep/integration-cloudflare`'s own private default and its module doc's
 * reasoning: "a reconciler that spends the operator's whole budget makes
 * their dashboard stop working, which is a worse failure than being slow."
 *
 * ## The interval floor is an HOUR, not seconds
 *
 * DNS intent changes rarely and a drift sweep is not latency-sensitive; the
 * Infrastructure control-plane design's own "Where recurring cadence lives"
 * and "How long are `reconcile_run_steps` retained?" sections both use "an
 * hourly sweep" as the worked example for `infrastructure_domain_reconcile`
 * cadence (`infrastructure-control-design.md`). {@link
 * CLOUDFLARE_ABSOLUTE_MIN_INTERVAL_SECONDS} encodes that recommendation as
 * the politeness floor, the same role eBay's 30s and Woo's 300s play for
 * their own domains.
 *
 * ## Caching
 *
 * The built adapter is cached per connection for
 * {@link CLOUDFLARE_ADAPTER_CACHE_TTL_MS}, mirroring Woo exactly: no token to
 * refresh, so a rebuild costs one connection read plus one credential
 * decryption, and the short TTL is what makes an operator's token or
 * account-id rotation take effect without a restart. The per-connection
 * budget lives OUTSIDE the cache and survives every rebuild — a rebuilt
 * adapter must never hand Cloudflare a fresh full bucket. {@link
 * CloudflareAdapterFactory}'s companion `invalidate` drops an entry
 * immediately (used after an `auth`-class provider failure).
 *
 * ABSOLUTE RULE honored here: the API token is never logged, put in an error
 * message, or returned to a caller. The adapter keeps it in a closure and
 * exposes only `baseUrl`, `sourceAccountKey`, and budget statistics.
 */
import type { ConnectionCredentialsService, ConnectionsService } from "@loxep/domain";
import { SecretNotFoundError } from "@loxep/domain";
import type { JobsLogger } from "@loxep/jobs";
import { createCloudflareAdapter, createRateBudget } from "@loxep/integration-cloudflare";
import type { CloudflareAdapter, RateBudget } from "@loxep/integration-cloudflare";
import { AppConfigurationError } from "./errors.ts";

/** `connections.provider` value the Cloudflare/Infrastructure pipeline accepts. */
export const CLOUDFLARE_CONNECTION_PROVIDER = "cloudflare";
/** Registered credential purpose holding the scoped API token (ADR-0019). */
export const CLOUDFLARE_CREDENTIAL_TYPE = "cloudflare_credentials";
/** Non-secret block on `connections.config` holding the account identifier. */
export const CLOUDFLARE_CONNECTION_CONFIG_KEY = "cloudflare";

/** Per-connection token-bucket defaults (see the module doc). */
export const CLOUDFLARE_RATE_BUDGET_CAPACITY = 8;
export const CLOUDFLARE_RATE_BUDGET_REFILL_PER_SECOND = 1;
/** Provider calls one check-mode reconcile run spends (one paginated `read`). */
export const CLOUDFLARE_CALLS_PER_SYNC = 1;
/** Politeness floor for a periodic DNS drift sweep: one hour (see the module doc). */
export const CLOUDFLARE_ABSOLUTE_MIN_INTERVAL_SECONDS = 3600;
/** How long a built adapter is reused before it is rebuilt from storage. */
export const CLOUDFLARE_ADAPTER_CACHE_TTL_MS = 300_000;

/** The Cloudflare API token is missing, or its connection is misconfigured. */
export class CloudflareCredentialsMissingError extends AppConfigurationError {}

/** Token-bucket parameters: burst size and sustained calls per second. */
export interface CloudflareRateBudgetConfig {
  capacity: number;
  refillPerSecond: number;
}

/** The per-connection handle the infrastructure reconcile executor works with. */
export interface CloudflareConnectionAdapter {
  connectionId: string;
  /** Non-secret Cloudflare account id, or `null` for a zone-scoped token. */
  accountId: string | null;
  /** `cloudflare:<accountId>` or `cloudflare:token-scoped`. */
  sourceAccountKey: string;
  /** The read/apply/capabilities adapter. */
  adapter: CloudflareAdapter;
  /** The per-connection rate-budget floor, in whole seconds. */
  minIntervalSeconds: number;
}

export interface CloudflareAdapterFactory {
  (connectionId: string): Promise<CloudflareConnectionAdapter>;
}

/** How a provider client is constructed from resolved config + budget. */
export type CloudflareAdapterConstructor = (input: {
  apiToken: string;
  accountId: string | undefined;
  rateBudget: RateBudget;
  logger: JobsLogger | undefined;
}) => CloudflareAdapter;

const defaultAdapterConstructor: CloudflareAdapterConstructor = ({
  apiToken,
  accountId,
  rateBudget,
  logger,
}) =>
  createCloudflareAdapter({
    apiToken,
    ...(accountId !== undefined ? { accountId } : {}),
    rateBudget,
    ...(logger !== undefined ? { logger } : {}),
  });

export interface CreateCloudflareAdapterFactoryOptions {
  connections: ConnectionsService;
  connectionCredentials: ConnectionCredentialsService;
  logger?: JobsLogger;
  /**
   * Override the token-bucket defaults (tests, deliberately gentle
   * deployments, or an operator who wants to pool several connections onto
   * one Cloudflare account's real budget). An explicit value WINS over
   * {@link resolveRateBudget}.
   */
  rateBudget?: CloudflareRateBudgetConfig;
  /**
   * Read the budget from the registered `integration.cloudflare.rate_budget`
   * setting at adapter-build time. Consulted only when `rateBudget` is
   * absent; a failure falls back to the documented defaults rather than
   * taking the pipeline down.
   */
  resolveRateBudget?: () => Promise<CloudflareRateBudgetConfig>;
  /** Provider-client constructor seam (tests inject a fake adapter). */
  createAdapter?: CloudflareAdapterConstructor;
}

/**
 * Per-connection interval floor derived from a token bucket — see the module
 * doc for the formula and why the absolute floor (an hour) dominates it.
 */
export function cloudflareRateBudgetIntervalFloorSeconds(budget: {
  refillPerSecond: number;
}): number {
  return Math.max(
    CLOUDFLARE_ABSOLUTE_MIN_INTERVAL_SECONDS,
    Math.ceil(CLOUDFLARE_CALLS_PER_SYNC / budget.refillPerSecond),
  );
}

/**
 * Read the non-secret account id from `connections.config.cloudflare.accountId`.
 * Exported so a connection-management surface and this factory agree on its
 * shape in one place. `null` is a legitimate value (a zone-scoped token).
 */
export function readCloudflareAccountId(
  config: Record<string, unknown>,
): string | null {
  const block = config[CLOUDFLARE_CONNECTION_CONFIG_KEY];
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return null;
  }
  const accountId = (block as Record<string, unknown>)["accountId"];
  return typeof accountId === "string" && accountId !== "" ? accountId : null;
}

interface CacheEntry {
  adapter: CloudflareConnectionAdapter;
  /** Epoch ms the entry stops being reused. */
  expiresAtMs: number;
  /** The budget the entry was built with; a change forces a rebuild. */
  budgetConfig: CloudflareRateBudgetConfig;
}

/** Build the connection-scoped Cloudflare adapter factory. */
export function createCloudflareAdapterFactory(
  options: CreateCloudflareAdapterFactoryOptions,
): {
  getAdapterForConnection: CloudflareAdapterFactory;
  invalidate: (connectionId: string) => void;
  /** The interval floor implied by the configured budget (all connections). */
  intervalFloorSeconds: number;
} {
  const { connections, connectionCredentials, logger } = options;
  const constructAdapter = options.createAdapter ?? defaultAdapterConstructor;
  const staticBudgetConfig = options.rateBudget ?? {
    capacity: CLOUDFLARE_RATE_BUDGET_CAPACITY,
    refillPerSecond: CLOUDFLARE_RATE_BUDGET_REFILL_PER_SECOND,
  };
  const intervalFloorSeconds =
    cloudflareRateBudgetIntervalFloorSeconds(staticBudgetConfig);

  // Budgets outlive adapters on purpose: rebuilding an adapter after a TTL
  // expiry or a credential rotation must not hand Cloudflare a fresh full
  // bucket. See woo.ts's identical discipline.
  const budgets = new Map<
    string,
    { budget: RateBudget; config: CloudflareRateBudgetConfig }
  >();
  const cache = new Map<string, CacheEntry>();
  // One in-flight build per connection: concurrent callers must not each run
  // the credential-decryption path.
  const inFlight = new Map<string, Promise<CloudflareConnectionAdapter>>();

  async function resolveBudgetConfig(): Promise<CloudflareRateBudgetConfig> {
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
        "failed to read the Cloudflare rate-budget setting; using the documented defaults",
      );
      return staticBudgetConfig;
    }
  }

  function budgetFor(
    connectionId: string,
    config: CloudflareRateBudgetConfig,
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
        "Cloudflare rate budget reconfigured; replacing the connection's token bucket",
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
    budgetConfig: CloudflareRateBudgetConfig,
  ): Promise<CloudflareConnectionAdapter> {
    const connection = await connections.getConnection(connectionId);
    if (connection.provider !== CLOUDFLARE_CONNECTION_PROVIDER) {
      throw new CloudflareCredentialsMissingError(
        `connection ${connectionId} has provider "${connection.provider}"; the Cloudflare pipeline needs a "${CLOUDFLARE_CONNECTION_PROVIDER}" connection`,
      );
    }
    const accountId = readCloudflareAccountId(connection.config);

    let payload: { apiToken: string };
    try {
      const credential = await connectionCredentials.getCredentialPayload(
        connectionId,
        CLOUDFLARE_CREDENTIAL_TYPE,
      );
      payload = credential.payload;
    } catch (error) {
      if (!(error instanceof SecretNotFoundError)) throw error;
      throw new CloudflareCredentialsMissingError(
        `connection ${connectionId} has no stored "${CLOUDFLARE_CREDENTIAL_TYPE}" credential; add a scoped Cloudflare API token before reconciling DNS`,
        { cause: error },
      );
    }

    const budget = budgetFor(connectionId, budgetConfig);
    const adapter = constructAdapter({
      apiToken: payload.apiToken,
      accountId: accountId ?? undefined,
      rateBudget: budget,
      logger,
    });

    const resolved: CloudflareConnectionAdapter = {
      connectionId,
      accountId,
      sourceAccountKey: adapter.sourceAccountKey,
      adapter,
      minIntervalSeconds: cloudflareRateBudgetIntervalFloorSeconds(budgetConfig),
    };
    cache.set(connectionId, {
      adapter: resolved,
      expiresAtMs: Date.now() + CLOUDFLARE_ADAPTER_CACHE_TTL_MS,
      budgetConfig,
    });
    return resolved;
  }

  async function getAdapterForConnection(
    connectionId: string,
  ): Promise<CloudflareConnectionAdapter> {
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
