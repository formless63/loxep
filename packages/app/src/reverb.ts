/**
 * Reverb adapter factory for the worker pipeline (loxep-g4t.3).
 *
 * Structurally the SIMPLEST provider factory in this package — closer to
 * `purelymail.ts` than to `woo.ts`/`etsy.ts`: a static, non-OAuth credential
 * (a Personal Access Token that never expires) and **no non-secret half at
 * all**.
 *
 * ```text
 * per-connection rate budget (token bucket)                          ─┐
 * connection credential 'reverb_credentials' (personalAccessToken,   ─┴─→ ReverbAdapter
 *   ADR-0019)
 * ```
 *
 * ## Why there is no `config.reverb` block
 *
 * Every other factory here reads at least one non-secret fact from
 * `connections.config`: Woo's `baseUrl`, Etsy's shop id, Cloudflare's
 * optional account id. **Reverb has neither a per-deployment host (one
 * fixed hosted API, `REVERB_API_BASE_URL`) nor an operator-entered shop
 * identifier** — m1's `reverb_shop` target always means "the connection's
 * own account" (see `@loxep/integration-reverb/connection.ts`). So there is
 * nothing to read and `connections.config` stays empty for this provider,
 * exactly like `purelymail.ts`.
 *
 * One consequence is worth stating rather than discovering, mirroring
 * Purelymail's own documented one: `sourceAccountKey` is derived from the
 * LOXEP CONNECTION ID (`reverbSourceAccountKey`), not a Reverb-reported
 * account fact — Reverb exposes no account identifier without spending a
 * live `/my/account` call. Two connections holding the same underlying
 * Reverb account's PAT are not detected as duplicates by this key.
 *
 * ## Rate budget — PER CONNECTION, the eBay/Woo pattern, NOT Etsy's shared one
 *
 * Restated from `@loxep/integration-reverb/rate-budget.ts`'s module doc:
 * Reverb has no shared installation-wide credential the way Etsy's single
 * developer-portal app forces pooling — every connection's PAT is minted
 * independently, from a DIFFERENT Reverb account's own settings. This
 * factory therefore builds ONE `RateBudget` PER CONNECTION (a
 * `Map<connectionId, RateBudget>`), exactly like `woo.ts`/`ebay.ts`, never a
 * single shared instance the way `etsy.ts` deliberately is. The token-bucket
 * defaults (capacity 5, refill 1/s) are a documented conservative GUESS —
 * Reverb publishes no numeric rate limit — not a verified number; there is
 * no registered `integration.reverb.rate_budget` setting yet (matching
 * Cloudflare's/Purelymail's own "no resolver wired yet" gap), so an
 * explicit `rateBudget` override is the only way to raise it today.
 *
 * ## Caching
 *
 * The built adapter is cached per connection for
 * {@link REVERB_ADAPTER_CACHE_TTL_MS}, mirroring `purelymail.ts`/`woo.ts`
 * exactly: there is no token to refresh (Reverb PATs do not expire), so a
 * rebuild costs one connection read plus one credential decryption, and the
 * short TTL is what makes an operator's token rotation take effect without
 * a restart. The per-connection budget lives OUTSIDE the cache and survives
 * every rebuild — a rebuilt adapter must never hand Reverb a fresh full
 * bucket.
 *
 * ABSOLUTE RULE honored here: the Personal Access Token is never logged, put
 * in an error message, or returned to a caller. The adapter keeps it in a
 * closure and exposes only `sourceAccountKey` and budget statistics.
 */
import type { ConnectionCredentialsService, ConnectionsService } from "@loxep/domain";
import { SecretNotFoundError } from "@loxep/domain";
import type { JobsLogger } from "@loxep/jobs";
// See the WIRING CAVEAT in `etsy.ts`'s module doc for the same pattern: this
// package's manifest is outside this change's write fence, so the sibling
// package is reached through a workspace-relative import rather than the
// `@loxep/integration-reverb` package-name specifier. One-line follow-up
// once the dependency is declared.
import {
  createRateBudget,
  createReverbAdapter,
  reverbSourceAccountKey,
} from "../../integrations/reverb/src/index.ts";
import type {
  RateBudget,
  ReverbAdapter,
} from "../../integrations/reverb/src/index.ts";
import { AppConfigurationError } from "./errors.ts";

/** `connections.provider` value the Reverb pipeline accepts. */
export const REVERB_CONNECTION_PROVIDER = "reverb";
/** Registered credential purpose holding the Personal Access Token (ADR-0019). */
export const REVERB_CREDENTIAL_TYPE = "reverb_credentials";

/** Per-connection token-bucket defaults — a documented GUESS, see the module doc. */
export const REVERB_RATE_BUDGET_CAPACITY = 5;
export const REVERB_RATE_BUDGET_REFILL_PER_SECOND = 1;
/** Politeness floor; matches Woo's own undocumented-limit default reasoning. */
export const REVERB_ABSOLUTE_MIN_INTERVAL_SECONDS = 60;
/** How long a built adapter is reused before it is rebuilt from storage. */
export const REVERB_ADAPTER_CACHE_TTL_MS = 300_000;

/** The Reverb connection's Personal Access Token is missing or unusable. */
export class ReverbCredentialsMissingError extends AppConfigurationError {}

/** Token-bucket parameters: burst size and sustained calls per second. */
export interface ReverbRateBudgetConfig {
  capacity: number;
  refillPerSecond: number;
}

/** The per-connection handle the poll executor works with. */
export interface ReverbConnectionAdapter {
  connectionId: string;
  /** `reverb:<connectionId>` — NOT unique across two tokens, see the module doc. */
  sourceAccountKey: string;
  adapter: ReverbAdapter;
  /** The per-connection rate-budget floor, in whole seconds. */
  minIntervalSeconds: number;
}

export interface ReverbAdapterFactory {
  (connectionId: string): Promise<ReverbConnectionAdapter>;
}

/** How a provider client is constructed from a resolved token + budget. */
export type ReverbAdapterConstructor = (input: {
  personalAccessToken: string;
  rateBudget: RateBudget;
  logger: JobsLogger | undefined;
}) => ReverbAdapter;

const defaultAdapterConstructor: ReverbAdapterConstructor = ({
  personalAccessToken,
  rateBudget,
  logger,
}) =>
  createReverbAdapter({
    personalAccessToken,
    rateBudget,
    ...(logger !== undefined ? { logger } : {}),
  });

export interface CreateReverbAdapterFactoryOptions {
  connections: ConnectionsService;
  connectionCredentials: ConnectionCredentialsService;
  logger?: JobsLogger;
  /** Override the token-bucket defaults (tests, deliberately gentle deployments). */
  rateBudget?: ReverbRateBudgetConfig;
  /** Provider-client constructor seam (tests inject a fake adapter). */
  createAdapter?: ReverbAdapterConstructor;
}

/** Per-connection interval floor derived from a token bucket. */
export function reverbRateBudgetIntervalFloorSeconds(budget: {
  refillPerSecond: number;
}): number {
  return Math.max(
    REVERB_ABSOLUTE_MIN_INTERVAL_SECONDS,
    Math.ceil(1 / budget.refillPerSecond),
  );
}

interface CacheEntry {
  adapter: ReverbConnectionAdapter;
  expiresAtMs: number;
  budgetConfig: ReverbRateBudgetConfig;
}

/** Build the connection-scoped Reverb adapter factory. */
export function createReverbAdapterFactory(
  options: CreateReverbAdapterFactoryOptions,
): {
  getAdapterForConnection: ReverbAdapterFactory;
  invalidate: (connectionId: string) => void;
  intervalFloorSeconds: number;
} {
  const { connections, connectionCredentials, logger } = options;
  const constructAdapter = options.createAdapter ?? defaultAdapterConstructor;
  const budgetConfig = options.rateBudget ?? {
    capacity: REVERB_RATE_BUDGET_CAPACITY,
    refillPerSecond: REVERB_RATE_BUDGET_REFILL_PER_SECOND,
  };
  const intervalFloorSeconds = reverbRateBudgetIntervalFloorSeconds(budgetConfig);

  // Budgets outlive adapters on purpose: rebuilding after a TTL expiry or a
  // credential rotation must not hand Reverb a fresh full bucket.
  const budgets = new Map<string, RateBudget>();
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<ReverbConnectionAdapter>>();

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

  async function build(connectionId: string): Promise<ReverbConnectionAdapter> {
    const connection = await connections.getConnection(connectionId);
    if (connection.provider !== REVERB_CONNECTION_PROVIDER) {
      throw new ReverbCredentialsMissingError(
        `connection ${connectionId} has provider "${connection.provider}"; the Reverb pipeline needs a "${REVERB_CONNECTION_PROVIDER}" connection`,
      );
    }

    let payload: { personalAccessToken: string };
    try {
      const credential = await connectionCredentials.getCredentialPayload(
        connectionId,
        REVERB_CREDENTIAL_TYPE,
      );
      payload = credential.payload;
    } catch (error) {
      if (!(error instanceof SecretNotFoundError)) throw error;
      throw new ReverbCredentialsMissingError(
        `connection ${connectionId} has no stored "${REVERB_CREDENTIAL_TYPE}" credential; add a Reverb Personal Access Token before polling`,
        { cause: error },
      );
    }

    const adapter = constructAdapter({
      personalAccessToken: payload.personalAccessToken,
      rateBudget: budgetFor(connectionId),
      logger,
    });

    const resolved: ReverbConnectionAdapter = {
      connectionId,
      sourceAccountKey: reverbSourceAccountKey(connectionId),
      adapter,
      minIntervalSeconds: intervalFloorSeconds,
    };
    cache.set(connectionId, {
      adapter: resolved,
      expiresAtMs: Date.now() + REVERB_ADAPTER_CACHE_TTL_MS,
      budgetConfig,
    });
    return resolved;
  }

  async function getAdapterForConnection(
    connectionId: string,
  ): Promise<ReverbConnectionAdapter> {
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
