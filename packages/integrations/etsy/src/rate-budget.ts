/**
 * API rate budget (loxep-g4t.1): a token bucket every Etsy API call must
 * acquire from before hitting the network.
 *
 * ## THIS BUDGET IS SHARED PER APPLICATION, NOT PER CONNECTION — the load-
 * bearing divergence from `@loxep/integration-ebay`/`-woo`
 *
 * Per the binding design (`etsy-integration-design.md`, "Rate limits" and
 * "Rate budget — the one place NOT to copy eBay's wiring verbatim"): Etsy's
 * limit is application-based, enforced per API key (10,000 queries/24h and
 * 10 queries/second by default, evaluated QPS-first-then-QPD on a rolling
 * window) — the OPPOSITE of eBay's per-connection budget. One Loxep
 * installation holds exactly one Etsy application (one keystring/shared-
 * secret pair), so every Etsy connection the installation has must draw from
 * the SAME budget instance, not one bucket per connection.
 *
 * This module only implements the token-bucket ALGORITHM — identical to
 * `@loxep/integration-ebay`'s `createRateBudget` (duplicated, not imported;
 * integration packages must not depend on each other, ADR-0009). The
 * SHARED-vs-per-connection decision is a COMPOSITION decision and lives one
 * layer up, in `packages/app/src/etsy.ts`: that module must construct
 * exactly ONE `RateBudget` via `createRateBudget()` here and hand the SAME
 * instance to every connection's adapter, the same way
 * `packages/app/src/ebay.ts` deliberately builds ONE budget PER CONNECTION.
 * A copy-paste of eBay's per-connection wiring pattern here would silently
 * multiply the app's real Etsy quota by the number of connected shops and
 * get rate-limited in a way that looks like a bug in the budget rather than
 * a wiring mistake — this is flagged as the single highest-risk mistake in
 * the design document.
 *
 * Semantics (identical to the eBay/Invoice Ninja adapters' buckets):
 * - The bucket starts full (`capacity` tokens) and refills continuously at
 *   `refillPerSecond`, capped at `capacity`.
 * - `acquire(cost)` resolves immediately when tokens are available;
 *   otherwise it reserves the deficit (tokens go negative) and waits for the
 *   refill to cover it. Reservation order is call order, so concurrent
 *   waiters resolve approximately FIFO.
 * - When the required wait would exceed `maxWaitMs` (default 30s,
 *   overridable per call), `acquire` throws an `EtsyAdapterError` of kind
 *   `rate_limited` with `detail.source = "local_rate_budget"` and consumes
 *   nothing.
 * - `tryAcquire(cost)` never waits; `stats()` exposes remaining budget for
 *   integration-health surfaces.
 *
 * LIMITATION (documented on purpose, same as eBay's): this budget is
 * in-memory and per-process. That matches the Phase 1 single-worker default
 * (`LOXEP_MODE=worker`, one process polls providers). If multiple workers
 * ever poll Etsy concurrently, the budget must move to shared state (e.g.
 * PostgreSQL-backed accounting) or be divided across processes — revisit
 * before enabling multi-worker polling, exactly as eBay's module doc notes.
 */
import { EtsyAdapterError } from "./errors.ts";

export interface EtsyAdapterLogger {
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
  logger?: EtsyAdapterLogger;
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
    throw new EtsyAdapterError(
      "invalid_request",
      "rate budget capacity must be a positive number",
    );
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new EtsyAdapterError(
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
      throw new EtsyAdapterError(
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
          "Etsy rate budget exhausted; rejecting acquisition",
        );
        throw new EtsyAdapterError(
          "rate_limited",
          "local Etsy rate budget exhausted",
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
