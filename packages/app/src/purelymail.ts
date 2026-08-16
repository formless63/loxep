/**
 * Purelymail adapter factory for the worker pipeline (Phase 7 milestone 2
 * composition-root wiring, loxep-lmy.2).
 *
 * The mail sibling of `cloudflare.ts`, and structurally the simplest factory in
 * this package: a static, non-OAuth credential and **no non-secret half at
 * all**.
 *
 * ```text
 * per-connection rate budget (token bucket)                              ─┐
 * connection credential 'purelymail_credentials' (apiToken, ADR-0019)    ─┴─→ PurelymailAdapter
 * ```
 *
 * ## Why there is no `config.purelymail` block
 *
 * Every other factory here reads one non-secret fact from `connections.config`:
 * Woo's `baseUrl`, Etsy's application identity, Cloudflare's optional
 * `accountId`. **Purelymail exposes no account identifier whatsoever** — the
 * token is the account, and no endpoint in its API takes or returns an account
 * id. So there is nothing to read, `readCloudflareAccountId` has no counterpart,
 * and `connections.config` stays empty for this provider.
 *
 * One consequence is worth stating rather than discovering: `sourceAccountKey`
 * is derived from the base URL alone, so two Purelymail connections holding two
 * different tokens produce the SAME key. The connection id remains the only
 * discriminator between them, and nothing may treat that key as unique.
 *
 * ## Rate budget — per CONNECTION, and deliberately small
 *
 * Purelymail publishes **no API rate limit at all** (verified 2026-08-13
 * against its OpenAPI document and its documentation; the only documented
 * limits are on account actions such as sending external mail). An undocumented
 * limit is one nobody can design against, so the default here is smaller than
 * Cloudflare's, not larger: a burst of six and one request per second
 * sustained, against a workflow whose entire per-domain cost is roughly five
 * calls once, plus two cheap reads per bounded poll.
 *
 * ## The interval floor is an HOUR, matching Cloudflare's, and for a stronger reason
 *
 * The thing a mail poll is waiting for is **nameserver delegation performed by
 * a human at a registrar**, which the design describes as taking anywhere from
 * minutes to days. Polling that faster than hourly cannot make it happen
 * sooner. {@link PURELYMAIL_ABSOLUTE_MIN_INTERVAL_SECONDS} encodes the same
 * politeness floor `cloudflare.ts` uses, for a case where it is even less
 * arguable.
 *
 * ## Caching
 *
 * The built adapter is cached per connection for
 * {@link PURELYMAIL_ADAPTER_CACHE_TTL_MS}, mirroring `cloudflare.ts` and
 * `woo.ts` exactly: no token to refresh, so a rebuild costs one connection read
 * plus one credential decryption, and the short TTL is what makes an operator's
 * token rotation take effect without a restart. The per-connection budget lives
 * OUTSIDE the cache and survives every rebuild — a rebuilt adapter must never
 * hand the provider a fresh full bucket.
 *
 * ABSOLUTE RULE honored here: the API token is never logged, put in an error
 * message, or returned to a caller. The adapter keeps it in a closure and
 * exposes only `baseUrl`, `sourceAccountKey`, and budget statistics.
 */
import type {
  ConnectionCredentialsService,
  ConnectionsService,
} from "@loxep/domain";
import { SecretNotFoundError } from "@loxep/domain";
import type { JobsLogger } from "@loxep/jobs";
import {
  createPurelymailAdapter,
  createRateBudget,
  PURELYMAIL_LIST_USER_LIMIT,
} from "@loxep/integration-purelymail";
import type {
  PurelymailAdapter,
  RateBudget,
} from "@loxep/integration-purelymail";

/**
 * The provider's own hard cap on `listUsers()` — re-exported (never
 * redefined) so a caller states the SAME number the adapter enforces,
 * without importing `@loxep/integration-purelymail` directly (provider SDK
 * shapes stop at the integration boundary — the estate browser's Mailboxes
 * section, loxep-47o.3, is this constant's first `apps/web` consumer).
 */
export { PURELYMAIL_LIST_USER_LIMIT };
import { AppConfigurationError } from "./errors.ts";

/** `connections.provider` value the Purelymail/mail pipeline accepts. */
export const PURELYMAIL_CONNECTION_PROVIDER = "purelymail";
/** Registered credential purpose holding the API token (ADR-0019). */
export const PURELYMAIL_CREDENTIAL_TYPE = "purelymail_credentials";

/** Per-connection token-bucket defaults (see the module doc). */
export const PURELYMAIL_RATE_BUDGET_CAPACITY = 6;
export const PURELYMAIL_RATE_BUDGET_REFILL_PER_SECOND = 1;
/**
 * Provider calls one mail-domain poll spends: `listDomains` once, plus at most
 * one `updateDomainSettings` recheck.
 */
export const PURELYMAIL_CALLS_PER_SYNC = 2;
/** Politeness floor for a bounded mail poll: one hour (see the module doc). */
export const PURELYMAIL_ABSOLUTE_MIN_INTERVAL_SECONDS = 3600;
/** How long a built adapter is reused before it is rebuilt from storage. */
export const PURELYMAIL_ADAPTER_CACHE_TTL_MS = 300_000;

/** The Purelymail API token is missing, or its connection is misconfigured. */
export class PurelymailCredentialsMissingError extends AppConfigurationError {}

/** Token-bucket parameters: burst size and sustained calls per second. */
export interface PurelymailRateBudgetConfig {
  capacity: number;
  refillPerSecond: number;
}

/** The per-connection handle the mail reconciler works with. */
export interface PurelymailConnectionAdapter {
  connectionId: string;
  /** `purelymail:<host>`. NOT unique across two tokens — see the module doc. */
  sourceAccountKey: string;
  adapter: PurelymailAdapter;
  /** The per-connection rate-budget floor, in whole seconds. */
  minIntervalSeconds: number;
}

export interface PurelymailAdapterFactory {
  (connectionId: string): Promise<PurelymailConnectionAdapter>;
}

/** How a provider client is constructed from a resolved token + budget. */
export type PurelymailAdapterConstructor = (input: {
  apiToken: string;
  rateBudget: RateBudget;
  logger: JobsLogger | undefined;
}) => PurelymailAdapter;

const defaultAdapterConstructor: PurelymailAdapterConstructor = ({
  apiToken,
  rateBudget,
  logger,
}) =>
  createPurelymailAdapter({
    apiToken,
    rateBudget,
    ...(logger !== undefined ? { logger } : {}),
  });

export interface CreatePurelymailAdapterFactoryOptions {
  connections: ConnectionsService;
  connectionCredentials: ConnectionCredentialsService;
  logger?: JobsLogger;
  /** Override the token-bucket defaults (tests, gentle deployments). */
  rateBudget?: PurelymailRateBudgetConfig;
  /** Provider-client constructor seam (tests inject a fake adapter). */
  createAdapter?: PurelymailAdapterConstructor;
}

/** Per-connection interval floor derived from a token bucket. */
export function purelymailRateBudgetIntervalFloorSeconds(budget: {
  refillPerSecond: number;
}): number {
  return Math.max(
    PURELYMAIL_ABSOLUTE_MIN_INTERVAL_SECONDS,
    Math.ceil(PURELYMAIL_CALLS_PER_SYNC / budget.refillPerSecond),
  );
}

interface CacheEntry {
  adapter: PurelymailConnectionAdapter;
  expiresAtMs: number;
  budgetConfig: PurelymailRateBudgetConfig;
}

/** Build the connection-scoped Purelymail adapter factory. */
export function createPurelymailAdapterFactory(
  options: CreatePurelymailAdapterFactoryOptions,
): {
  getAdapterForConnection: PurelymailAdapterFactory;
  invalidate: (connectionId: string) => void;
  intervalFloorSeconds: number;
} {
  const { connections, connectionCredentials, logger } = options;
  const constructAdapter = options.createAdapter ?? defaultAdapterConstructor;
  const budgetConfig = options.rateBudget ?? {
    capacity: PURELYMAIL_RATE_BUDGET_CAPACITY,
    refillPerSecond: PURELYMAIL_RATE_BUDGET_REFILL_PER_SECOND,
  };
  const intervalFloorSeconds =
    purelymailRateBudgetIntervalFloorSeconds(budgetConfig);

  // Budgets outlive adapters on purpose: rebuilding after a TTL expiry or a
  // credential rotation must not hand the provider a fresh full bucket.
  const budgets = new Map<string, RateBudget>();
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<PurelymailConnectionAdapter>>();

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

  async function build(
    connectionId: string,
  ): Promise<PurelymailConnectionAdapter> {
    const connection = await connections.getConnection(connectionId);
    if (connection.provider !== PURELYMAIL_CONNECTION_PROVIDER) {
      throw new PurelymailCredentialsMissingError(
        `connection ${connectionId} has provider "${connection.provider}"; the mail pipeline needs a "${PURELYMAIL_CONNECTION_PROVIDER}" connection`,
      );
    }

    let payload: { apiToken: string };
    try {
      const credential = await connectionCredentials.getCredentialPayload(
        connectionId,
        PURELYMAIL_CREDENTIAL_TYPE,
      );
      payload = credential.payload;
    } catch (error) {
      if (!(error instanceof SecretNotFoundError)) throw error;
      throw new PurelymailCredentialsMissingError(
        `connection ${connectionId} has no stored "${PURELYMAIL_CREDENTIAL_TYPE}" credential; add a Purelymail API token before reconciling mail`,
        { cause: error },
      );
    }

    const adapter = constructAdapter({
      apiToken: payload.apiToken,
      rateBudget: budgetFor(connectionId),
      logger,
    });

    const resolved: PurelymailConnectionAdapter = {
      connectionId,
      sourceAccountKey: adapter.sourceAccountKey,
      adapter,
      minIntervalSeconds: intervalFloorSeconds,
    };
    cache.set(connectionId, {
      adapter: resolved,
      expiresAtMs: Date.now() + PURELYMAIL_ADAPTER_CACHE_TTL_MS,
      budgetConfig,
    });
    return resolved;
  }

  async function getAdapterForConnection(
    connectionId: string,
  ): Promise<PurelymailConnectionAdapter> {
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
