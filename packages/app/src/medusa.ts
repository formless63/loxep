/**
 * Medusa adapter factory for the worker pipeline (loxep-xxz).
 *
 * The Medusa sibling of `woo.ts`/`reverb.ts`: one place resolves everything a
 * live order sync needs and hands back a ready-to-use, per-connection
 * adapter.
 *
 * ```text
 * connections.config.medusa.baseUrl        (non-secret backend URL)  ─┐
 * per-connection rate budget (token bucket)                           ├─→ MedusaAdapter
 * connection credential 'medusa_credentials' (apiToken, ADR-0019)    ─┘
 * ```
 *
 * ## Where each half of the configuration lives, and why
 *
 * `packages/integrations/medusa/src/connection.ts` decided this contract
 * before any of it was wired, and this module implements it unchanged:
 *
 * ```text
 * provider           'medusa'
 * credential_type    'medusa_credentials'   ADR-0019 bundle: { apiToken }
 * connections.config  medusa: { baseUrl }   NON-secret; a backend's admin
 *                                           URL is public, same reasoning as
 *                                           WooCommerce's `baseUrl`
 * ```
 *
 * `connections.config.medusa.baseUrl` is already written by `apps/web`'s
 * `createStoreConnection` (`admin-functions.ts`) — this module is a READER of
 * that contract, not a new one. The split is deliberate, for the identical
 * three reasons `woo_credentials` excludes `baseUrl`: it must stay readable
 * without a decryption round-trip (to render the connection, run a health
 * check, and compute `source_account_key`); ADR-0019 bundles exist so a
 * credential cannot be half-configured, and a URL is not part of that atom;
 * and it is not confidential — a backend's admin URL is not, on its own, a
 * secret.
 *
 * Unlike WooCommerce's two-field key pair, the encrypted bundle here is
 * **exactly one field** — Medusa authenticates with a single secret API key
 * rather than a key/secret pair (`packages/integrations/medusa/src/config.ts`).
 *
 * ## Rate budget and the derived interval floor
 *
 * Each connection gets ONE {@link RateBudget}, created once per connection and
 * REUSED across adapter rebuilds — the woo.ts/reverb.ts rule: a rebuilt
 * adapter must never hand the backend a fresh full bucket. The defaults
 * (capacity 5, refill 2/s) match the adapter's OWN conservative default in
 * `packages/integrations/medusa/src/adapter.ts`, so a connection with no
 * override behaves the same whether or not this factory intervenes.
 *
 * **`resolveRateBudget` is deliberately omitted** — there is no registered
 * `integration.medusa.rate_budget` setting, matching the documented gap
 * `cloudflare.ts`/`purelymail.ts`/`reverb.ts` already carry (`services.ts`),
 * not `woo.ts`'s registered-setting shape. An explicit `rateBudget` override
 * is the only way to raise it today.
 *
 * From the budget comes the per-connection **interval floor** the adaptive
 * scheduler must never poll below, using WooCommerce's own formula:
 *
 * ```text
 * floorSeconds = max(
 *   MEDUSA_ABSOLUTE_MIN_INTERVAL_SECONDS,                // politeness
 *   ceil(MEDUSA_PAGES_PER_SYNC / refillPerSecond)        // budget share
 * )
 * ```
 *
 * {@link MEDUSA_ABSOLUTE_MIN_INTERVAL_SECONDS} is 300 s — WooCommerce's own
 * precedent, not eBay's 30 s — because the thing on the other end is a
 * self-hosted backend, not a marketplace API built for polling: an order that
 * arrived four minutes ago is not more useful for having been fetched four
 * minutes ago.
 *
 * ## Caching
 *
 * The built adapter is cached per connection for
 * {@link MEDUSA_ADAPTER_CACHE_TTL_MS}, and — like WooCommerce — the cache is a
 * convenience rather than a correctness mechanism: there is no token to
 * refresh, so a rebuild costs one connection read plus one credential
 * decryption. The per-connection budget lives OUTSIDE the cache and survives
 * every rebuild. {@link invalidate} drops an entry immediately (used after an
 * `auth`-class provider failure, so a re-keyed connection recovers on the
 * next poll rather than after the cache TTL).
 *
 * ABSOLUTE RULE honored here: the secret API key is never logged, put in an
 * error message, or returned to a caller. The adapter keeps it in a closure
 * and exposes only `baseUrl`, `sourceAccountKey`, and budget statistics.
 */
import type { ConnectionCredentialsService, ConnectionsService } from "@loxep/domain";
import { SecretNotFoundError } from "@loxep/domain";
import type { JobsLogger } from "@loxep/jobs";
import { DEFAULT_SYNC_MAX_PAGES } from "@loxep/commerce";
import {
  createMedusaAdapter,
  createRateBudget,
} from "@loxep/integration-medusa";
import type { MedusaAdapter, RateBudget } from "@loxep/integration-medusa";
import { AppConfigurationError } from "./errors.ts";

/** `connections.provider` value the Medusa pipeline accepts. */
export const MEDUSA_CONNECTION_PROVIDER = "medusa";
/** Registered credential purpose holding the backend's secret API key. */
export const MEDUSA_CREDENTIAL_TYPE = "medusa_credentials";
/** Non-secret block on `connections.config` holding the backend's base URL. */
export const MEDUSA_CONNECTION_CONFIG_KEY = "medusa";

/**
 * Per-connection token-bucket defaults — matching the adapter's OWN
 * conservative default (`adapter.ts`'s `DEFAULT_BUDGET`), not WooCommerce's.
 */
export const MEDUSA_RATE_BUDGET_CAPACITY = 5;
export const MEDUSA_RATE_BUDGET_REFILL_PER_SECOND = 2;
/** Requests one full sync walk may spend; Commerce's own page budget. */
export const MEDUSA_PAGES_PER_SYNC = DEFAULT_SYNC_MAX_PAGES;
/** Politeness floor for polling a self-hosted backend: five minutes. */
export const MEDUSA_ABSOLUTE_MIN_INTERVAL_SECONDS = 300;
/** How long a built adapter is reused before it is rebuilt from storage. */
export const MEDUSA_ADAPTER_CACHE_TTL_MS = 300_000;

/** The backend's secret API key is missing, or its connection is misconfigured. */
export class MedusaCredentialsMissingError extends AppConfigurationError {}

/** Token-bucket parameters: burst size and sustained calls per second. */
export interface MedusaRateBudgetConfig {
  capacity: number;
  refillPerSecond: number;
}

/** The per-connection handle the commerce sync executor works with. */
export interface MedusaConnectionAdapter {
  connectionId: string;
  /** The normalized backend root URL (non-secret). */
  baseUrl: string;
  /** `medusa:<baseUrl>` — the commerce design's `source_account_key`. */
  sourceAccountKey: string;
  /** The read-only Admin API adapter. */
  adapter: MedusaAdapter;
  /** The per-connection rate-budget floor, in whole seconds. */
  minIntervalSeconds: number;
}

export interface MedusaAdapterFactory {
  (connectionId: string): Promise<MedusaConnectionAdapter>;
}

/** How a provider client is constructed from resolved config + budget. */
export type MedusaAdapterConstructor = (input: {
  baseUrl: string;
  apiToken: string;
  rateBudget: RateBudget;
  logger: JobsLogger | undefined;
}) => MedusaAdapter;

const defaultAdapterConstructor: MedusaAdapterConstructor = ({
  baseUrl,
  apiToken,
  rateBudget,
  logger,
}) =>
  createMedusaAdapter({
    baseUrl,
    apiToken,
    rateBudget,
    ...(logger !== undefined ? { logger } : {}),
  });

export interface CreateMedusaAdapterFactoryOptions {
  connections: ConnectionsService;
  connectionCredentials: ConnectionCredentialsService;
  logger?: JobsLogger;
  /**
   * Override the token-bucket defaults (tests, deliberately gentle
   * deployments). There is no `resolveRateBudget` seam here — see the module
   * doc for why Medusa follows Cloudflare/Purelymail/Reverb rather than
   * WooCommerce.
   */
  rateBudget?: MedusaRateBudgetConfig;
  /** Provider-client constructor seam (tests inject a fake adapter). */
  createAdapter?: MedusaAdapterConstructor;
}

/**
 * Per-connection interval floor derived from a token bucket — see the module
 * doc for the formula. Exported so tests and documentation share one source.
 */
export function medusaRateBudgetIntervalFloorSeconds(budget: {
  refillPerSecond: number;
}): number {
  return Math.max(
    MEDUSA_ABSOLUTE_MIN_INTERVAL_SECONDS,
    Math.ceil(MEDUSA_PAGES_PER_SYNC / budget.refillPerSecond),
  );
}

/**
 * Read the non-secret backend URL from `connections.config.medusa.baseUrl`.
 * Exported because the same block is what `apps/web`'s `createStoreConnection`
 * already writes — this is a reader of that contract, not a new one.
 */
export function readMedusaBaseUrl(
  config: Record<string, unknown>,
): string | null {
  const block = config[MEDUSA_CONNECTION_CONFIG_KEY];
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return null;
  }
  const baseUrl = (block as Record<string, unknown>)["baseUrl"];
  return typeof baseUrl === "string" && baseUrl !== "" ? baseUrl : null;
}

interface CacheEntry {
  adapter: MedusaConnectionAdapter;
  /** Epoch ms the entry stops being reused. */
  expiresAtMs: number;
}

/**
 * Build the connection-scoped Medusa adapter factory.
 */
export function createMedusaAdapterFactory(
  options: CreateMedusaAdapterFactoryOptions,
): {
  getAdapterForConnection: MedusaAdapterFactory;
  invalidate: (connectionId: string) => void;
  /** The interval floor implied by the configured budget (all connections). */
  intervalFloorSeconds: number;
} {
  const { connections, connectionCredentials, logger } = options;
  const constructAdapter = options.createAdapter ?? defaultAdapterConstructor;
  const budgetConfig = options.rateBudget ?? {
    capacity: MEDUSA_RATE_BUDGET_CAPACITY,
    refillPerSecond: MEDUSA_RATE_BUDGET_REFILL_PER_SECOND,
  };
  const intervalFloorSeconds = medusaRateBudgetIntervalFloorSeconds(budgetConfig);

  // Budgets outlive adapters on purpose: rebuilding an adapter after a TTL
  // expiry or a credential rotation must not hand the backend a fresh full
  // bucket.
  const budgets = new Map<string, RateBudget>();
  const cache = new Map<string, CacheEntry>();
  // One in-flight build per connection: concurrent callers must not each run
  // the credential-decryption path.
  const inFlight = new Map<string, Promise<MedusaConnectionAdapter>>();

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

  async function build(connectionId: string): Promise<MedusaConnectionAdapter> {
    const connection = await connections.getConnection(connectionId);
    if (connection.provider !== MEDUSA_CONNECTION_PROVIDER) {
      throw new MedusaCredentialsMissingError(
        `connection ${connectionId} has provider "${connection.provider}"; the Medusa pipeline needs a "${MEDUSA_CONNECTION_PROVIDER}" connection`,
      );
    }
    const baseUrl = readMedusaBaseUrl(connection.config);
    if (baseUrl === null) {
      throw new MedusaCredentialsMissingError(
        `connection ${connectionId} has no backend URL; set config.${MEDUSA_CONNECTION_CONFIG_KEY}.baseUrl (the non-secret half of a Medusa connection)`,
      );
    }

    let payload: { apiToken: string };
    try {
      const credential = await connectionCredentials.getCredentialPayload(
        connectionId,
        MEDUSA_CREDENTIAL_TYPE,
      );
      payload = credential.payload;
    } catch (error) {
      if (!(error instanceof SecretNotFoundError)) throw error;
      throw new MedusaCredentialsMissingError(
        `connection ${connectionId} has no stored "${MEDUSA_CREDENTIAL_TYPE}" credential; add the backend's secret API key before polling order targets`,
        { cause: error },
      );
    }

    const budget = budgetFor(connectionId);
    const adapter = constructAdapter({
      baseUrl,
      apiToken: payload.apiToken,
      rateBudget: budget,
      logger,
    });

    const resolved: MedusaConnectionAdapter = {
      connectionId,
      baseUrl: adapter.baseUrl,
      sourceAccountKey: adapter.sourceAccountKey,
      adapter,
      minIntervalSeconds: intervalFloorSeconds,
    };
    cache.set(connectionId, {
      adapter: resolved,
      expiresAtMs: Date.now() + MEDUSA_ADAPTER_CACHE_TTL_MS,
    });
    return resolved;
  }

  async function getAdapterForConnection(
    connectionId: string,
  ): Promise<MedusaConnectionAdapter> {
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
