/**
 * Per-connection API rate budget for the Medusa boundary: a token bucket
 * every request must acquire from before hitting the network.
 *
 * This is deliberately a LOCAL copy of the eBay/WooCommerce adapters' budget
 * shape rather than an import. Integration packages must not depend on each
 * other (ADR-0009 boundaries are per provider), and the alternative — a
 * shared `@loxep/integration-core` — would couple every provider's release
 * to one package. The type surface is intentionally identical so a caller
 * can hold all three behind one structural interface if it wants to.
 *
 * Semantics:
 * - the bucket starts full (`capacity` tokens) and refills continuously at
 *   `refillPerSecond`, capped at `capacity`;
 * - `acquire(cost)` resolves immediately when tokens are available; otherwise
 *   it reserves the deficit (tokens go negative) and waits for the refill to
 *   cover it. Reservation order is call order, so concurrent waiters resolve
 *   approximately FIFO;
 * - when the required wait would exceed `maxWaitMs` (default 30s, overridable
 *   per call), `acquire` throws a `MedusaAdapterError` of kind `rate_limited`
 *   with `detail.source = "local_rate_budget"` and consumes nothing;
 * - `tryAcquire(cost)` never waits; `stats()` exposes remaining budget for
 *   integration-health surfaces.
 *
 * WHY A BUDGET AT ALL FOR MEDUSA: no documented Admin API rate limit was
 * found (fixtures-only research; no live instance exists here — see the
 * module doc). A self-hosted Medusa deployment is, like a self-hosted
 * WooCommerce store, one backend process an unthrottled backfill can
 * meaningfully load. The default is deliberately conservative for the same
 * reason the WooCommerce adapter's is.
 *
 * LIMITATION (documented on purpose): this budget is in-memory and
 * per-process, matching the single-worker default. If multiple workers ever
 * poll the same connection, the budget must move to shared state or the
 * per-process budgets must be divided.
 */
import { MedusaAdapterError } from "./errors.ts";

export interface MedusaAdapterLogger {
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
  logger?: MedusaAdapterLogger;
}

const DEFAULT_MAX_WAIT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRateBudget(
  options: CreateRateBudgetOptions,
): RateBudget {
  const { capacity, refillPerSecond, logger } = options;
  const defaultMaxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new MedusaAdapterError(
      "invalid_request",
      "rate budget capacity must be a positive number",
    );
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new MedusaAdapterError(
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
      throw new MedusaAdapterError(
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
          "Medusa rate budget exhausted; rejecting acquisition",
        );
        throw new MedusaAdapterError(
          "rate_limited",
          "local Medusa rate budget exhausted",
          {
            source: "local_rate_budget",
            requiredWaitMs: Math.ceil(requiredWaitMs),
            maxWaitMs,
          },
        );
      }
      // Reserve now (FIFO by call order), then wait for refill to cover it.
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
