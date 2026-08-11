/**
 * Per-connection API rate budget (loxep-62y.1.5): a token bucket every
 * eBay API call must acquire from before hitting the network.
 *
 * Semantics:
 * - The bucket starts full (`capacity` tokens) and refills continuously at
 *   `refillPerSecond`, capped at `capacity`.
 * - `acquire(cost)` resolves immediately when tokens are available;
 *   otherwise it reserves the deficit (tokens go negative) and waits for the
 *   refill to cover it. Reservation order is call order, so concurrent
 *   waiters resolve approximately FIFO.
 * - When the required wait would exceed `maxWaitMs` (default 30s, overridable
 *   per call), `acquire` throws an `EbayAdapterError` of kind `rate_limited`
 *   with `detail.source = "local_rate_budget"` and consumes nothing.
 * - `tryAcquire(cost)` never waits; `stats()` exposes remaining budget for
 *   integration-health surfaces.
 *
 * LIMITATION (documented on purpose): this budget is in-memory and
 * per-process. That matches the Phase 1 single-worker default
 * (`LOXEP_MODE=worker`, one process polls eBay). If multiple workers ever
 * poll the same connection, the budget must move to shared state (e.g.
 * PostgreSQL-backed accounting) or the per-process budgets must be divided —
 * revisit before enabling multi-worker polling.
 */
import { EbayAdapterError } from "./errors.ts";

export interface EbayAdapterLogger {
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
  logger?: EbayAdapterLogger;
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
    throw new EbayAdapterError(
      "invalid_request",
      "rate budget capacity must be a positive number",
    );
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new EbayAdapterError(
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
      throw new EbayAdapterError(
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
          "eBay rate budget exhausted; rejecting acquisition",
        );
        throw new EbayAdapterError(
          "rate_limited",
          "local eBay rate budget exhausted",
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
