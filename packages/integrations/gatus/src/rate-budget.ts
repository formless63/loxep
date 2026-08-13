/**
 * Per-connection API rate budget for the Gatus boundary: a token bucket
 * every request must acquire from before touching the network.
 *
 * A LOCAL copy of the eBay/WooCommerce/Cloudflare/Purelymail/Beszel budget
 * shape rather than an import — integration packages must not depend on each
 * other (ADR-0009 boundaries are per provider).
 *
 * ## What Gatus publishes about rate limits, verified 2026-08-13
 *
 * **Nothing.** `api/api.go`'s `createRouter` registers exactly two
 * middlewares on the whole app — `recover.New()` and `compress.New()` — and
 * no request-limiter of any kind. There is no documented 429, no throttling
 * header, and no per-route limit anywhere in `api/*.go`. So, as with Beszel,
 * the ceiling here is a promise about Loxep's own politeness toward a
 * process the operator is also using interactively (its own status-page UI),
 * not a guess at a provider limit that does not exist.
 *
 * The OIDC-degraded path costs MORE calls per poll than the direct path —
 * two unauthenticated reads (uptime + response-time) PER KNOWN ENDPOINT KEY,
 * instead of one bulk `endpoints/statuses` call — so the same conservative
 * default that serves Beszel's few-calls-per-poll shape here as well: a
 * sustained {@link GATUS_SUGGESTED_REFILL_PER_SECOND} with a burst of
 * {@link GATUS_SUGGESTED_CAPACITY} covers a config probe plus either a bulk
 * statuses read or a modest per-endpoint fleet without ever being the reason
 * an operator's own status page feels slow.
 *
 * If a 429 ever appears (from a reverse proxy in front of Gatus, since Gatus
 * itself never emits one), the adapter surfaces it as `rate_limited` with
 * `detail.source = "provider"` rather than mutating this bucket from a
 * header describing a limit it does not own.
 *
 * LIMITATION (documented on purpose): this budget is in-memory and
 * per-process, matching the single-worker default. If multiple workers ever
 * drive the same Gatus instance, the budget must move to shared state or the
 * per-process budgets must be divided.
 */
import { GatusAdapterError } from "./errors.ts";

export interface GatusAdapterLogger {
  debug?: (fields: Record<string, unknown>, message?: string) => void;
  info?: (fields: Record<string, unknown>, message?: string) => void;
  warn?: (fields: Record<string, unknown>, message?: string) => void;
  error?: (fields: Record<string, unknown>, message?: string) => void;
}

export interface RateBudgetStats {
  capacity: number;
  refillPerSecond: number;
  /** Tokens available right now (0 when waiters have reserved ahead). */
  available: number;
  /** Acquisitions currently waiting on refill. */
  pending: number;
  /** Total successful acquisitions since creation. */
  acquired: number;
  /** Total acquisitions rejected as rate_limited since creation. */
  rejected: number;
}

export interface RateBudget {
  acquire(cost?: number, options?: { maxWaitMs?: number }): Promise<void>;
  tryAcquire(cost?: number): boolean;
  stats(): RateBudgetStats;
}

export interface CreateRateBudgetOptions {
  capacity: number;
  refillPerSecond: number;
  /** Default bound on how long one acquire may wait. Default 30 000 ms. */
  maxWaitMs?: number;
  logger?: GatusAdapterLogger;
}

const DEFAULT_MAX_WAIT_MS = 30_000;

/** See the module doc for why "no documented limit" argues for a small number. */
export const GATUS_SUGGESTED_CAPACITY = 10;
export const GATUS_SUGGESTED_REFILL_PER_SECOND = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRateBudget(options: CreateRateBudgetOptions): RateBudget {
  const { capacity, refillPerSecond, logger } = options;
  const defaultMaxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new GatusAdapterError(
      "invalid_request",
      "rate budget capacity must be a positive number",
    );
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new GatusAdapterError(
      "invalid_request",
      "rate budget refillPerSecond must be a positive number",
    );
  }

  let tokens = capacity;
  let lastRefillAt = Date.now();
  let pending = 0;
  let acquired = 0;
  let rejected = 0;

  const refill = (): void => {
    const now = Date.now();
    const elapsedMs = now - lastRefillAt;
    if (elapsedMs > 0) {
      tokens = Math.min(capacity, tokens + (elapsedMs / 1000) * refillPerSecond);
      lastRefillAt = now;
    }
  };

  const assertCost = (cost: number): void => {
    if (!Number.isFinite(cost) || cost <= 0 || cost > capacity) {
      throw new GatusAdapterError(
        "invalid_request",
        "rate budget cost must be a positive number no greater than capacity",
        { cost, capacity },
      );
    }
  };

  return {
    async acquire(cost = 1, acquireOptions) {
      assertCost(cost);
      refill();
      if (tokens >= cost) {
        tokens -= cost;
        acquired += 1;
        return;
      }
      const requiredWaitMs = ((cost - tokens) / refillPerSecond) * 1000;
      const maxWaitMs = acquireOptions?.maxWaitMs ?? defaultMaxWaitMs;
      if (requiredWaitMs > maxWaitMs) {
        rejected += 1;
        logger?.warn?.(
          { requiredWaitMs: Math.ceil(requiredWaitMs), maxWaitMs },
          "Gatus rate budget exhausted; rejecting acquisition",
        );
        throw new GatusAdapterError(
          "rate_limited",
          "local Gatus rate budget exhausted",
          {
            source: "local_rate_budget",
            requiredWaitMs: Math.ceil(requiredWaitMs),
            maxWaitMs,
          },
        );
      }
      tokens -= cost;
      pending += 1;
      try {
        await sleep(requiredWaitMs);
      } finally {
        pending -= 1;
      }
      acquired += 1;
    },

    tryAcquire(cost = 1) {
      assertCost(cost);
      refill();
      if (tokens >= cost) {
        tokens -= cost;
        acquired += 1;
        return true;
      }
      return false;
    },

    stats() {
      refill();
      return {
        capacity,
        refillPerSecond,
        available: Math.max(0, tokens),
        pending,
        acquired,
        rejected,
      };
    },
  };
}
